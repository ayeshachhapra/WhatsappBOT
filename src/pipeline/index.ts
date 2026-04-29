import { extractMessage } from "../ai/extract";
import { generateEmbedding } from "../ai/embed";
import { ocrImage } from "../ai/vision";
import {
  getMessagesCollection,
  getTrackedGroups,
  getAlertRulesCollection,
  getAlertTriggersCollection,
  getPurchaseOrdersCollection,
  getAgentSettings,
  getAgentActionsCollection,
} from "../db/mongo";
import {
  MessageDocument,
  PurchaseOrderStatus,
  AgentActionDocument,
} from "../db/schema";
import { decideAgentAction } from "../ai/agent";
import { whatsapp } from "../whatsapp/manager";
import createLogger from "../utils/logger";

const log = createLogger("Pipeline");

export interface IncomingMessage {
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  fromMe: boolean;
  body: string;
  messageType: string;
  timestamp: Date;
  /** If the message had image media, the bytes + mime — pipeline will OCR them. */
  imageBytes?: Buffer;
  imageMimeType?: string;
}

export interface PipelineResult {
  stored: boolean;
  msgId: string;
  reason?: string;
}

const MAX_QUEUE_SIZE = 500;

interface QueueItem {
  msg: IncomingMessage;
  resolve: (r: PipelineResult) => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}

const queue: QueueItem[] = [];
let draining = false;

export function queueMessage(msg: IncomingMessage): Promise<PipelineResult> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    log.warn(`[QUEUE] FULL (${queue.length}/${MAX_QUEUE_SIZE}) — rejecting`);
    return Promise.resolve({ stored: false, msgId: msg.msgId, reason: "queue_full" });
  }
  return new Promise((resolve, reject) => {
    queue.push({ msg, resolve, reject, enqueuedAt: Date.now() });
    log.info(`[QUEUE] ${queue.length}/${MAX_QUEUE_SIZE} pending — "${msg.groupName}"`);
    drainQueue();
  });
}

export function getQueueDepth(): number {
  return queue.length;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      const result = await processMessage(item.msg);
      item.resolve(result);
    } catch (err: any) {
      item.reject(err);
    }
  }
  draining = false;
}

