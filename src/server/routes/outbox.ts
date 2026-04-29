import { Router } from "express";
import {
  getDraftsCollection,
  getAgentActionsCollection,
} from "../../db/mongo";

const router = Router();

type OutboxSource = "ai_chat" | "schedule" | "agent";
type OutboxStatus = "pending" | "sent" | "rejected" | "approved" | "failed";

interface OutboxItem {
  /** Unique surrogate id, e.g. "draft:6712..." or "agent:6713...". */
  id: string;
  source: OutboxSource;
  status: OutboxStatus;
  /** When the message was authored (or considered, for agent). ISO string. */
  createdAt: string;
  /** When it actually went out on WhatsApp. Null for unsent drafts. */
  sentAt: string | null;
  text: string;
  targetGroups: { jid: string; name: string }[];
  refs: string[];
  // Action handles for the UI
  draftId: string | null;
  agentActionId: string | null;
  // Source-specific extras
  scheduleName: string | null;
  chatQuestion: string | null;
  chatAnswerSnippet: string | null;
  triggerSender: string | null;
  triggerMsgId: string | null;
  /** Agent-only: short rationale for this outbound. */
  reasoning: string | null;
  /** Agent-only: which decision branch (ask_clarifying / acknowledge). */
  decision: string | null;
  // Mention pill that went out (if any)
  mentionName: string | null;
  mentionJid: string | null;
  // Failure info
  error: string | null;
}

/**
 * Unified outbox. Aggregates from:
 *   - drafts          → chat (Ask AI) and non-autoSend schedule paths
 *   - agentActions    → autonomous agent sends (sent: true only)
 *
 * Normalises both into a single shape so the UI can show a single timeline.
 * Filters apply uniformly (source, status, group, free-text search).
 */
router.get("/timeline", async (req, res) => {
  try {
    const status = (req.query.status as string) || "";
    const source = (req.query.source as string) || "";
    const groupJid = (req.query.groupJid as string) || "";
    const q = ((req.query.q as string) || "").trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 300);

    // We over-fetch a bit because filtering happens after merge.
    const fetchLimit = limit * 3;

    const [drafts, agentSends] = await Promise.all([
      // Drafts cover both Ask AI and schedule-derived items.
      getDraftsCollection()
        .find({})
        .sort({ createdAt: -1 })
        .limit(fetchLimit)
        .toArray(),
      // Agent's autonomous outbound — only the ones that actually went out.
      getAgentActionsCollection()
        .find({ sent: true })
        .sort({ consideredAt: -1 })
        .limit(fetchLimit)
        .toArray(),
    ]);

    const items: OutboxItem[] = [];

    for (const d of drafts) {
      const inferredSource: OutboxSource =
        d.source === "manual" ? "ai_chat" : "schedule";
      const inferredStatus: OutboxStatus =
        d.sendError && d.status !== "sent" ? "failed" : (d.status as OutboxStatus);
      items.push({
        id: `draft:${d._id?.toString()}`,
        source: inferredSource,
        status: inferredStatus,
        createdAt: new Date(d.createdAt).toISOString(),
        sentAt: d.sentAt ? new Date(d.sentAt).toISOString() : null,
        text: d.draftText,
        targetGroups: d.targetGroups,
        refs: [],
        draftId: d._id?.toString() || null,
        agentActionId: null,
        scheduleName: d.scheduleName,
        chatQuestion: d.meta?.chatQuestion || null,
        chatAnswerSnippet: d.meta?.chatAnswerSnippet || null,
        triggerSender: d.meta?.triggerSender || null,
        triggerMsgId: null,
        reasoning: null,
        decision: null,
        mentionName: null,
        mentionJid: null,
        error: d.sendError || null,
      });
    }

    for (const a of agentSends) {
      items.push({
        id: `agent:${a._id?.toString()}`,
        source: "agent",
        status: "sent",
        createdAt: new Date(a.consideredAt).toISOString(),
        sentAt: new Date(a.consideredAt).toISOString(),
        text: a.outboundText || "",
        targetGroups: [{ jid: a.groupJid, name: a.groupName }],
        refs: a.referenceNumbers || [],
        draftId: null,
        agentActionId: a._id?.toString() || null,
        scheduleName: null,
        chatQuestion: null,
        chatAnswerSnippet: null,
        triggerSender: a.senderName,
        triggerMsgId: a.triggerMsgId,
        reasoning: a.reasoning,
        decision: a.decision,
        mentionName: a.mentionName,
        mentionJid: a.mentionJid,
        error: a.error,
      });
    }

    // Apply filters
    let filtered = items;
    if (source) filtered = filtered.filter((i) => i.source === source);
    if (status) filtered = filtered.filter((i) => i.status === status);
    if (groupJid)
      filtered = filtered.filter((i) =>
        i.targetGroups.some((g) => g.jid === groupJid)
      );
    if (q) {
      filtered = filtered.filter(
        (i) =>
          i.text.toLowerCase().includes(q) ||
          (i.chatQuestion || "").toLowerCase().includes(q) ||
          (i.scheduleName || "").toLowerCase().includes(q) ||
          (i.triggerSender || "").toLowerCase().includes(q) ||
          (i.reasoning || "").toLowerCase().includes(q) ||
          i.targetGroups.some((g) => g.name.toLowerCase().includes(q)) ||
          i.refs.some((r) => r.toLowerCase().includes(q))
      );
    }

    // Sort by sentAt (when sent) or createdAt — newest first.
    filtered.sort((a, b) => {
      const aT = new Date(a.sentAt || a.createdAt).getTime();
      const bT = new Date(b.sentAt || b.createdAt).getTime();
      return bT - aT;
    });

    res.json({ items: filtered.slice(0, limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));

    const [
      pendingReview,
      sentTodayDrafts,
      agentAuto24h,
      failedDrafts,
    ] = await Promise.all([
      getDraftsCollection().countDocuments({ status: "pending" }),
      getDraftsCollection().countDocuments({
        status: "sent",
        sentAt: { $gte: startOfToday },
      }),
      getAgentActionsCollection().countDocuments({
        sent: true,
        consideredAt: { $gte: dayAgo },
      }),
      getDraftsCollection().countDocuments({
        $or: [
          { status: "approved" }, // Means approved but failed to send
          { sendError: { $ne: null }, status: { $ne: "sent" } },
        ],
      }),
    ]);

    const sentTodayAgent = await getAgentActionsCollection().countDocuments({
      sent: true,
      consideredAt: { $gte: startOfToday },
    });

    res.json({
      pendingReview,
      sentToday: sentTodayDrafts + sentTodayAgent,
      agentAuto24h,
      failed: failedDrafts,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
