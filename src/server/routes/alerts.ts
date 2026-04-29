import { Router } from "express";
import {
  getMessagesCollection,
  getDraftsCollection,
  getTrackedGroups,
  getScheduledMessagesCollection,
  getAlertTriggersCollection,
} from "../../db/mongo";

const router = Router();

const STALE_DAYS = 3;
const QUIET_DAYS = 2;
const NEGATIVE_LOOKBACK_DAYS = 7;

router.get("/", async (_req, res) => {
  try {
    const messages = getMessagesCollection();
    const drafts = getDraftsCollection();
    const schedules = getScheduledMessagesCollection();

    const now = Date.now();
    const staleSince = new Date(now - STALE_DAYS * 24 * 60 * 60 * 1000);
    const quietSince = new Date(now - QUIET_DAYS * 24 * 60 * 60 * 1000);
    const negativeSince = new Date(
      now - NEGATIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    );

    const [
      tracked,
      staleActions,
      recentNegatives,
      latestPerGroup,
      pendingDrafts,
      activeSchedules,
      ruleTriggers,
      lateOrders,
      upcomingOrders,
    ] = await Promise.all([
      getTrackedGroups(),
      // Messages with action items left hanging — older than 3 days, no recent
      // resolution message in the same group from the same/any sender.
      messages
        .find(
          {
            actionItems: { $exists: true, $not: { $size: 0 } },
            timestamp: { $lt: staleSince },
          },
          { projection: { embedding: 0 } }
        )
        .sort({ timestamp: -1 })
        .limit(50)
        .toArray(),
      // Recent negative sentiment messages — supplier complaints, problems flagged
      messages
        .find(
          {
            sentiment: "negative",
            timestamp: { $gte: negativeSince },
          },
          { projection: { embedding: 0 } }
        )
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray(),
      // Latest message timestamp per tracked group (to find quiet groups)
      messages
        .aggregate([
          { $sort: { timestamp: -1 } },
          {
            $group: {
              _id: "$groupJid",
              groupName: { $first: "$groupName" },
              lastTimestamp: { $first: "$timestamp" },
              lastSender: { $first: "$sender" },
              lastBody: { $first: "$body" },
            },
          },
        ])
        .toArray(),
      drafts.find({ status: "pending" }).sort({ createdAt: -1 }).limit(20).toArray(),
      schedules
        .find({ enabled: true, stopOnResponse: true })
        .sort({ createdAt: -1 })
        .toArray(),
      // Rule triggers (unacknowledged)
      getAlertTriggersCollection()
        .find({ acknowledged: false })
        .sort({ triggeredAt: -1 })
        .limit(20)
        .toArray(),
      // Late orders: messages with referenceNumbers and a dueDate in the past
      messages
        .find(
          {
            referenceNumbers: { $exists: true, $ne: [] },
            dueDate: { $lt: new Date(now), $ne: null },
          },
          { projection: { embedding: 0 } }
        )
        .sort({ dueDate: -1 })
        .limit(30)
        .toArray(),
      // Upcoming: dueDate within next 3 days
      messages
        .find(
          {
            referenceNumbers: { $exists: true, $ne: [] },
            dueDate: {
              $gte: new Date(now),
              $lte: new Date(now + 3 * 24 * 60 * 60 * 1000),
            },
          },
          { projection: { embedding: 0 } }
        )
        .sort({ dueDate: 1 })
        .limit(30)
        .toArray(),
    ]);

    // Filter staleActions: drop ones whose group has had a definitive resolution
    // message after the stale message ("done", "delivered", "received", "completed").
    const RESOLVED_RE = /\b(done|delivered|received|completed|dispatched|resolved|closed|shipped|sent)\b/i;
    const filteredStale: any[] = [];
    for (const m of staleActions) {
      const newer = await messages
        .find(
          {
            groupJid: m.groupJid,
            timestamp: { $gt: m.timestamp },
            body: { $regex: RESOLVED_RE },
          },
          { projection: { _id: 1 } }
        )
        .limit(1)
        .toArray();
      if (newer.length === 0) {
        filteredStale.push(m);
      }
    }

    // Quiet groups: tracked groups whose latest message is older than QUIET_DAYS,
    // OR tracked groups with NO messages at all.
    const latestByJid: Record<string, any> = {};
    for (const row of latestPerGroup) {
      latestByJid[row._id] = row;
    }
    const quietGroups = tracked
      .map((g) => {
        const latest = latestByJid[g.jid];
        const lastTs: Date | null = latest?.lastTimestamp || null;
        if (!lastTs || new Date(lastTs).getTime() < quietSince.getTime()) {
          return {
            group: g,
            lastTimestamp: lastTs,
            lastSender: latest?.lastSender || null,
            lastBody: latest?.lastBody || null,
            daysQuiet: lastTs
              ? Math.floor((now - new Date(lastTs).getTime()) / (24 * 60 * 60 * 1000))
              : null,
          };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Filter late orders: drop ones already resolved by later "delivered/received" messages.
    const filteredLate: any[] = [];
    for (const m of lateOrders) {
      const newer = await messages
        .find(
          {
            groupJid: m.groupJid,
            referenceNumbers: { $in: m.referenceNumbers || [] },
            timestamp: { $gt: m.timestamp },
            body: { $regex: /\b(delivered|received|completed|done|pod|signed)\b/i },
          },
          { projection: { _id: 1 } }
        )
        .limit(1)
        .toArray();
      if (newer.length === 0) filteredLate.push(m);
    }

    res.json({
      summary: {
        staleCount: filteredStale.length,
        negativeCount: recentNegatives.length,
        quietCount: quietGroups.length,
        pendingDraftsCount: pendingDrafts.length,
        activeAutoChases: activeSchedules.length,
        trackedGroupsCount: tracked.length,
        ruleTriggerCount: ruleTriggers.length,
        lateOrdersCount: filteredLate.length,
        upcomingOrdersCount: upcomingOrders.length,
      },
      staleActions: filteredStale.slice(0, 20),
      recentNegatives,
      quietGroups,
      pendingDrafts,
      activeAutoChases: activeSchedules,
      ruleTriggers,
      lateOrders: filteredLate.slice(0, 20),
      upcomingOrders,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
