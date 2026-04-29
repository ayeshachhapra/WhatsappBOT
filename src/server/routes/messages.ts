import { Router } from "express";
import { getMessagesCollection } from "../../db/mongo";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const filter: any = {};
    if (req.query.groupJid) filter.groupJid = req.query.groupJid;
    if (req.query.sender) {
      filter.sender = { $regex: req.query.sender as string, $options: "i" };
    }
    if (req.query.q) {
      filter.$or = [
        { body: { $regex: req.query.q as string, $options: "i" } },
        { topic: { $regex: req.query.q as string, $options: "i" } },
        { summary: { $regex: req.query.q as string, $options: "i" } },
      ];
    }
    if (req.query.since) {
      filter.timestamp = filter.timestamp || {};
      filter.timestamp.$gte = new Date(req.query.since as string);
    }
    if (req.query.until) {
      filter.timestamp = filter.timestamp || {};
      filter.timestamp.$lte = new Date(req.query.until as string);
    }
    if (req.query.sentiment) filter.sentiment = req.query.sentiment;

    const collection = getMessagesCollection();
    const [messages, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    res.json({ messages, total, limit });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resolve the best @-mention target for an outbound follow-up:
 *   "Who in this group has actually been talking about this reference?"
 *
 * Query params:
 *   ref      — required. PO/AWB/invoice reference (case-insensitive). May be the
 *              full canonical ("PO-1001") or just the digits ("1001"); we match
 *              referenceNumbers entries that contain it.
 *   groupJid — optional. Constrain to a single group.
 *
 * Strategy:
 *   1. Find non-fromMe messages tagged with this ref, prefer ones whose
 *      senderJid is `@s.whatsapp.net` (phone JID — only those render as pills).
 *   2. If only `@lid` JIDs exist for those messages, look up an earlier message
 *      from the same pushName (`sender`) in the same group whose senderJid is
 *      `@s.whatsapp.net`, and use that JID instead.
 *   3. Returns 200 with `{ senderJid: null }` when no candidate exists — the
 *      caller treats that as "don't tag anyone".
 */
router.get("/mention-target", async (req, res) => {
  try {
    const ref = (req.query.ref as string | undefined)?.trim();
    if (!ref) return res.status(400).json({ error: "ref is required" });
    const groupJid = (req.query.groupJid as string | undefined)?.trim();

    const collection = getMessagesCollection();
    const refRegex = new RegExp(escapeRegex(ref), "i");
    const baseFilter: any = {
      referenceNumbers: { $elemMatch: { $regex: refRegex } },
      fromMe: { $ne: true },
    };
    if (groupJid) baseFilter.groupJid = groupJid;

    // Phone JID first — these render as real pills in WhatsApp.
    const phoneCandidate = await collection
      .find(
        { ...baseFilter, senderJid: { $regex: /@s\.whatsapp\.net$/i } },
        { projection: { embedding: 0 } }
      )
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (phoneCandidate.length > 0) {
      const m = phoneCandidate[0];
      return res.json({
        senderJid: m.senderJid,
        sender: m.sender,
        source: "phone_jid",
        groupJid: m.groupJid,
        groupName: m.groupName,
        timestamp: m.timestamp,
      });
    }

    // Otherwise pick the latest by any JID, then try to upgrade to a phone JID
    // by finding the same pushName in another message that does have one.
    const anyCandidate = await collection
      .find(baseFilter, { projection: { embedding: 0 } })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (anyCandidate.length === 0) {
      return res.json({ senderJid: null });
    }

    const m = anyCandidate[0];
    const upgrade = await collection.findOne(
      {
        groupJid: m.groupJid,
        sender: m.sender,
        senderJid: { $regex: /@s\.whatsapp\.net$/i },
        fromMe: { $ne: true },
      },
      { projection: { senderJid: 1 }, sort: { timestamp: -1 } }
    );

    res.json({
      senderJid: upgrade?.senderJid || m.senderJid,
      sender: m.sender,
      source: upgrade ? "phone_jid_upgraded" : "lid_only",
      groupJid: m.groupJid,
      groupName: m.groupName,
      timestamp: m.timestamp,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.get("/stats", async (_req, res) => {
  try {
    const collection = getMessagesCollection();
    const [total, perGroup] = await Promise.all([
      collection.countDocuments(),
      collection
        .aggregate([
          { $group: { _id: { jid: "$groupJid", name: "$groupName" }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ])
        .toArray(),
    ]);
    res.json({ total, perGroup });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
