import { Router } from "express";
import {
  getAgentActionsCollection,
  getDraftsCollection,
  getPurchaseOrdersCollection,
} from "../../db/mongo";
import { config } from "../../config";
import {
  buildGenerationConfig,
  getGeminiClient,
  getResponseText,
} from "../../ai/gemini";
import createLogger from "../../utils/logger";

const router = Router();
const log = createLogger("DashboardBriefing");

type AttentionPriority = "critical" | "high" | "medium";
type AttentionType =
  | "po_unreachable"
  | "po_late"
  | "po_long_silence"
  | "agent_escalation"
  | "pending_draft";

interface AttentionItem {
  id: string;
  type: AttentionType;
  priority: AttentionPriority;
  headline: string;
  description: string;
  /** What route to link to from the UI. */
  actionRoute: string;
  actionLabel: string;
  /** Sortable score — higher = more urgent. Used to pick top 3. */
  score: number;
  refs: string[];
  /** A pre-filled chat question the user can fire off with one click — sent
   *  to /chat?q=… so the buyer can dig deeper without typing. */
  askQuery: string;
}

interface BriefingCacheEntry {
  expiresAt: number;
  fingerprint: string;
  payload: { narrative: string; items: AttentionItem[] };
}
let briefingCache: BriefingCacheEntry | null = null;
const BRIEFING_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Bumped whenever the AttentionItem shape changes. The fingerprint includes
 * this version, so any payload cached under an older shape is automatically
 * invalidated — prevents stale items missing fields like `askQuery` from being
 * served after a code update without a backend restart wiping memory state.
 */
const ATTENTION_SHAPE_VERSION = 2;

