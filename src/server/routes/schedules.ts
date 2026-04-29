import { Router } from "express";
import { ObjectId } from "mongodb";
import { getScheduledMessagesCollection } from "../../db/mongo";
import { triggerScheduledMessage, validateGroupRef } from "../../scheduler";
import { ScheduledMessageDocument } from "../../db/schema";

const router = Router();

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateScheduleBody(body: any): { ok: true; doc: any } | { ok: false; error: string } {
  const {
    name,
    mode,
    messageText,
    aiPrompt,
    targetGroups,
    schedule,
    enabled,
    autoSend,
  } = body || {};

  if (!name || typeof name !== "string") return { ok: false, error: "name is required" };
  if (mode !== "static" && mode !== "ai_draft") {
    return { ok: false, error: "mode must be 'static' or 'ai_draft'" };
  }
  if (mode === "static" && (!messageText || typeof messageText !== "string")) {
    return { ok: false, error: "messageText is required for mode=static" };
  }
  if (mode === "ai_draft" && (!aiPrompt || typeof aiPrompt !== "string")) {
    return { ok: false, error: "aiPrompt is required for mode=ai_draft" };
  }
  if (!Array.isArray(targetGroups) || targetGroups.length === 0) {
    return { ok: false, error: "at least one target group is required" };
  }
  for (const g of targetGroups) {
    if (!validateGroupRef(g)) {
      return { ok: false, error: "each targetGroup must be { jid: string, name: string }" };
    }
  }
  if (
    !schedule ||
    !Array.isArray(schedule.times) ||
    schedule.times.length === 0
  ) {
    return { ok: false, error: "at least one schedule time is required" };
  }
  for (const t of schedule.times) {
    if (typeof t !== "string" || !TIME_REGEX.test(t)) {
      return { ok: false, error: `invalid time format: ${t} (expected HH:mm)` };
    }
  }
  const days = Array.isArray(schedule.days) ? schedule.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6) : [];

  return {
    ok: true,
    doc: {
      name,
      mode,
      messageText: mode === "static" ? messageText : null,
      aiPrompt: mode === "ai_draft" ? aiPrompt : null,
      targetGroups,
      schedule: { times: schedule.times, days },
      enabled: enabled !== false,
      autoSend: autoSend === true,
    },
  };
}

router.get("/", async (_req, res) => {
  try {
    const schedules = await getScheduledMessagesCollection()
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ schedules });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const validation = validateScheduleBody(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const now = new Date();
    const doc: ScheduledMessageDocument = {
      ...validation.doc,
      lastSentAt: null,
      lastSendResult: null,
      sendCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const collection = getScheduledMessagesCollection();
    const result = await collection.insertOne(doc as any);
    res.json({ id: result.insertedId, ...doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const validation = validateScheduleBody(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const collection = getScheduledMessagesCollection();
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...validation.doc, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Schedule not found" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id/toggle", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const { enabled } = req.body;
    const result = await getScheduledMessagesCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { enabled: !!enabled, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Schedule not found" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await getScheduledMessagesCollection().deleteOne({
      _id: new ObjectId(id),
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/trigger", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await triggerScheduledMessage(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ message: "Triggered", draftId: result.draftId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
