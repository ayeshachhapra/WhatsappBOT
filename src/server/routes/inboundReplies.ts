import { Router } from "express";
import { ObjectId } from "mongodb";
import {
  getEmailFollowUpsCollection,
  getSupplierRepliesCollection,
} from "../../db/mongo";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { matched } = req.query;
    const filter: Record<string, unknown> = {};
    if (matched === "true") filter.isMatched = true;
    if (matched === "false") filter.isMatched = false;

    const replies = await getSupplierRepliesCollection()
      .find(filter)
      .sort({ receivedAt: -1 })
      .limit(200)
      .toArray();

    const followUpIds = Array.from(
      new Set(
        replies
          .map((r) => r.followUpId?.toString())
          .filter((s): s is string => !!s)
      )
    ).map((s) => new ObjectId(s));

    const followUps = followUpIds.length
      ? await getEmailFollowUpsCollection()
          .find({ _id: { $in: followUpIds } })
          .toArray()
      : [];
    const followUpsById = new Map(
      followUps.map((f) => [f._id!.toString(), f])
    );

    const enriched = replies.map((r) => ({
      ...r,
      followUp:
        r.followUpId && followUpsById.get(r.followUpId.toString())
          ? followUpsById.get(r.followUpId.toString())
          : null,
    }));

    res.json({ replies: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