async function processMessage(msg: IncomingMessage): Promise<PipelineResult> {
  const start = Date.now();
  const collection = getMessagesCollection();

  const tracked = await getTrackedGroups();
  if (!tracked.some((g) => g.jid === msg.groupJid)) {
    return { stored: false, msgId: msg.msgId, reason: "not_tracked" };
  }

  const existing = await collection.findOne({ msgId: msg.msgId });
  if (existing) {
    return { stored: false, msgId: msg.msgId, reason: "duplicate" };
  }

  // ── If image present, run OCR first to fill body ──
  let body = msg.body;
  let bodySource: "text" | "ocr" = "text";
  if (msg.imageBytes && msg.imageMimeType) {
    log.info(`[OCR] Running on image (${msg.imageBytes.length} bytes, ${msg.imageMimeType})`);
    const result = await ocrImage(msg.imageBytes, msg.imageMimeType, msg.body);
    if (result.text && result.text.trim()) {
      body = msg.body
        ? `[caption] ${msg.body}\n[image OCR] ${result.text}`
        : result.text;
      bodySource = "ocr";
    }
  }

  if (!body || !body.trim()) {
    return { stored: false, msgId: msg.msgId, reason: "empty_after_ocr" };
  }

  const baseDoc: MessageDocument = {
    msgId: msg.msgId,
    groupJid: msg.groupJid,
    groupName: msg.groupName,
    sender: msg.sender,
    senderJid: msg.senderJid,
    fromMe: !!msg.fromMe,
    body,
    messageType: msg.messageType,
    bodySource,
    timestamp: msg.timestamp,
    topic: null,
    summary: null,
    entities: [],
    actionItems: [],
    sentiment: null,
    referenceNumbers: [],
    dueDate: null,
    embedding: null,
    extractedAt: null,
    createdAt: new Date(),
  };

  try {
    await collection.insertOne(baseDoc);
  } catch (err: any) {
    if (err.code === 11000) {
      return { stored: false, msgId: msg.msgId, reason: "duplicate" };
    }
    throw err;
  }

  // ── Extraction ──
  let extracted;
  try {
    extracted = await extractMessage({
      groupName: msg.groupName,
      sender: msg.sender,
      body,
      messageTimestamp: msg.timestamp.toISOString(),
    });
  } catch (err: any) {
    log.warn(`[extract] failed for ${msg.msgId}: ${err.message}`);
    extracted = {
      topic: null,
      summary: null,
      entities: [],
      actionItems: [],
      sentiment: null,
      referenceNumbers: [],
      dueDate: null,
    };
  }

  // ── Embedding ──
  const embedInput = extracted.summary || body;
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(embedInput);
  } catch (err: any) {
    log.warn(`[embed] failed for ${msg.msgId}: ${err.message}`);
  }

  // ── Conversational ref inheritance ──
  // When a supplier replies to a clarifying question (e.g. "what's causing
  // the delay?") with just an answer ("customs hold at Nhava Sheva"), the
  // reply has no PO reference of its own. Without this step, the message
  // would skip PO enrichment AND the agent would lose conversational context.
  // We inherit refs from the most recent agent ask_clarifying action in the
  // same group, within a short stickiness window.
  let effectiveRefs = extracted.referenceNumbers || [];
  let inheritedFromMsgId: string | null = null;
  if (effectiveRefs.length === 0 && !msg.fromMe) {
    const inherited = await inheritRefsFromRecentAsk(msg.groupJid);
    if (inherited && inherited.refs.length > 0) {
      effectiveRefs = inherited.refs;
      inheritedFromMsgId = inherited.fromAgentActionId;
      log.info(
        `[inherit] msg ${msg.msgId} inherits refs ${inherited.refs.join(",")} from prior agent ask`
      );
    }
  }

  await collection.updateOne(
    { msgId: msg.msgId },
    {
      $set: {
        topic: extracted.topic,
        summary: extracted.summary,
        entities: extracted.entities,
        actionItems: extracted.actionItems,
        sentiment: extracted.sentiment,
        referenceNumbers: effectiveRefs,
        dueDate: extracted.dueDate,
        embedding,
        extractedAt: new Date(),
        ...(inheritedFromMsgId
          ? {
              referenceSource: "inherited" as const,
              inheritedFromAgentActionId: inheritedFromMsgId,
            }
          : {}),
      },
    }
  );

  // ── Alert-rule evaluation ──
  await evaluateAlertRules({
    msgId: msg.msgId,
    groupJid: msg.groupJid,
    groupName: msg.groupName,
    sender: msg.sender,
    senderJid: msg.senderJid,
    body,
    topic: extracted.topic,
    summary: extracted.summary,
  });

  // ── Purchase-order enrichment ──
  await updatePurchaseOrdersFromMessage({
    msgId: msg.msgId,
    fromMe: !!msg.fromMe,
    body,
    referenceNumbers: effectiveRefs,
    dueDate: extracted.dueDate,
    timestamp: msg.timestamp,
  });

  // ── Autonomous agent ──
  // Runs after enrichment so the agent sees fresh PO state. Strict guardrails
  // applied inside; exceptions are swallowed so they never break ingestion.
  await maybeRunAgent({
    msgId: msg.msgId,
    fromMe: !!msg.fromMe,
    groupJid: msg.groupJid,
    groupName: msg.groupName,
    senderName: msg.sender,
    senderJid: msg.senderJid,
    body,
    referenceNumbers: effectiveRefs,
    sentiment: extracted.sentiment,
    timestamp: msg.timestamp,
    refsWereInherited: !!inheritedFromMsgId,
  });

  log.info(
    `[done] ${msg.msgId} stored+enriched in ${Date.now() - start}ms (topic="${extracted.topic}")`
  );
  return { stored: true, msgId: msg.msgId };
}

