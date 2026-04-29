import { Router } from "express";
import {
  getAgentActionsCollection,
  getAgentSettings,
  updateAgentSettings,
  getTrackedGroups,
  getPurchaseOrdersCollection,
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

/**
 * High-level snapshot of what the agent is currently doing — used by the
 * "Agent Summary" card on the frontend so the user can see at a glance
 * which threads are open, how active the agent has been, and what state
 * the agent is in.
 *
 * Open threads = ask_clarifying actions in the last 6 hours where the
 * targeted PO is still `awaitingReply: true` (i.e., the supplier hasn't
 * answered yet). Joined to the PO master so we can show product/company.
 */
router.get("/summary", async (_req, res) => {
  try {
    const now = Date.now();
    const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000);
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [settings, actionsCol, posCol] = [
      await getAgentSettings(),
      getAgentActionsCollection(),
      getPurchaseOrdersCollection(),
    ];

    const [
      recentAsks,
      awaitingPOs,
      last24h,
      sentLast24h,
      byDecision,
      autoClosed24h,
      pendingEscalations,
      ackForResolutionTime,
    ] = await Promise.all([
      actionsCol
        .find({
          decision: "ask_clarifying",
          sent: true,
          consideredAt: { $gte: sixHoursAgo },
        })
        .sort({ consideredAt: -1 })
        .limit(40)
        .toArray(),
      posCol.find({ awaitingReply: true }).toArray(),
      actionsCol.countDocuments({ consideredAt: { $gte: dayAgo } }),
      actionsCol.countDocuments({
        consideredAt: { $gte: dayAgo },
        sent: true,
      }),
      actionsCol
        .aggregate([
          { $match: { consideredAt: { $gte: dayAgo } } },
          { $group: { _id: "$decision", count: { $sum: 1 } } },
        ])
        .toArray(),
      // Auto-closed = the agent successfully closed the loop in the last 24h
      // (asked → got an answer → acknowledged). Acknowledge actions are the
      // closing event; we count those.
      actionsCol.countDocuments({
        decision: "acknowledge",
        sent: true,
        consideredAt: { $gte: dayAgo },
      }),
      // Pending escalations = decisions the agent flagged for human review
      // that you haven't acted on yet. We treat anything in the last 7 days
      // as "still on your plate" — a reasonable signal to surface.
      actionsCol.countDocuments({
        decision: "escalate",
        consideredAt: { $gte: weekAgo },
      }),
      // For avg resolution time: pull last 50 acks in the past week.
      actionsCol
        .find({
          decision: "acknowledge",
          sent: true,
          consideredAt: { $gte: weekAgo },
        })
        .sort({ consideredAt: -1 })
        .limit(50)
        .toArray(),
    ]);

    // ── At risk: agent asks > 4h ago whose PO is still awaitingReply ──
    const awaitingRefSet = new Set(
      awaitingPOs.map((p) => p.poNumber.toUpperCase())
    );
    const oldAsks = await actionsCol
      .find({
        decision: "ask_clarifying",
        sent: true,
        consideredAt: { $lt: fourHoursAgo, $gte: weekAgo },
      })
      .sort({ consideredAt: -1 })
      .limit(200)
      .toArray();
    const atRiskRefs = new Set<string>();
    for (const a of oldAsks) {
      for (const r of a.referenceNumbers || []) {
        if (awaitingRefSet.has(r.toUpperCase())) atRiskRefs.add(r.toUpperCase());
      }
    }
    const atRiskCount = atRiskRefs.size;

    // ── Avg resolution time: for each ack, find the most recent prior ask
    //    in the same group with overlapping refs, take delta. Average. ──
    let totalDeltaMs = 0;
    let deltaSamples = 0;
    for (const ack of ackForResolutionTime) {
      const refs = (ack.referenceNumbers || []).map((r) => r.toUpperCase());
      if (refs.length === 0) continue;
      const priorAsk = await actionsCol.findOne(
        {
          groupJid: ack.groupJid,
          decision: "ask_clarifying",
          sent: true,
          consideredAt: { $lt: ack.consideredAt },
          referenceNumbers: {
            $elemMatch: { $regex: `^(${refs.map(escapeRegex).join("|")})$`, $options: "i" },
          },
        },
        { sort: { consideredAt: -1 } }
      );
      if (priorAsk) {
        totalDeltaMs +=
          new Date(ack.consideredAt).getTime() -
          new Date(priorAsk.consideredAt).getTime();
        deltaSamples += 1;
      }
    }
    const avgResolutionMinutes =
      deltaSamples === 0
        ? null
        : Math.round(totalDeltaMs / deltaSamples / 60_000);

    const awaitingByRef = new Map<string, (typeof awaitingPOs)[number]>();
    for (const p of awaitingPOs) {
      awaitingByRef.set(p.poNumber.toUpperCase(), p);
    }

    // For each recent ask, find the matching awaiting PO and emit an "open
    // thread" entry. De-duplicate per PO — only the most recent ask wins.
    const seen = new Set<string>();
    const openThreads: Array<{
      poNumber: string;
      productName: string;
      companyName: string;
      askedAt: Date;
      supplierName: string;
      groupName: string;
      outboundText: string | null;
    }> = [];

    for (const a of recentAsks) {
      for (const ref of a.referenceNumbers || []) {
        const key = ref.toUpperCase();
        if (seen.has(key)) continue;
        const po = awaitingByRef.get(key);
        if (!po) continue;
        seen.add(key);
        openThreads.push({
          poNumber: po.poNumber,
          productName: po.productName,
          companyName: po.companyName,
          askedAt: a.consideredAt,
          supplierName: a.senderName,
          groupName: a.groupName,
          outboundText: a.outboundText,
        });
      }
    }

    res.json({
      enabled: settings.enabled,
      mode: settings.mode,
      watchingGroupCount: settings.allowedGroupJids.length,
      last24h,
      sentLast24h,
      byDecision,
      openThreads,
      atRiskCount,
      autoClosed24h,
      avgResolutionMinutes,
      pendingEscalations,
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
