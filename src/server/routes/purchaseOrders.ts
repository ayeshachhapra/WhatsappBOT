import { Router } from "express";
import { ObjectId } from "mongodb";
import {
  getMessagesCollection,
  getPurchaseOrdersCollection,
  reseedDemoPurchaseOrders,
} from "../../db/mongo";
import { PurchaseOrderStatus } from "../../db/schema";

const router = Router();

const VALID_STATUSES: PurchaseOrderStatus[] = [
  "ordered",
  "in_transit",
  "delayed",
  "delivered",
  "unknown",
];

router.get("/", async (_req, res) => {
  try {
    const orders = await getPurchaseOrdersCollection()
      .find({})
      .sort({ eta: 1, poNumber: 1 })
      .toArray();
    res.json({ orders });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/seed-demo", async (_req, res) => {
  try {
    const result = await reseedDemoPurchaseOrders();
    res.json({ message: `Seeded ${result.inserted} demo POs`, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { poNumber, productName, companyName, eta, status, notes } = req.body;
    if (!poNumber || typeof poNumber !== "string" || !poNumber.trim()) {
      return res.status(400).json({ error: "poNumber is required" });
    }
    if (!productName || typeof productName !== "string") {
      return res.status(400).json({ error: "productName is required" });
    }
    if (!companyName || typeof companyName !== "string") {
      return res.status(400).json({ error: "companyName is required" });
    }
    const cleanStatus: PurchaseOrderStatus =
      typeof status === "string" && VALID_STATUSES.includes(status as any)
        ? (status as PurchaseOrderStatus)
        : "ordered";
    const cleanEta = eta ? new Date(eta) : null;
    if (cleanEta && isNaN(cleanEta.getTime())) {
      return res.status(400).json({ error: "eta is not a valid date" });
    }
    const now = new Date();
    const collection = getPurchaseOrdersCollection();
    try {
      const result = await collection.insertOne({
        poNumber: poNumber.trim(),
        productName: productName.trim(),
        companyName: companyName.trim(),
        eta: cleanEta,
        status: cleanStatus,
        awaitingReply: false,
        lastUpdateMsgId: null,
        lastUpdateAt: null,
        notes: typeof notes === "string" ? notes : null,
        createdAt: now,
        updatedAt: now,
      });
      res.json({ id: result.insertedId.toString() });
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "poNumber already exists" });
      }
      throw err;
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const po = await getPurchaseOrdersCollection().findOne({ _id: new ObjectId(id) });
    if (!po) return res.status(404).json({ error: "Not found" });
    // Pull the message timeline that mentions this PO
    const messages = await getMessagesCollection()
      .find(
        {
          referenceNumbers: {
            $regex: `^${escapeRegex(po.poNumber)}$`,
            $options: "i",
          },
        },
        { projection: { embedding: 0 } }
      )
      .sort({ timestamp: 1 })
      .limit(200)
      .toArray();
    res.json({ purchaseOrder: po, messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const { productName, companyName, eta, status, notes } = req.body;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof productName === "string") set.productName = productName.trim();
    if (typeof companyName === "string") set.companyName = companyName.trim();
    if (eta === null) set.eta = null;
    else if (eta !== undefined) {
      const d = new Date(eta);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "eta is not a valid date" });
      set.eta = d;
    }
    if (typeof status === "string") {
      if (!VALID_STATUSES.includes(status as any)) {
        return res.status(400).json({ error: "invalid status" });
      }
      set.status = status;
    }
    if (typeof notes === "string" || notes === null) set.notes = notes;
    const result = await getPurchaseOrdersCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: set },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const result = await getPurchaseOrdersCollection().deleteOne({
      _id: new ObjectId(id),
    });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
