import { Router } from "express";
import { ObjectId } from "mongodb";
import {
  getEmailFollowUpsCollection,
  getPurchaseOrdersCollection,
  getSupplierRepliesCollection,
} from "../../db/mongo";
import { config } from "../../config";
import {
  buildGmailComposeUrl,
  buildMailtoUrl,
} from "../../utils/composeUrls";
import {
  appendTrackingTag,
  generateTrackingTag,
} from "../../utils/trackingTag";
import createLogger from "../../utils/logger";

const router = Router();
const log = createLogger("EmailFollowUps");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get("/", async (req, res) => {
  try {
    const { purchaseOrderId } = req.query;
    if (typeof purchaseOrderId !== "string" || !ObjectId.isValid(purchaseOrderId)) {
      return res
        .status(400)
        .json({ error: "purchaseOrderId query param required" });
    }
    const followUps = await getEmailFollowUpsCollection()
      .find({ purchaseOrderId: new ObjectId(purchaseOrderId) })
      .sort({ createdAt: -1 })
      .toArray();

    const ids = followUps.map((f) => f._id!).filter(Boolean);
    const replies = ids.length
      ? await getSupplierRepliesCollection()
          .find({ followUpId: { $in: ids } })
          .sort({ receivedAt: -1 })
          .toArray()
      : [];

    const repliesByFollowUp = new Map<string, typeof replies>();
    for (const r of replies) {
      const key = r.followUpId!.toString();
      const arr = repliesByFollowUp.get(key) || [];
      arr.push(r);
      repliesByFollowUp.set(key, arr);
    }

    const result = followUps.map((f) => ({
      ...f,
      replies: repliesByFollowUp.get(f._id!.toString()) || [],
    }));
    res.json({ followUps: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { purchaseOrderId, toEmail, toName, subject, body, ccEmails } =
      req.body || {};

    if (typeof purchaseOrderId !== "string" || !ObjectId.isValid(purchaseOrderId)) {
      return res.status(400).json({ error: "purchaseOrderId is required" });
    }
    if (typeof toEmail !== "string" || !EMAIL_REGEX.test(toEmail.trim())) {
      return res.status(400).json({ error: "toEmail must be a valid email" });
    }
    if (typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ error: "subject is required" });
    }
    if (typeof body !== "string" || !body.trim()) {
      return res.status(400).json({ error: "body is required" });
    }

    const po = await getPurchaseOrdersCollection().findOne({
      _id: new ObjectId(purchaseOrderId),
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    const trackingTag = generateTrackingTag();
    const finalSubject = appendTrackingTag(subject, trackingTag);

    const inboundCc = config.emailFollowUps.inboundCcEmail;
    const userCc = Array.isArray(ccEmails)
      ? ccEmails
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim())
          .filter((e) => EMAIL_REGEX.test(e))
      : [];
    const finalCc = Array.from(new Set([...userCc, inboundCc]));

    const now = new Date();
    const insertResult = await getEmailFollowUpsCollection().insertOne({
      purchaseOrderId: po._id!,
      toEmail: toEmail.trim(),
      toName: typeof toName === "string" && toName.trim() ? toName.trim() : null,
      ccEmails: finalCc,
      subject: finalSubject,
      body,
      status: "draft",
      trackingTag,
      outboundMessageId: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      lastReplyAt: null,
    });

    const composeInput = {
      to: toEmail.trim(),
      cc: finalCc,
      subject: finalSubject,
      body,
    };

    log.info(
      `Created follow-up ${insertResult.insertedId.toString()} for PO ${po.poNumber} → ${toEmail}`
    );

    res.json({
      id: insertResult.insertedId.toString(),
      trackingTag,
      subject: finalSubject,
      ccEmails: finalCc,
      gmailComposeUrl: buildGmailComposeUrl(composeInput),
      mailtoUrl: buildMailtoUrl(composeInput),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/mark-sent", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const now = new Date();
    const result = await getEmailFollowUpsCollection().findOneAndUpdate(
      { _id: new ObjectId(id), status: "draft" },
      { $set: { status: "sent", sentAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!result) {
      const existing = await getEmailFollowUpsCollection().findOne({
        _id: new ObjectId(id),
      });
      if (!existing) return res.status(404).json({ error: "Not found" });
      return res.json(existing);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/link-reply", async (req, res) => {
  try {
    const { id } = req.params;
    const { replyId } = req.body || {};
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid follow-up id" });
    if (typeof replyId !== "string" || !ObjectId.isValid(replyId)) {
      return res.status(400).json({ error: "replyId required" });
    }
    const fu = await getEmailFollowUpsCollection().findOne({ _id: new ObjectId(id) });
    if (!fu) return res.status(404).json({ error: "Follow-up not found" });
    const reply = await getSupplierRepliesCollection().findOne({
      _id: new ObjectId(replyId),
    });
    if (!reply) return res.status(404).json({ error: "Reply not found" });

    const now = new Date();
    await getSupplierRepliesCollection().updateOne(
      { _id: reply._id! },
      {
        $set: {
          followUpId: fu._id!,
          isMatched: true,
          matchMethod: "manual",
        },
      }
    );
    await getEmailFollowUpsCollection().updateOne(
      { _id: fu._id! },
      {
        $set: {
          status: "replied",
          lastReplyAt: reply.receivedAt > (fu.lastReplyAt || new Date(0)) ? reply.receivedAt : fu.lastReplyAt,
          updatedAt: now,
        },
      }
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