async function evaluateAlertRules(input: {
  msgId: string;
  groupJid: string;
  groupName: string;
  sender: string;
  senderJid: string;
  body: string;
  topic: string | null;
  summary: string | null;
}): Promise<void> {
  try {
    const rules = await getAlertRulesCollection().find({ enabled: true }).toArray();
    if (rules.length === 0) return;

    const haystack = [
      input.body,
      input.topic || "",
      input.summary || "",
    ]
      .join(" ")
      .toLowerCase();

    const triggers = getAlertTriggersCollection();
    for (const rule of rules) {
      // Group scope
      if (
        Array.isArray(rule.groupJids) &&
        rule.groupJids.length > 0 &&
        !rule.groupJids.includes(input.groupJid)
      ) {
        continue;
      }
      const matched = (rule.keywords || [])
        .map((k) => k.toLowerCase())
        .filter((k) => k && haystack.includes(k));
      if (matched.length === 0) continue;

      await triggers.insertOne({
        ruleId: rule._id!,
        ruleName: rule.name,
        matchedKeywords: matched,
        msgId: input.msgId,
        groupJid: input.groupJid,
        groupName: input.groupName,
        sender: input.sender,
        senderJid: input.senderJid,
        body: input.body.slice(0, 1000),
        topic: input.topic,
        triggeredAt: new Date(),
        acknowledged: false,
        acknowledgedAt: null,
      });
      log.info(
        `[alert] Rule "${rule.name}" matched on ${input.msgId} (keywords: ${matched.join(", ")})`
      );
    }
  } catch (err: any) {
    log.warn(`Alert rule evaluation failed: ${err.message}`);
  }
}

const PO_RESOLVED_RE = /\b(delivered|received|completed|done|pod|signed|closed)\b/i;
const PO_DISPATCHED_RE =
  /\b(dispatch|dispatched|shipped|out for delivery|in transit|picked up|left)\b/i;
const PO_DELAYED_RE = /\b(delay|delayed|late|hold|stuck|pending)\b/i;

function inferPoStatusFromBody(
  body: string,
  current: PurchaseOrderStatus
): PurchaseOrderStatus {
  if (PO_RESOLVED_RE.test(body)) return "delivered";
  if (PO_DISPATCHED_RE.test(body)) return "in_transit";
  if (PO_DELAYED_RE.test(body)) return "delayed";
  // Don't downgrade from in_transit → ordered just because the message has no
  // status verb; only update when we can actually infer something.
  return current;
}

/**
 * Apply a freshly-stored message to the purchase-order master table:
 *  - Match each `referenceNumbers` token against `poNumber` (case-insensitive).
 *  - Re-infer status from the body (delivered/in_transit/delayed).
 *  - Pull a fresher `eta` if the message carries a `dueDate`.
 *  - Flip `awaitingReply` based on direction:
 *      fromMe = true  → we just chased; supplier hasn't replied yet.
 *      fromMe = false → supplier responded; clear the awaiting flag.
 */
