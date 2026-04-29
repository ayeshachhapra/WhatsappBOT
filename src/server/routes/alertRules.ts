import { Router } from "express";
import { ObjectId } from "mongodb";
import { getAlertRulesCollection } from "../../db/mongo";
import { AlertRuleDocument } from "../../db/schema";

const router = Router();

function validateBody(body: any): { ok: true; doc: any } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body required" };
  const { name, keywords, groupJids, enabled } = body;
  if (!name || typeof name !== "string") return { ok: false, error: "name is required" };
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return { ok: false, error: "at least one keyword is required" };
  }
  const cleanKw = keywords
    .filter((k: any) => typeof k === "string" && k.trim().length > 0)
    .map((k: string) => k.trim().toLowerCase());
  if (cleanKw.length === 0) return { ok: false, error: "all keywords are empty" };
  const cleanGroups = Array.isArray(groupJids)
    ? groupJids.filter((g: any) => typeof g === "string" && g)
    : [];
  return {
    ok: true,
    doc: {
      name: name.trim(),
      keywords: cleanKw,
      groupJids: cleanGroups,
      enabled: enabled !== false,
    },
  };
}

router.get("/", async (_req, res) => {
  try {
    const rules = await getAlertRulesCollection()
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ rules });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const v = validateBody(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const now = new Date();
    const doc: AlertRuleDocument = {
      ...v.doc,
      createdAt: now,
      updatedAt: now,
    };
    const result = await getAlertRulesCollection().insertOne(doc as any);
    res.json({ id: result.insertedId, ...doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const v = validateBody(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const result = await getAlertRulesCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...v.doc, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Rule not found" });
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
    const result = await getAlertRulesCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { enabled: !!enabled, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Rule not found" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await getAlertRulesCollection().deleteOne({
      _id: new ObjectId(id),
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Rule not found" });
    }
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
