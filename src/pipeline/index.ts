import { extractMessage } from "../ai/extract";
import { generateEmbedding } from "../ai/embed";
import { ocrImage } from "../ai/vision";
import {
  getMessagesCollection,
  getTrackedGroups,
  getAlertRulesCollection,
  getAlertTriggersCollection,
  getPurchaseOrdersCollection,
} from "../db/mongo";
import { MessageDocument, PurchaseOrderStatus } from "../db/schema";
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

  await collection.updateOne(
    { msgId: msg.msgId },
    {
      $set: {
        topic: extracted.topic,
        summary: extracted.summary,
        entities: extracted.entities,
        actionItems: extracted.actionItems,
        sentiment: extracted.sentiment,
        referenceNumbers: extracted.referenceNumbers,
        dueDate: extracted.dueDate,
        embedding,
        extractedAt: new Date(),
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
    referenceNumbers: extracted.referenceNumbers || [],
    dueDate: extracted.dueDate,
    timestamp: msg.timestamp,
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