router.get("/attention", async (_req, res) => {
  try {
    const items = await collectAttentionItems();
    const top3 = items.slice(0, 3);

    // Cache fingerprint = item shape version + identity of the top items +
    // their priorities + the overall total. The version prefix ensures any
    // payload cached under a previous attention-item shape is invalidated.
    const fingerprint =
      `v${ATTENTION_SHAPE_VERSION}|total=${items.length}|` +
      top3
        .map((i) => `${i.type}:${i.refs.join(",")}:${i.priority}`)
        .join("|");
    const now = Date.now();
    if (
      briefingCache &&
      briefingCache.fingerprint === fingerprint &&
      briefingCache.expiresAt > now
    ) {
      return res.json(briefingCache.payload);
    }

    const narrative = await generateNarrative(top3, items.length);
    const payload = { narrative, items: top3 };
    briefingCache = {
      expiresAt: now + BRIEFING_TTL_MS,
      fingerprint,
      payload,
    };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function collectAttentionItems(): Promise<AttentionItem[]> {
  const now = Date.now();
  const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [pos, escalations, oldDrafts] = await Promise.all([
    getPurchaseOrdersCollection().find({}).toArray(),
    getAgentActionsCollection()
      .find({ decision: "escalate", consideredAt: { $gte: weekAgo } })
      .sort({ consideredAt: -1 })
      .limit(20)
      .toArray(),
    getDraftsCollection()
      .find({ status: "pending", createdAt: { $lte: dayAgo } })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray(),
  ]);

  const items: AttentionItem[] = [];

  for (const po of pos) {
    if (po.status === "delivered") continue;

    // Most urgent: delayed AND supplier not responding to chase.
    if (po.status === "delayed" && po.awaitingReply) {
      const hoursSilent = po.lastUpdateAt
        ? Math.round((now - new Date(po.lastUpdateAt).getTime()) / (60 * 60 * 1000))
        : null;
      items.push({
        id: `po:${po.poNumber}:unreachable`,
        type: "po_unreachable",
        priority: "critical",
        headline: `${po.poNumber} — ${po.companyName} not responding to delay chase`,
        description: hoursSilent
          ? `${po.productName}. Delayed and ${po.companyName} hasn't replied to your last chase ${hoursSilent}h ago.`
          : `${po.productName}. Delayed and ${po.companyName} hasn't replied to your chase yet.`,
        actionRoute: "/browse",
        actionLabel: "Open in Track",
        score: 1000 + (hoursSilent || 0),
        refs: [po.poNumber],
        askQuery: `${po.poNumber} is delayed and ${po.companyName} hasn't replied. What do we know about this order — last update, who said what, and what should I do next?`,
      });
      continue;
    }

    // High: delayed, supplier engaged but ETA still not reset.
    if (po.status === "delayed") {
      items.push({
        id: `po:${po.poNumber}:late`,
        type: "po_late",
        priority: "high",
        headline: `${po.poNumber} — ${po.companyName} flagged delayed`,
        description: `${po.productName}. ${
          po.eta
            ? `Original ETA was ${new Date(po.eta).toLocaleDateString()}.`
            : "No revised ETA on record."
        } Supplier is engaged — confirm new ETA and update the PO.`,
        actionRoute: "/browse",
        actionLabel: "Open in Track",
        score: 700,
        refs: [po.poNumber],
        askQuery: `${po.poNumber} is delayed but ${po.companyName} is communicating. What's the latest status and what is the revised ETA they've shared?`,
      });
      continue;
    }

    // Medium: long-silent PO that we've chased — sometimes "ordered" or "in_transit"
    // POs go quiet for too long without being explicitly flagged delayed.
    if (
      po.awaitingReply &&
      po.lastUpdateAt &&
      new Date(po.lastUpdateAt) < fourHoursAgo
    ) {
      const hoursSilent = Math.round(
        (now - new Date(po.lastUpdateAt).getTime()) / (60 * 60 * 1000)
      );
      items.push({
        id: `po:${po.poNumber}:silence`,
        type: "po_long_silence",
        priority: "medium",
        headline: `${po.poNumber} — ${po.companyName} silent for ${hoursSilent}h`,
        description: `${po.productName}. Agent's last follow-up went unanswered. Consider a manual escalation if the ETA matters.`,
        actionRoute: "/agent",
        actionLabel: "Open in Agent",
        score: 300 + hoursSilent,
        refs: [po.poNumber],
        askQuery: `${po.poNumber} from ${po.companyName} has been silent for ${hoursSilent} hours. What was the last thing said, and is there anything I should worry about?`,
      });
    }
  }

  for (const e of escalations) {
    const refs = e.referenceNumbers || [];
    items.push({
      id: `escalation:${e._id?.toString()}`,
      type: "agent_escalation",
      priority: "high",
      headline:
        refs.length > 0
          ? `Agent escalated ${refs.join(", ")}`
          : `Agent escalated a message in ${e.groupName}`,
      description: e.reasoning || "Agent flagged this for human review.",
      actionRoute: "/agent",
      actionLabel: "Review in Agent",
      score: 600,
      refs,
      askQuery:
        refs.length > 0
          ? `The agent escalated ${refs.join(", ")} for review. Why? Show me the relevant supplier messages and what action you'd recommend.`
          : `The agent escalated a message in ${e.groupName}. Summarise what happened and what I should do.`,
    });
  }

  for (const d of oldDrafts) {
    const ageHours = Math.round(
      (now - new Date(d.createdAt).getTime()) / (60 * 60 * 1000)
    );
    items.push({
      id: `draft:${d._id?.toString()}`,
      type: "pending_draft",
      priority: "medium",
      headline: `Draft pending review for ${ageHours}h`,
      description: `"${d.scheduleName}" — drafted ${ageHours}h ago, hasn't been approved or rejected.`,
      actionRoute: "/outbox",
      actionLabel: "Open in Outbox",
      score: 200 + ageHours,
      refs: [],
      askQuery: `There's a follow-up draft titled "${d.scheduleName}" pending for ${ageHours} hours. What's the context and should I send it as-is?`,
    });
  }

  // Sort by score desc; same-score ties break by priority lexically (critical > high > medium).
  const priorityRank: Record<AttentionPriority, number> = {
    critical: 3,
    high: 2,
    medium: 1,
  };
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return priorityRank[b.priority] - priorityRank[a.priority];
  });

  return items;
}

async function generateNarrative(
  top3: AttentionItem[],
  totalCount: number
): Promise<string> {
  if (top3.length === 0) {
    return "Everything looks on track right now. No POs are delayed and no escalations are pending.";
  }
  if (!config.geminiApiKey) {
    return fallbackNarrative(top3, totalCount);
  }

  // Note: we deliberately do NOT pass the total count or a "X of Y" framing
  // into the prompt — the model has hallucinated wrong numbers ("the 5 total
  // items" when there were actually 3). The UI shows a deterministic count
  // chip next to the section title, so the LLM only needs to summarise the
  // *quality* of what's pending.
  const prompt = `You are an SCM (supply chain) buyer's briefing assistant. The buyer needs a clear, 2–3 sentence summary of what to pay attention to right now across their purchase orders.

Items requiring attention (highest priority first):
${top3
  .map(
    (i, idx) =>
      `${idx + 1}. [${i.priority}] ${i.headline} — ${i.description}`
  )
  .join("\n")}

Write a clear, factual 2–3 sentence briefing. Lead with the most urgent thing. Group similar items if natural ("two POs are delayed and..."). Speak directly to the buyer ("you", "your"). Do NOT mention any total count or "X of Y" framing — the UI handles counts separately. No greetings, no emojis, no bullet points. Return ONLY the briefing text.`;
  void totalCount; // kept in signature for the deterministic fallback below

  try {
    const client = getGeminiClient();
    const model = client.getGenerativeModel({
      model: config.geminiModel,
      generationConfig: buildGenerationConfig({ temperature: 0.3 }),
    });
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("briefing timed out")), 12000)
      ),
    ]);
    const text = getResponseText((result as any).response).trim();
    if (text.length === 0) return fallbackNarrative(top3, totalCount);
    return text.replace(/^["']|["']$/g, "").trim();
  } catch (err: any) {
    log.warn(`Briefing LLM failed (${err.message}) — using fallback`);
    return fallbackNarrative(top3, totalCount);
  }
}

