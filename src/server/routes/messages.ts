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
