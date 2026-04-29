import { Router } from "express";
import { getMessagesCollection } from "../../db/mongo";

const router = Router();

/**
 * Group messages by their AI-extracted topic. Each "thread" is a topic
 * that appears in 2+ messages. Returns the threads sorted by most recent activity.
 */
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const groupJid = req.query.groupJid as string | undefined;

    const matchStage: any = {
      topic: { $ne: null, $exists: true },
    };
    if (groupJid) matchStage.groupJid = groupJid;

    const messages = getMessagesCollection();
    const threads = await messages
      .aggregate([
        { $match: matchStage },
        // Normalize topic: lowercase, trim
        {
          $addFields: {
            topicNorm: { $toLower: { $trim: { input: "$topic" } } },
          },
        },
        {
          $group: {
            _id: "$topicNorm",
            displayTopic: { $first: "$topic" },
            count: { $sum: 1 },
            firstAt: { $min: "$timestamp" },
            lastAt: { $max: "$timestamp" },
            groups: { $addToSet: { jid: "$groupJid", name: "$groupName" } },
            senders: { $addToSet: "$sender" },
            entities: { $push: "$entities" },
            actionItemsAll: { $push: "$actionItems" },
            messageIds: { $push: "$_id" },
            sentiments: { $push: "$sentiment" },
          },
        },
        { $match: { count: { $gte: 2 } } },
        { $sort: { lastAt: -1 } },
        { $limit: limit },
      ])
      .toArray();

    // Flatten arrays + count negatives
    const enriched = threads.map((t) => {
      const flatEntities = (t.entities as string[][]).flat().filter(Boolean);
      const dedupEntities = Array.from(new Set(flatEntities)).slice(0, 10);
      const flatActions = (t.actionItemsAll as string[][])
        .flat()
        .filter(Boolean);
      const negCount = (t.sentiments as (string | null)[]).filter(
        (s) => s === "negative"
      ).length;
      return {
        topic: t.displayTopic,
        count: t.count,
        firstAt: t.firstAt,
        lastAt: t.lastAt,
        groups: t.groups,
        senders: t.senders,
        entities: dedupEntities,
        openActions: flatActions.slice(0, 5),
        negativeCount: negCount,
      };
    });

    res.json({ threads: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:topic", async (req, res) => {
  try {
    const topic = decodeURIComponent(req.params.topic);
    const messages = await getMessagesCollection()
      .find(
        {
          topic: { $regex: `^${escapeRegex(topic)}$`, $options: "i" },
        },
        { projection: { embedding: 0 } }
      )
      .sort({ timestamp: 1 })
      .limit(200)
      .toArray();
    res.json({ topic, messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
