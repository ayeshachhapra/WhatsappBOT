import { Router } from "express";
import {
  getAgentActionsCollection,
  getAgentSettings,
  updateAgentSettings,
  getTrackedGroups,
} from "../../db/mongo";

const router = Router();

router.get("/settings", async (_req, res) => {
  try {
    const settings = await getAgentSettings();
    res.json({ settings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const {
      enabled,
      allowedGroupJids,
      maxMessagesPerGroupPerHour,
      maxMessagesPerGroupPerDay,
      cooldownSeconds,
      mode,
    } = req.body;

    const patch: Record<string, unknown> = {};
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (Array.isArray(allowedGroupJids)) {
      // The allowlist must be a strict subset of currently tracked groups —
      // belt-and-braces in case the UI sends a stale or hand-crafted JID.
      const tracked = await getTrackedGroups();
      const valid = new Set(tracked.map((g) => g.jid));
      const cleaned = allowedGroupJids
        .filter((j: any) => typeof j === "string" && valid.has(j));
      patch.allowedGroupJids = cleaned;
    }
    if (
      typeof maxMessagesPerGroupPerHour === "number" &&
      maxMessagesPerGroupPerHour >= 0 &&
      maxMessagesPerGroupPerHour <= 100
    ) {
      patch.maxMessagesPerGroupPerHour = Math.floor(maxMessagesPerGroupPerHour);
    }
    if (
      typeof maxMessagesPerGroupPerDay === "number" &&
      maxMessagesPerGroupPerDay >= 0 &&
      maxMessagesPerGroupPerDay <= 1000
    ) {
      patch.maxMessagesPerGroupPerDay = Math.floor(maxMessagesPerGroupPerDay);
    }
    if (
      typeof cooldownSeconds === "number" &&
      cooldownSeconds >= 0 &&
      cooldownSeconds <= 3600
    ) {
      patch.cooldownSeconds = Math.floor(cooldownSeconds);
    }
    if (mode === "active" || mode === "observe") {
      patch.mode = mode;
    }

    const updated = await updateAgentSettings(patch);
    res.json({ settings: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/actions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const filter: any = {};
    if (req.query.groupJid) filter.groupJid = req.query.groupJid;
    if (req.query.decision) filter.decision = req.query.decision;
    if (req.query.sentOnly === "true") filter.sent = true;

    const actions = await getAgentActionsCollection()
      .find(filter)
      .sort({ consideredAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ actions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const collection = getAgentActionsCollection();
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const [total, last24h, sent24h, byDecision] = await Promise.all([
      collection.estimatedDocumentCount(),
      collection.countDocuments({ consideredAt: { $gte: dayAgo } }),
      collection.countDocuments({ consideredAt: { $gte: dayAgo }, sent: true }),
      collection
        .aggregate([
          { $match: { consideredAt: { $gte: dayAgo } } },
          { $group: { _id: "$decision", count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    res.json({ total, last24h, sent24h, byDecision });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
