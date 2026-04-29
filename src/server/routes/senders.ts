import { Router } from "express";
import { getMessagesCollection } from "../../db/mongo";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const collection = getMessagesCollection();
    const aggregated = await collection
      .aggregate([
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: "$senderJid",
            sender: { $first: "$sender" },
            messageCount: { $sum: 1 },
            lastMessageAt: { $max: "$timestamp" },
            firstMessageAt: { $min: "$timestamp" },
            groups: { $addToSet: { jid: "$groupJid", name: "$groupName" } },
            negativeCount: {
              $sum: {
                $cond: [{ $eq: ["$sentiment", "negative"] }, 1, 0],
              },
            },
            positiveCount: {
              $sum: {
                $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0],
              },
            },
            recentTopics: { $push: "$topic" },
            lastBody: { $first: "$body" },
          },
        },
        { $sort: { lastMessageAt: -1 } },
        { $limit: limit },
      ])
      .toArray();

    const senders = aggregated.map((row) => {
      const topics = Array.from(
        new Set((row.recentTopics as (string | null)[]).filter((t): t is string => !!t))
      ).slice(0, 8);
      return {
        senderJid: row._id,
        sender: row.sender,
        messageCount: row.messageCount,
        firstMessageAt: row.firstMessageAt,
        lastMessageAt: row.lastMessageAt,
        groups: row.groups,
        negativeCount: row.negativeCount,
        positiveCount: row.positiveCount,
        recentTopics: topics,
        lastBody: ((row.lastBody as string) || "").slice(0, 200),
      };
    });

    res.json({ senders });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:senderJid", async (req, res) => {
  try {
    const senderJid = decodeURIComponent(req.params.senderJid);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const messages = await getMessagesCollection()
      .find({ senderJid }, { projection: { embedding: 0 } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    res.json({ senderJid, messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
