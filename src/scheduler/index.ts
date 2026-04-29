import cron, { type ScheduledTask } from "node-cron";
import { ObjectId } from "mongodb";
import {
  getScheduledMessagesCollection,
  getSendLogCollection,
  getDraftsCollection,
  getMessagesCollection,
} from "../db/mongo";
import { whatsapp } from "../whatsapp/manager";
import { draftFollowUp } from "../ai/follow-up-drafter";
import { config } from "../config";
import {
  ScheduledMessageDocument,
  SendLogDocument,
  DraftDocument,
  DraftMeta,
  GroupRef,
  MentionRef,
} from "../db/schema";
import createLogger from "../utils/logger";

const log = createLogger("Scheduler");

let cronTask: ScheduledTask | null = null;
let checkInProgress = false;

export function startScheduler(): void {
  if (cronTask) {
    log.warn("Scheduler already running");
    return;
  }
  log.info(`Starting scheduler (every minute, tz=${config.timezone})`);
  cronTask = cron.schedule(
    "* * * * *",
    async () => {
      await checkAndRunSchedules();
    },
    { timezone: config.timezone }
  );
}

export function stopScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log.info("Scheduler stopped");
  }
}

async function checkAndRunSchedules(): Promise<void> {
  if (checkInProgress) return;
  checkInProgress = true;
  try {
    await doCheck();
  } finally {
    checkInProgress = false;
  }
}

function nowParts(): { time: string; day: number; date: Date } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")!.value;
  const minute = parts.find((p) => p.type === "minute")!.value;
  const time = `${hour}:${minute}`;
  const dateInTz = new Date(
    now.toLocaleString("en-US", { timeZone: config.timezone })
  );
  return { time, day: dateInTz.getDay(), date: now };
}

function shouldRunNow(
  schedule: ScheduledMessageDocument,
  currentTime: string,
  currentDay: number
): boolean {
  if (!schedule.schedule.times.includes(currentTime)) return false;
  if (
    schedule.schedule.days.length > 0 &&
    !schedule.schedule.days.includes(currentDay)
  ) {
    return false;
  }
  return true;
}

async function shouldStopForResponse(
  schedule: ScheduledMessageDocument
): Promise<boolean> {
  if (!schedule.stopOnResponse) return false;
  const since = schedule.lastSentAt || schedule.createdAt;
  if (!since) return false;
  const groupJids = schedule.targetGroups.map((g) => g.jid);
  if (groupJids.length === 0) return false;
  const messages = getMessagesCollection();
  const found = await messages.findOne(
    { groupJid: { $in: groupJids }, timestamp: { $gt: since } },
    { projection: { _id: 1 } }
  );
  return !!found;
}

async function doCheck(): Promise<void> {
  const { time, day, date } = nowParts();
  const collection = getScheduledMessagesCollection();
  const enabled = await collection.find({ enabled: true }).toArray();

  for (const schedule of enabled) {
    if (!shouldRunNow(schedule, time, day)) continue;

    // Auto-stop if target groups have responded since last fire (auto-chase mode)
    if (await shouldStopForResponse(schedule)) {
      await collection.updateOne(
        { _id: schedule._id },
        {
          $set: {
            enabled: false,
            lastSendResult: "auto-stopped: response received",
          },
        }
      );
      log.info(
        `Schedule "${schedule.name}" auto-stopped — group responded since last fire`
      );
      continue;
    }

    // Atomic claim — prevents double-fire if scheduler ticks overlap
    const claim = await collection.updateOne(
      {
        _id: schedule._id,
        $or: [
          { lastSentAt: { $exists: false } },
          { lastSentAt: null },
          { lastSentAt: { $lt: new Date(date.getTime() - 59_000) } },
        ],
      },
      { $set: { lastSentAt: date } }
    );
    if (claim.modifiedCount === 0) {
      log.debug(`Schedule "${schedule.name}" already claimed this minute`);
      continue;
    }

    log.info(
      `Triggering "${schedule.name}" (mode=${schedule.mode}, autoSend=${schedule.autoSend}, ${schedule.targetGroups.length} groups)`
    );
    await runSchedule(schedule);
  }
}

async function resolveMessageText(
  schedule: ScheduledMessageDocument
): Promise<{ text: string | null; error: string | null }> {
  if (schedule.mode === "static") {
    if (!schedule.messageText || !schedule.messageText.trim()) {
      return { text: null, error: "static schedule has empty messageText" };
    }
    return { text: schedule.messageText, error: null };
  }
  // ai_draft
  try {
    const text = await draftFollowUp({
      scheduleName: schedule.name,
      aiPrompt: schedule.aiPrompt || "",
      targetGroups: schedule.targetGroups,
    });
    if (!text || !text.trim()) {
      return { text: null, error: "AI drafter returned empty text" };
    }
    return { text, error: null };
  } catch (err: any) {
    return { text: null, error: err.message };
  }
}

