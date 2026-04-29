import { Router } from "express";
import { ObjectId } from "mongodb";
import { getSendLogCollection } from "../../db/mongo";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const filter: any = {};
    if (req.query.scheduleId && ObjectId.isValid(req.query.scheduleId as string)) {
      filter.scheduleId = new ObjectId(req.query.scheduleId as string);
    }
    const logs = await getSendLogCollection()
      .find(filter)
      .sort({ sentAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