async function updatePurchaseOrdersFromMessage(input: {
  msgId: string;
  fromMe: boolean;
  body: string;
  referenceNumbers: string[];
  dueDate: Date | string | null | undefined;
  timestamp: Date;
}): Promise<void> {
  if (!input.referenceNumbers || input.referenceNumbers.length === 0) return;
  try {
    const collection = getPurchaseOrdersCollection();
    // Case-insensitive match on poNumber for each ref the message carries.
    const refs = input.referenceNumbers.map((r) => r.trim()).filter(Boolean);
    if (refs.length === 0) return;
    const matches = await collection
      .find({
        $or: refs.map((r) => ({
          poNumber: { $regex: `^${escapeRegex(r)}$`, $options: "i" },
        })),
      })
      .toArray();
    if (matches.length === 0) return;

    const newDueDate = input.dueDate ? new Date(input.dueDate) : null;
    const now = new Date();
    for (const po of matches) {
      const newStatus = inferPoStatusFromBody(input.body, po.status);
      const set: Record<string, unknown> = {
        lastUpdateMsgId: input.msgId,
        lastUpdateAt: input.timestamp,
        updatedAt: now,
        // fromMe = our follow-up went out → still waiting for a reply
        // !fromMe = supplier (or anyone else) sent the message → reply received
        awaitingReply: !!input.fromMe,
      };
      if (newStatus !== po.status) set.status = newStatus;
      if (newDueDate) set.eta = newDueDate;

      await collection.updateOne({ _id: po._id }, { $set: set });
      log.info(
        `[po] ${po.poNumber} updated from msg ${input.msgId} — status=${
          newStatus
        }${newDueDate ? `, eta=${newDueDate.toISOString().slice(0, 10)}` : ""}, awaitingReply=${set.awaitingReply}`
      );
    }
  } catch (err: any) {
    log.warn(`Purchase-order update failed: ${err.message}`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AgentTriggerInput {
  msgId: string;
  fromMe: boolean;
  groupJid: string;
  groupName: string;
  senderName: string;
  senderJid: string;
  body: string;
  referenceNumbers: string[];
  sentiment: string | null;
  timestamp: Date;
  /** True when refs were inherited from a prior agent ask_clarifying — the
   *  message body itself didn't mention them. Lets the agent log this clearly
   *  in its reasoning ("inherited refs from prior question"). */
  refsWereInherited?: boolean;
}

/**
 * Decide and (optionally) execute an agent action for a freshly stored
 * inbound message. The function never throws — agent failures must not
 * block message ingestion. Every consideration is logged to `agentActions`,
 * including the no-op cases, so the activity feed shows what the agent saw
 * even when it chose to stay quiet.
 */
async function maybeRunAgent(input: AgentTriggerInput): Promise<void> {
  try {
    // Hard guardrail #1: never react to our own outbound messages — would loop.
    if (input.fromMe) return;

    const settings = await getAgentSettings();
    if (!settings.enabled) return;

    // Hard guardrail #2: agent only operates in groups it's been allowlisted
    // for. The allowlist is the user's explicit opt-in, separate from the
    // tracked-groups list (so they can track without auto-replying).
    if (!settings.allowedGroupJids.includes(input.groupJid)) return;

    // Hard guardrail #3: skip messages without enough signal to act on. Pure
    // chitchat with no PO refs and short bodies deserves silence — UNLESS the
    // refs were inherited from a recent clarifying question, in which case we
    // know the message is conversationally relevant even if it's brief.
    if (
      input.referenceNumbers.length === 0 &&
      input.body.trim().length < 12 &&
      !input.refsWereInherited
    ) {
      return;
    }

    // Pull PO context for any ref the inbound mentions.
    const poContext = await loadPoContext(input.referenceNumbers);

    // Pull recent group history for context (last 8 messages) and the agent's
    // own recent decisions in this group (last 5) — the latter is what lets the
    // model recognise "the supplier just answered our question, close the loop".
    const [recentHistory, recentAgentActions] = await Promise.all([
      getMessagesCollection()
        .find(
          { groupJid: input.groupJid, msgId: { $ne: input.msgId } },
          { projection: { embedding: 0 } }
        )
        .sort({ timestamp: -1 })
        .limit(8)
        .toArray(),
      getAgentActionsCollection()
        .find({ groupJid: input.groupJid })
        .sort({ consideredAt: -1 })
        .limit(5)
        .toArray(),
    ]);

    const decision = await decideAgentAction({
      body: input.body,
      groupName: input.groupName,
      senderName: input.senderName,
      referenceNumbers: input.referenceNumbers,
      refsWereInherited: !!input.refsWereInherited,
      sentiment: input.sentiment,
      poContext: poContext.map((p) => ({
        poNumber: p.poNumber,
        productName: p.productName,
        companyName: p.companyName,
        eta: p.eta ? p.eta.toISOString().slice(0, 10) : null,
        status: p.status,
        awaitingReply: !!p.awaitingReply,
      })),
      recentHistory: recentHistory
        .reverse()
        .map((m) => ({
          timestamp: new Date(m.timestamp).toISOString().slice(0, 16),
          sender: m.sender,
          fromMe: !!m.fromMe,
          body: m.body || "",
        })),
      recentAgentActions: recentAgentActions
        .reverse()
        .map((a) => ({
          consideredAt: new Date(a.consideredAt).toISOString().slice(0, 16),
          decision: a.decision,
          inboundBody: a.inboundBody || "",
          outboundText: a.outboundText,
        })),
    });

    // Attempt to send only when the decision wants an outbound message.
    let sent = false;
    let skipReason: string | null = null;
    let mentionJid: string | null = null;
    let mentionName: string | null = null;
    let error: string | null = null;

    const wantsToSend =
      (decision.action === "ask_clarifying" ||
        decision.action === "acknowledge") &&
      !!decision.message;

    if (wantsToSend) {
      // Re-check guardrails right before send. The LLM is irrelevant to JID
      // routing — we use the inbound's groupJid, period.
      if (settings.mode === "observe") {
        skipReason = "settings.mode=observe";
      } else if (!settings.allowedGroupJids.includes(input.groupJid)) {
        // Defence in depth: re-check (settings could change mid-flight).
        skipReason = "group not in allowlist";
      } else {
        const capCheck = await checkRateLimits(input.groupJid, settings);
        if (capCheck) {
          skipReason = capCheck;
        } else {
          const firstName = input.senderName
            ? input.senderName.split(/\s+/)[0]
            : null;
          const mention =
            input.senderJid && input.senderJid.includes("@")
              ? { jid: input.senderJid, name: firstName || undefined }
              : null;

          const result = await whatsapp.sendTextMessage(
            input.groupJid,
            decision.message!,
            mention ? [mention] : undefined
          );
          if (result.success) {
            sent = true;
            mentionJid = mention?.jid || null;
            mentionName = mention?.name || null;
          } else {
            skipReason = "send failed";
            error = result.error || null;
          }
        }
      }
    }

    const actionDoc: AgentActionDocument = {
      consideredAt: new Date(),
      triggerMsgId: input.msgId,
      groupJid: input.groupJid,
      groupName: input.groupName,
      senderName: input.senderName,
      senderJid: input.senderJid,
      inboundBody: input.body.slice(0, 600),
      decision: decision.action,
      reasoning: decision.reasoning,
      outboundText: wantsToSend ? decision.message : null,
      sent,
      skipReason,
      referenceNumbers: input.referenceNumbers,
      mentionJid,
      mentionName,
      error,
    };
    await getAgentActionsCollection().insertOne(actionDoc);

    log.info(
      `[agent] ${input.msgId} → ${decision.action}${
        sent ? " (sent)" : skipReason ? ` (skipped: ${skipReason})` : ""
      }`
    );
  } catch (err: any) {
    log.warn(`[agent] failure: ${err.message}`);
  }
}

/**
 * If a freshly-stored inbound message has no PO refs, this helper checks the
 * most recent agent action in the same group and — if it was a clarifying
 * question that DID carry refs and was sent recently — returns those refs so
 * the inbound is treated as a continuation of that thread.
 *
 * Stickiness window: 30 minutes. Beyond that we assume the conversation has
 * naturally drifted and inheriting could mis-tag an unrelated reply.
 */
const REF_INHERIT_WINDOW_MS = 30 * 60 * 1000;

async function inheritRefsFromRecentAsk(
  groupJid: string
): Promise<{ refs: string[]; fromAgentActionId: string } | null> {
  const since = new Date(Date.now() - REF_INHERIT_WINDOW_MS);
  const last = await getAgentActionsCollection().findOne(
    {
      groupJid,
      decision: "ask_clarifying",
      sent: true,
      consideredAt: { $gte: since },
      "referenceNumbers.0": { $exists: true },
    },
    { sort: { consideredAt: -1 } }
  );
  if (!last) return null;
  return {
    refs: last.referenceNumbers || [],
    fromAgentActionId: last._id ? last._id.toString() : "",
  };
}

async function loadPoContext(refs: string[]) {
  if (refs.length === 0) return [];
  const collection = getPurchaseOrdersCollection();
  const docs = await collection
    .find({
      $or: refs.map((r) => ({
        poNumber: { $regex: `^${escapeRegex(r)}$`, $options: "i" },
      })),
    })
    .toArray();
  return docs;
}

/**
 * Returns null if all rate limits pass; otherwise a string explaining which
 * limit was hit (used as `skipReason` on the activity log).
 */
async function checkRateLimits(
  groupJid: string,
  settings: { maxMessagesPerGroupPerHour: number; maxMessagesPerGroupPerDay: number; cooldownSeconds: number }
): Promise<string | null> {
  const collection = getAgentActionsCollection();
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const cooldownAgo = new Date(now - settings.cooldownSeconds * 1000);

  const [cooldownHit, hourCount, dayCount] = await Promise.all([
    collection.countDocuments({
      groupJid,
      sent: true,
      consideredAt: { $gte: cooldownAgo },
    }),
    collection.countDocuments({
      groupJid,
      sent: true,
      consideredAt: { $gte: hourAgo },
    }),
    collection.countDocuments({
      groupJid,
      sent: true,
      consideredAt: { $gte: dayAgo },
    }),
  ]);
  if (cooldownHit > 0) return `cooldown (${settings.cooldownSeconds}s)`;
  if (hourCount >= settings.maxMessagesPerGroupPerHour)
    return `hourly cap (${settings.maxMessagesPerGroupPerHour})`;
  if (dayCount >= settings.maxMessagesPerGroupPerDay)
    return `daily cap (${settings.maxMessagesPerGroupPerDay})`;
  return null;
}
