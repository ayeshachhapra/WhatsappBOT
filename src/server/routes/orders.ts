import { Router } from "express";
import { getMessagesCollection } from "../../db/mongo";

const router = Router();

const RESOLVED_RE =
  /\b(delivered|received|completed|done|pod|signed|closed)\b/i;
const DISPATCHED_RE =
  /\b(dispatch|dispatched|shipped|out for delivery|in transit|picked up|left)\b/i;
const DELAYED_RE =
  /\b(delay|delayed|late|hold|stuck|pending)\b/i;

type OrderStatus = "delivered" | "in_transit" | "delayed" | "ordered" | "unknown";

interface OrderSummary {
  ref: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  groups: { jid: string; name: string }[];
  senders: string[];
  dueDate: Date | null;
  status: OrderStatus;
  lastBody: string;
}

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const collection = getMessagesCollection();
    const aggregated = await collection
      .aggregate([
        { $match: { referenceNumbers: { $exists: true, $ne: [] } } },
        { $unwind: "$referenceNumbers" },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: { $toUpper: "$referenceNumbers" },
            displayRef: { $first: "$referenceNumbers" },
            count: { $sum: 1 },
            firstAt: { $min: "$timestamp" },
            lastAt: { $max: "$timestamp" },
            groups: { $addToSet: { jid: "$groupJid", name: "$groupName" } },
            senders: { $addToSet: "$sender" },
            dueDates: { $push: "$dueDate" },
            bodies: { $push: "$body" },
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: limit },
      ])
      .toArray();

    const summaries: OrderSummary[] = aggregated.map((row) => {
      const dues = (row.dueDates as (Date | null)[])
        .filter((d): d is Date => !!d)
        .map((d) => new Date(d).getTime());
      const dueDate = dues.length > 0 ? new Date(Math.max(...dues)) : null;
      const lastBody = (row.bodies as string[])[0] || "";
      let status: OrderStatus = "unknown";
      const allText = (row.bodies as string[]).join(" ");
      if (RESOLVED_RE.test(allText)) status = "delivered";
      else if (DISPATCHED_RE.test(allText)) status = "in_transit";
      else if (DELAYED_RE.test(allText)) status = "delayed";
      else if (row.count > 0) status = "ordered";
      return {
        ref: row.displayRef,
        count: row.count,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        groups: row.groups,
        senders: row.senders,
        dueDate,
        status,
        lastBody: lastBody.slice(0, 250),
      };
    });

    res.json({ orders: summaries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:ref", async (req, res) => {
  try {
    const ref = decodeURIComponent(req.params.ref);
    const messages = await getMessagesCollection()
      .find(
        { referenceNumbers: { $regex: `^${escapeRegex(ref)}$`, $options: "i" } },
        { projection: { embedding: 0 } }
      )
      .sort({ timestamp: 1 })
      .limit(500)
      .toArray();
    res.json({ ref, messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