function fallbackNarrative(top3: AttentionItem[], totalCount: number): string {
  if (top3.length === 0) return "Everything is on track.";
  const counts: Record<AttentionType, number> = {
    po_unreachable: 0,
    po_late: 0,
    po_long_silence: 0,
    agent_escalation: 0,
    pending_draft: 0,
  };
  for (const i of top3) counts[i.type] += 1;

  const parts: string[] = [];
  if (counts.po_unreachable > 0) {
    parts.push(
      `${counts.po_unreachable} delayed PO${counts.po_unreachable === 1 ? " is" : "s are"} not responding to your chases — these need direct attention`
    );
  }
  if (counts.po_late > 0) {
    parts.push(
      `${counts.po_late} more PO${counts.po_late === 1 ? " is" : "s are"} flagged delayed and need a revised ETA`
    );
  }
  if (counts.po_long_silence > 0) {
    parts.push(
      `${counts.po_long_silence} PO${counts.po_long_silence === 1 ? " has" : "s have"} gone silent for hours without a reply`
    );
  }
  if (counts.agent_escalation > 0) {
    parts.push(
      `${counts.agent_escalation} agent escalation${counts.agent_escalation === 1 ? "" : "s"} pending your review`
    );
  }
  if (counts.pending_draft > 0) {
    parts.push(
      `${counts.pending_draft} follow-up draft${counts.pending_draft === 1 ? "" : "s"} waiting > 24h for approval`
    );
  }
  const lead = parts.length > 0 ? parts.join(", ") + "." : "Everything is on track.";
  if (totalCount > top3.length) {
    const extra = totalCount - top3.length;
    return `${lead} ${extra} more item${extra === 1 ? " also needs" : "s also need"} attention — see Track and Outbox for the full picture.`;
  }
  return lead;
}

export default router;
