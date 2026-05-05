import { Router, type Request, type Response, type NextFunction } from "express";
import { ObjectId } from "mongodb";
import { config } from "../../config";
import {
  getEmailFollowUpsCollection,
  getProcessedInboundMessagesCollection,
  getSupplierRepliesCollection,
} from "../../db/mongo";
import { ReplyMatchMethod } from "../../db/schema";
import {
  extractEmailAddress,
  matchReplyToFollowUp,
} from "../../services/replyMatching";
import createLogger from "../../utils/logger";

const router = Router();
const log = createLogger("InboundEmail");

interface PostmarkAddress {
  Email?: string;
  Name?: string;
}

interface PostmarkHeader {
  Name?: string;
  Value?: string;
}

interface PostmarkInboundPayload {
  MessageID?: string;
  From?: string;
  FromFull?: PostmarkAddress;
  To?: string;
  ToFull?: PostmarkAddress[];
  Cc?: string;
  CcFull?: PostmarkAddress[];
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Headers?: PostmarkHeader[];
  Date?: string;
}

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedUser = config.emailFollowUps.webhookUser;
  const expectedPassword = config.emailFollowUps.webhookPassword;
  if (!expectedPassword) {
    log.error("INBOUND_WEBHOOK_PASSWORD is not set; rejecting request");
    res.status(500).json({ error: "Webhook auth misconfigured" });
    return;
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  if (user !== expectedUser || password !== expectedPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.post("/", basicAuth, async (req, res) => {
  const payload: PostmarkInboundPayload = req.body || {};
  const messageId = (payload.MessageID || "").trim();

  if (!messageId) {
    log.warn("Inbound payload missing MessageID — accepting and dropping (cannot dedupe)");
    return res.status(202).json({ ok: true, ignored: "missing MessageID" });
  }

  const processedCol = getProcessedInboundMessagesCollection();
  try {
    await processedCol.insertOne({ _id: messageId, processedAt: new Date() });
  } catch (err: any) {
    if (err.code === 11000) {
      log.info(`Duplicate inbound MessageID ${messageId} — already processed`);
      return res.json({ ok: true, duplicate: true });
    }
    throw err;
  }

  const fromEmail = extractEmailAddress(
    payload.FromFull?.Email || payload.From || ""
  ).toLowerCase();
  const fromName = payload.FromFull?.Name || null;
  const toEmails = (payload.ToFull || [])
    .map((a) => extractEmailAddress(a?.Email || ""))
    .filter(Boolean);
  const ccEmails = (payload.CcFull || [])
    .map((a) => extractEmailAddress(a?.Email || ""))
    .filter(Boolean);

  const headers = payload.Headers || [];
  const findHeader = (name: string): string | null => {
    const lower = name.toLowerCase();
    const h = headers.find((h) => (h.Name || "").toLowerCase() === lower);
    return h?.Value || null;
  };
  const inReplyTo = findHeader("In-Reply-To");
  const references = findHeader("References");

  const subject = payload.Subject || "";
  const textBody = payload.TextBody || "";
  const htmlBody = payload.HtmlBody || null;
  const strippedReply = payload.StrippedTextReply || textBody;

  const receivedAt = payload.Date ? new Date(payload.Date) : new Date();

  let followUpId: ObjectId | null = null;
  let matchMethod: ReplyMatchMethod = "unmatched";
  try {
    const result = await matchReplyToFollowUp({
      toEmails,
      ccEmails,
      subject,
      fromEmail,
      inReplyTo,
      references,
    });
    followUpId = result.followUpId;
    matchMethod = result.method;
  } catch (err: any) {
    log.error("Matching threw — persisting as unmatched", err.message);
  }

  const isMatched = followUpId != null;

  const now = new Date();
  const insertResult = await getSupplierRepliesCollection().insertOne({
    followUpId: followUpId,
    isMatched,
    matchMethod,
    fromEmail,
    fromName,
    toEmails,
    ccEmails,
    subject,
    textBody,
    htmlBody,
    strippedReply,
    messageId,
    inReplyTo,
    references,
    receivedAt: isNaN(receivedAt.getTime()) ? now : receivedAt,
    rawPayload: payload as unknown as Record<string, unknown>,
    createdAt: now,
  });

  if (isMatched && followUpId) {
    await getEmailFollowUpsCollection().updateOne(
      { _id: followUpId },
      {
        $set: {
          status: "replied",
          lastReplyAt: isNaN(receivedAt.getTime()) ? now : receivedAt,
          updatedAt: now,
        },
      }
    );
    log.info(
      `Reply ${insertResult.insertedId.toString()} matched follow-up ${followUpId.toString()} via ${matchMethod}`
    );
  } else {
    log.warn(
      `Reply ${insertResult.insertedId.toString()} unmatched (from=${fromEmail}, subject="${subject}")`
    );
  }

  res.json({ ok: true, replyId: insertResult.insertedId.toString(), matched: isMatched, matchMethod });
});

export default router;
