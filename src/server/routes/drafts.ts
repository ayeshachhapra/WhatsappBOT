import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDraftsCollection } from "../../db/mongo";
import {
  approveDraft,
  createManualDraft,
  rejectDraft,
  validateGroupRef,
} from "../../scheduler";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { draftText, targetGroups, label, meta, mentionJids } = req.body;
    if (!draftText || typeof draftText !== "string") {
      return res.status(400).json({ error: "draftText is required" });
    }
    if (!Array.isArray(targetGroups) || targetGroups.length === 0) {
      return res
        .status(400)
        .json({ error: "at least one target group is required" });
    }
    for (const g of targetGroups) {
      if (!validateGroupRef(g)) {
        return res
          .status(400)
          .json({ error: "each targetGroup must be { jid: string, name: string }" });
      }
    }
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
    const cleanMentions =
      Array.isArray(mentionJids)
        ? mentionJids.filter((m) => typeof m === "string" && m.includes("@"))
        : undefined;

    const result = await createManualDraft({
      draftText,
      targetGroups,
      label: typeof label === "string" ? label : undefined,
      meta: cleanMeta,
      mentionJids: cleanMentions,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const status = (req.query.status as string) || undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const filter: any = {};
    if (status) filter.status = status;
    const drafts = await getDraftsCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ drafts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/approve", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await approveDraft(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ message: "Approved and sent" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/reject", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await rejectDraft(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ message: "Rejected" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const { draftText } = req.body;
    if (!draftText || typeof draftText !== "string") {
      return res.status(400).json({ error: "draftText is required" });
    }
    const result = await getDraftsCollection().findOneAndUpdate(
      { _id: new ObjectId(id), status: "pending" },
      { $set: { draftText } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Draft not found or not pending" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
