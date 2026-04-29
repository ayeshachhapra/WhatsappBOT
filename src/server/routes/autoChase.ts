import { Router } from "express";
import { createAutoChaseSchedule, validateGroupRef } from "../../scheduler";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const {
      name,
      messageText,
      targetGroups,
      mentionJids,
      mentions,
      time,
      cadenceDays,
      meta,
    } = req.body;
    if (!messageText || typeof messageText !== "string") {
      return res.status(400).json({ error: "messageText is required" });
    }
    if (!Array.isArray(targetGroups) || targetGroups.length === 0) {
      return res.status(400).json({ error: "at least one target group is required" });
    }
    for (const g of targetGroups) {
      if (!validateGroupRef(g)) {
        return res
          .status(400)
          .json({ error: "each targetGroup must be { jid: string, name: string }" });
      }
    }
    const cleanMentionJids = Array.isArray(mentionJids)
      ? mentionJids.filter((m: any) => typeof m === "string" && m.includes("@"))
      : undefined;
    const cleanMentions = sanitiseMentions(mentions);
    const cleanMeta =
      meta && typeof meta === "object"
        ? {
            chatQuestion:
              typeof meta.chatQuestion === "string" ? meta.chatQuestion : undefined,
            chatAnswerSnippet:
              typeof meta.chatAnswerSnippet === "string"
                ? meta.chatAnswerSnippet
                : undefined,
            triggerSender:
              typeof meta.triggerSender === "string" ? meta.triggerSender : undefined,
          }
        : undefined;

    const result = await createAutoChaseSchedule({
      name: typeof name === "string" && name.trim() ? name.trim() : "Auto-chase",
      messageText,
      targetGroups,
      mentions: cleanMentions,
      mentionJids: cleanMentionJids,
      time: typeof time === "string" && time ? time : "09:00",
      cadenceDays: typeof cadenceDays === "number" ? cadenceDays : 1,
      meta: cleanMeta,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function sanitiseMentions(input: unknown):
  | { jid: string; name?: string }[]
  | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: { jid: string; name?: string }[] = [];
  for (const m of input) {
    if (m && typeof m === "object" && typeof (m as any).jid === "string") {
      const jid = (m as any).jid;
      if (!jid.includes("@")) continue;
      const name = typeof (m as any).name === "string" ? (m as any).name : undefined;
      out.push({ jid, ...(name ? { name } : {}) });
    }
  }
  return out.length > 0 ? out : undefined;
}

export default router;