async function runSchedule(schedule: ScheduledMessageDocument): Promise<void> {
  const sched = getScheduledMessagesCollection();

  const { text, error: draftError } = await resolveMessageText(schedule);
  if (!text) {
    log.error(`Schedule "${schedule.name}" — couldn't produce text: ${draftError}`);
    await sched.updateOne(
      { _id: schedule._id },
      { $set: { lastSendResult: `failed: ${draftError}` } }
    );
    return;
  }

  if (schedule.autoSend) {
    await sendNow(schedule, text, null);
  } else {
    await createDraft(schedule, text);
  }
}

interface SendBatchInput {
  scheduleId: ObjectId | null;
  scheduleName: string;
  draftId: ObjectId | null;
  messageText: string;
  targetGroups: GroupRef[];
  mentions?: MentionRef[];
}

/** Build a mention list from either the new {jid,name} shape or the legacy bare JID array. */
function resolveMentions(
  mentions?: MentionRef[],
  mentionJids?: string[]
): MentionRef[] | undefined {
  if (mentions && mentions.length > 0) return mentions;
  if (mentionJids && mentionJids.length > 0) {
    return mentionJids.map((jid) => ({ jid }));
  }
  return undefined;
}

async function sendBatch(
  input: SendBatchInput
): Promise<{ success: boolean; errors: string[] }> {
  const sendLog = getSendLogCollection();
  const errors: string[] = [];
  let allSuccess = true;

  if (!whatsapp.isReady) {
    log.warn(`WhatsApp not ready — skipping send for "${input.scheduleName}"`);
    for (const group of input.targetGroups) {
      await sendLog.insertOne({
        scheduleId: input.scheduleId,
        scheduleName: input.scheduleName,
        draftId: input.draftId,
        messageText: input.messageText,
        targetGroup: group,
        status: "failed",
        error: "WhatsApp not connected",
        sentAt: new Date(),
      } as SendLogDocument);
    }
    return { success: false, errors: ["WhatsApp not connected"] };
  }

  for (let i = 0; i < input.targetGroups.length; i++) {
    const group = input.targetGroups[i];
    const result = await whatsapp.sendTextMessage(
      group.jid,
      input.messageText,
      input.mentions
    );

    await sendLog.insertOne({
      scheduleId: input.scheduleId,
      scheduleName: input.scheduleName,
      draftId: input.draftId,
      messageText: input.messageText,
      targetGroup: group,
      status: result.success ? "success" : "failed",
      error: result.error || null,
      sentAt: new Date(),
    } as SendLogDocument);

    if (!result.success) {
      allSuccess = false;
      errors.push(`${group.name}: ${result.error}`);
    }
    if (i < input.targetGroups.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { success: allSuccess, errors };
}

async function sendNow(
  schedule: ScheduledMessageDocument,
  messageText: string,
  draftId: ObjectId | null
): Promise<{ success: boolean; errors: string[] }> {
  const result = await sendBatch({
    scheduleId: schedule._id ?? null,
    scheduleName: schedule.name,
    draftId,
    messageText,
    targetGroups: schedule.targetGroups,
    mentions: resolveMentions(schedule.mentions, schedule.mentionJids),
  });

  await getScheduledMessagesCollection().updateOne(
    { _id: schedule._id },
    {
      $set: {
        lastSendResult: result.success
          ? "success"
          : `failure: ${result.errors.join("; ") || "unknown"}`,
      },
      $inc: { sendCount: result.success ? 1 : 0 },
    }
  );

  log.info(
    `Send "${schedule.name}" complete: ${result.success ? "all success" : result.errors.length + " failures"}`
  );
  return result;
}

async function createDraft(
  schedule: ScheduledMessageDocument,
  draftText: string
): Promise<void> {
  const drafts = getDraftsCollection();
  const result = await drafts.insertOne({
    scheduleId: schedule._id ?? null,
    scheduleName: schedule.name,
    draftText,
    targetGroups: schedule.targetGroups,
    status: "pending",
    source: "schedule",
    meta: null,
    createdAt: new Date(),
    decidedAt: null,
    sentAt: null,
    sendError: null,
  } as DraftDocument);
  log.info(`Created draft for "${schedule.name}" — id=${result.insertedId}`);
  await getScheduledMessagesCollection().updateOne(
    { _id: schedule._id },
    { $set: { lastSendResult: `draft created (id=${result.insertedId})` } }
  );
}

export async function createManualDraft(input: {
  draftText: string;
  targetGroups: GroupRef[];
  label?: string;
  meta?: DraftMeta;
  mentions?: MentionRef[];
  /** @deprecated use `mentions` */
  mentionJids?: string[];
}): Promise<{ id: string }> {
  if (!input.draftText || !input.draftText.trim()) {
    throw new Error("draftText is required");
  }
  if (!Array.isArray(input.targetGroups) || input.targetGroups.length === 0) {
    throw new Error("at least one target group is required");
  }
  const mentions = resolveMentions(input.mentions, input.mentionJids);
  const drafts = getDraftsCollection();
  const result = await drafts.insertOne({
    scheduleId: null,
    scheduleName: input.label || "Manual follow-up",
    draftText: input.draftText.trim(),
    targetGroups: input.targetGroups,
    mentions,
    status: "pending",
    source: "manual",
    meta: input.meta || null,
    createdAt: new Date(),
    decidedAt: null,
    sentAt: null,
    sendError: null,
  } as DraftDocument);
  log.info(`Created manual draft — id=${result.insertedId}`);
  return { id: result.insertedId.toString() };
}

export async function createAutoChaseSchedule(input: {
  name: string;
  messageText: string;
  targetGroups: GroupRef[];
  mentions?: MentionRef[];
  /** @deprecated use `mentions` */
  mentionJids?: string[];
  time: string; // HH:mm
  cadenceDays?: number; // 1 = daily; 2 = every 2 days, etc — currently informational only
  meta?: DraftMeta;
}): Promise<{ id: string }> {
  if (!input.messageText.trim()) throw new Error("messageText is required");
  if (input.targetGroups.length === 0) throw new Error("at least one group required");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    throw new Error("time must be HH:mm");
  }
  const collection = getScheduledMessagesCollection();
  const now = new Date();
  const mentions = resolveMentions(input.mentions, input.mentionJids);
  const doc: ScheduledMessageDocument = {
    name: input.name || "Auto-chase",
    mode: "static",
    messageText: input.messageText,
    aiPrompt: null,
    targetGroups: input.targetGroups,
    mentions,
    schedule: { times: [input.time], days: [] },
    enabled: true,
    autoSend: true,
    stopOnResponse: true,
    lastSentAt: null,
    lastSendResult: null,
    sendCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const result = await collection.insertOne(doc as any);
  log.info(`Auto-chase schedule created — id=${result.insertedId}`);
  return { id: result.insertedId.toString() };
}

export async function triggerScheduledMessage(
  id: string
): Promise<{ success: boolean; error?: string; draftId?: string }> {
  try {
    const collection = getScheduledMessagesCollection();
    const schedule = await collection.findOne({ _id: new ObjectId(id) });
    if (!schedule) return { success: false, error: "Schedule not found" };
    const { text, error } = await resolveMessageText(schedule);
    if (!text) return { success: false, error: error || "Failed to produce text" };
    if (schedule.autoSend) {
      const result = await sendNow(schedule, text, null);
      return { success: result.success, error: result.errors.join("; ") || undefined };
    } else {
      await createDraft(schedule, text);
      return { success: true };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function approveDraft(
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  const drafts = getDraftsCollection();
  const draft = await drafts.findOne({ _id: new ObjectId(draftId) });
  if (!draft) return { success: false, error: "Draft not found" };
  if (draft.status !== "pending") {
    return { success: false, error: `Draft already ${draft.status}` };
  }

  let result: { success: boolean; errors: string[] };

  const draftMentions = resolveMentions(draft.mentions, draft.mentionJids);

  if (draft.scheduleId) {
    const sched = await getScheduledMessagesCollection().findOne({
      _id: draft.scheduleId,
    });
    if (!sched) {
      // Schedule was deleted — fall through to manual send using the draft's own targets
      result = await sendBatch({
        scheduleId: null,
        scheduleName: draft.scheduleName,
        draftId: draft._id ?? null,
        messageText: draft.draftText,
        targetGroups: draft.targetGroups,
        mentions: draftMentions,
      });
    } else {
      result = await sendNow(sched, draft.draftText, draft._id ?? null);
    }
  } else {
    // Manual draft — send directly to its target groups
    result = await sendBatch({
      scheduleId: null,
      scheduleName: draft.scheduleName,
      draftId: draft._id ?? null,
      messageText: draft.draftText,
      targetGroups: draft.targetGroups,
      mentions: draftMentions,
    });
  }

  await drafts.updateOne(
    { _id: draft._id },
    {
      $set: {
        status: result.success ? "sent" : "approved",
        decidedAt: new Date(),
        sentAt: result.success ? new Date() : null,
        sendError: result.success ? null : result.errors.join("; "),
      },
    }
  );
  return { success: result.success, error: result.errors.join("; ") || undefined };
}

export async function rejectDraft(
  draftId: string
): Promise<{ success: boolean; error?: string }> {
  const drafts = getDraftsCollection();
  const result = await drafts.updateOne(
    { _id: new ObjectId(draftId), status: "pending" },
    { $set: { status: "rejected", decidedAt: new Date() } }
  );
  if (result.matchedCount === 0) {
    return { success: false, error: "Draft not found or not pending" };
  }
  return { success: true };
}

export function validateGroupRef(g: any): g is GroupRef {
  return (
    g && typeof g === "object" && typeof g.jid === "string" && typeof g.name === "string"
  );
}
