import { Router } from "express";
import { ObjectId } from "mongodb";
import { getAlertTriggersCollection } from "../../db/mongo";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const acknowledged =
      req.query.acknowledged === "true"
        ? true
        : req.query.acknowledged === "false"
        ? false
        : undefined;
    const filter: any = {};
    if (acknowledged !== undefined) filter.acknowledged = acknowledged;
    const triggers = await getAlertTriggersCollection()
      .find(filter)
      .sort({ triggeredAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ triggers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/ack", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await getAlertTriggersCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { acknowledged: true, acknowledgedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Trigger not found" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/ack-all", async (_req, res) => {
  try {
    const result = await getAlertTriggersCollection().updateMany(
      { acknowledged: false },
      { $set: { acknowledged: true, acknowledgedAt: new Date() } }
    );
    res.json({ ackd: result.modifiedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
