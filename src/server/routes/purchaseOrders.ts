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
    // Pull the message timeline that mentions this PO. References often arrive
    // as "1008" or "PO 1008" while the master row is "PO-1008".
    const candidates = await getMessagesCollection()
      .find(
        {
          $or: [
            { "referenceNumbers.0": { $exists: true } },
            ...(po.lastUpdateMsgId ? [{ msgId: po.lastUpdateMsgId }] : []),
          ],
        },
        { projection: { embedding: 0 } }
      )
      .sort({ timestamp: 1 })
      .toArray();
    const messages = candidates
      .filter(
        (m) =>
          m.msgId === po.lastUpdateMsgId ||
          (m.referenceNumbers || []).some((ref) => refsMatchPo(ref, po.poNumber))
      )
      .slice(-200);
    res.json({ purchaseOrder: po, messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    const { productName, companyName, eta, status, notes, supplierEmail, supplierName } =
      req.body;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, unknown> = {};
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
    if (typeof supplierEmail === "string") {
      const trimmed = supplierEmail.trim();
      if (!trimmed) {
        unset.supplierEmail = "";
      } else {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          return res.status(400).json({ error: "supplierEmail is not a valid email" });
        }
        set.supplierEmail = trimmed;
      }
    } else if (supplierEmail === null) {
      unset.supplierEmail = "";
    }
    if (typeof supplierName === "string") {
      const trimmed = supplierName.trim();
      if (!trimmed) unset.supplierName = "";
      else set.supplierName = trimmed;
    } else if (supplierName === null) {
      unset.supplierName = "";
    }
    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const result = await getPurchaseOrdersCollection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      update,
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

function refsMatchPo(refOrText: string, poNumber: string): boolean {
  const refNorm = refOrText.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const poNorm = poNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!refNorm || !poNorm) return false;
  if (refNorm === poNorm || refNorm.includes(poNorm)) return true;

  const refDigits = refOrText.replace(/\D/g, "");
  const poDigits = poNumber.replace(/\D/g, "");
  return refDigits.length >= 4 && poDigits.length >= 4 && refDigits.includes(poDigits);
}

export default router;
