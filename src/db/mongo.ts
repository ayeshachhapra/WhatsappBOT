import { MongoClient, Db, Collection } from "mongodb";
import { config } from "../config";
import createLogger from "../utils/logger";
import {
  MessageDocument,
  GroupFiltersDocument,
  ScheduledMessageDocument,
  DraftDocument,
  SendLogDocument,
  AlertRuleDocument,
  AlertTriggerDocument,
  GroupRef,
  PurchaseOrderDocument,
} from "./schema";

const log = createLogger("DB");

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDb(): Promise<Db> {
  if (db) return db;

  log.info(
    `Connecting to MongoDB at ${config.mongodbUri.replace(/\/\/.*@/, "//***@")}...`
  );
  const start = Date.now();

  client = new MongoClient(config.mongodbUri);
  await client.connect();
  db = client.db(config.mongodbDbName);

  log.info(
    `Connected to database "${config.mongodbDbName}" in ${Date.now() - start}ms`
  );

  // Indexes
  const messages = db.collection<MessageDocument>("messages");
  await messages.createIndex({ msgId: 1 }, { unique: true });
  await messages.createIndex({ groupJid: 1, timestamp: -1 });
  await messages.createIndex({ timestamp: -1 });
  await messages.createIndex({ extractedAt: 1 });
  await messages.createIndex({ referenceNumbers: 1 });
  await messages.createIndex({ dueDate: 1 });
  await messages.createIndex({ senderJid: 1, timestamp: -1 });

  const schedules = db.collection<ScheduledMessageDocument>("scheduledMessages");
  await schedules.createIndex({ enabled: 1 });

  const drafts = db.collection<DraftDocument>("drafts");
  await drafts.createIndex({ status: 1, createdAt: -1 });
  await drafts.createIndex({ scheduleId: 1 });

  const sendLog = db.collection<SendLogDocument>("sendLog");
  await sendLog.createIndex({ sentAt: -1 });
  await sendLog.createIndex({ scheduleId: 1, sentAt: -1 });

  const alertRules = db.collection<AlertRuleDocument>("alertRules");
  await alertRules.createIndex({ enabled: 1 });

  const alertTriggers = db.collection<AlertTriggerDocument>("alertTriggers");
  await alertTriggers.createIndex({ acknowledged: 1, triggeredAt: -1 });
  await alertTriggers.createIndex({ ruleId: 1, triggeredAt: -1 });
  await alertTriggers.createIndex({ msgId: 1 });

  const purchaseOrders = db.collection<PurchaseOrderDocument>("purchaseOrders");
  await purchaseOrders.createIndex({ poNumber: 1 }, { unique: true });
  await purchaseOrders.createIndex({ status: 1 });
  await purchaseOrders.createIndex({ eta: 1 });
  await purchaseOrders.createIndex({ awaitingReply: 1 });

  log.info("Indexes ensured");
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not connected. Call connectDb() first.");
  return db;
}

export function getMessagesCollection(): Collection<MessageDocument> {
  return getDb().collection<MessageDocument>("messages");
}

export function getGroupFiltersCollection(): Collection<GroupFiltersDocument> {
  return getDb().collection<GroupFiltersDocument>("groupFilters");
}

export function getScheduledMessagesCollection(): Collection<ScheduledMessageDocument> {
  return getDb().collection<ScheduledMessageDocument>("scheduledMessages");
}

export function getDraftsCollection(): Collection<DraftDocument> {
  return getDb().collection<DraftDocument>("drafts");
}

export function getSendLogCollection(): Collection<SendLogDocument> {
  return getDb().collection<SendLogDocument>("sendLog");
}

export function getAlertRulesCollection(): Collection<AlertRuleDocument> {
  return getDb().collection<AlertRuleDocument>("alertRules");
}

export function getAlertTriggersCollection(): Collection<AlertTriggerDocument> {
  return getDb().collection<AlertTriggerDocument>("alertTriggers");
}

export function getPurchaseOrdersCollection(): Collection<PurchaseOrderDocument> {
  return getDb().collection<PurchaseOrderDocument>("purchaseOrders");
}

export async function getTrackedGroups(): Promise<GroupRef[]> {
  const doc = await getGroupFiltersCollection().findOne({ _id: "default" });
  return doc?.groups || [];
}

export async function setTrackedGroups(groups: GroupRef[]): Promise<void> {
  const seen = new Set<string>();
  const normalized: GroupRef[] = [];
  for (const g of groups) {
    const jid = (g?.jid || "").trim();
    const name = (g?.name || "").trim();
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    normalized.push({ jid, name });
  }
  await getGroupFiltersCollection().updateOne(
    { _id: "default" },
    { $set: { _id: "default", groups: normalized, updatedAt: new Date() } },
    { upsert: true }
  );
}

const VECTOR_INDEX_DEFINITION = {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 384,
      similarity: "cosine",
    },
    { type: "filter", path: "groupJid" },
    { type: "filter", path: "sentiment" },
    { type: "filter", path: "timestamp" },
  ],
};

export async function createVectorIndex(): Promise<void> {
  if (!db) throw new Error("Database not connected.");
  log.info("Creating/updating vector search index on messages...");

  try {
    await db.command({
      createSearchIndexes: "messages",
      indexes: [
        {
          name: "vector_index",
          type: "vectorSearch",
          definition: VECTOR_INDEX_DEFINITION,
        },
      ],
    });
    log.info("Vector search index created");
    return;
  } catch (err: any) {
    if (err.codeName === "IndexAlreadyExists" || err.code === 68) {
      log.info("Vector search index already exists, updating definition...");
    } else {
      log.warn("Could not create vector index (Atlas may be required)", err.message);
      return;
    }
  }

  try {
    await db.command({
      updateSearchIndex: "messages",
      name: "vector_index",
      definition: VECTOR_INDEX_DEFINITION,
    });
    log.info("Vector search index updated");
  } catch (updateErr: any) {
    log.warn("Could not update vector index", updateErr.message);
  }
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    log.info("Disconnecting from MongoDB...");
    await client.close();
    client = null;
    db = null;
  }
}

const RULES_SEEDED_KEY = "rulesSeeded";

const DEFAULT_RULES: Omit<AlertRuleDocument, "_id" | "createdAt" | "updatedAt">[] = [
  {
    name: "Delayed",
    keywords: [
      "delayed",
      "delay",
      "postponed",
      "pushed",
      "late",
      "hold up",
      "holdup",
      "behind schedule",
      "rescheduled",
    ],
    groupJids: [],
    enabled: true,
  },
  {
    name: "Needs follow-up",
    keywords: [
      "pending",
      "awaiting",
      "no update",
      "please confirm",
      "kindly update",
      "kindly confirm",
      "please share",
      "follow up",
      "any update",
      "checking in",
    ],
    groupJids: [],
    enabled: true,
  },
  {
    name: "On track",
    keywords: [
      "dispatched",
      "shipped",
      "in transit",
      "picked up",
      "on track",
      "eta confirmed",
      "out for delivery",
      "on the way",
      "delivered",
      "received",
    ],
    groupJids: [],
    enabled: true,
  },
];

/**
 * Seed default alert rules on first run so the Dashboard isn't empty out of the box.
 * Uses a settings flag so deleting all rules later doesn't bring the defaults back.
 */
export async function seedDefaultRulesIfNeeded(): Promise<void> {
  if (!db) return;
  const settings = db.collection("settings");
  const flag = await settings.findOne({ _id: RULES_SEEDED_KEY } as any);
  if (flag) return;

  const rulesCol = getAlertRulesCollection();
  const existing = await rulesCol.countDocuments();
  const now = new Date();

  if (existing === 0) {
    await rulesCol.insertMany(
      DEFAULT_RULES.map((r) => ({ ...r, createdAt: now, updatedAt: now })) as any
    );
    log.info(`Seeded ${DEFAULT_RULES.length} default alert rules`);
  } else {
    log.info(
      `Skipping default-rule seed — ${existing} rule(s) already exist; marking as seeded`
    );
  }

  await settings.updateOne(
    { _id: RULES_SEEDED_KEY } as any,
    { $set: { _id: RULES_SEEDED_KEY, value: true, seededAt: now } },
    { upsert: true }
  );
}

const POS_SEEDED_KEY = "purchaseOrdersSeeded";

/**
 * 10 demo purchase orders. ETAs are anchored to "now" at seed time so the
 * dashboard categorisation (late / on-track) is meaningful regardless of when
 * the user runs this. Statuses are a mix so all dashboard buckets light up.
 */
function buildDemoPurchaseOrders(now: Date): Omit<
  PurchaseOrderDocument,
  "_id" | "createdAt" | "updatedAt"
>[] {
  const day = (offset: number): Date =>
    new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
  return [
    {
      poNumber: "PO-1001",
      productName: "Steel sheets 10mm",
      companyName: "Acme Steel Ltd",
      eta: day(-4),
      status: "delayed",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1002",
      productName: "Aluminium rods 6m",
      companyName: "Bharat Metals",
      eta: day(3),
      status: "in_transit",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1003",
      productName: "Copper coil 50kg",
      companyName: "Vista Wires Co",
      eta: day(1),
      status: "ordered",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1004",
      productName: "HDPE polymer pellets",
      companyName: "Reliance Polymers",
      eta: day(9),
      status: "ordered",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1005",
      productName: "Stainless bolts M12",
      companyName: "Mumbai Fasteners",
      eta: day(-2),
      status: "delayed",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1006",
      productName: "Bearing 6204ZZ",
      companyName: "SKF Distributors",
      eta: day(4),
      status: "in_transit",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1007",
      productName: "Hydraulic oil 200L",
      companyName: "Lubrizol India",
      eta: day(13),
      status: "ordered",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1008",
      productName: "Electrical cable 16sqmm",
      companyName: "Polycab Cables",
      eta: day(2),
      status: "in_transit",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1009",
      productName: "PVC pipes 4 inch",
      companyName: "Astral Pipes",
      eta: day(7),
      status: "ordered",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
    {
      poNumber: "PO-1010",
      productName: "Welding rods E7018",
      companyName: "Esab India",
      eta: day(-3),
      status: "delivered",
      awaitingReply: false,
      lastUpdateMsgId: null,
      lastUpdateAt: null,
      notes: null,
    },
  ];
}

/**
 * Seed the 10 demo purchase orders on first run. Idempotent: a settings flag
 * prevents the seed from re-running after the user deletes a row, and the
 * unique index on `poNumber` skips any rows that already exist if someone
 * forces a re-seed.
 */
export async function seedDemoPurchaseOrdersIfNeeded(): Promise<void> {
  if (!db) return;
  const settings = db.collection("settings");
  const flag = await settings.findOne({ _id: POS_SEEDED_KEY } as any);
  if (flag) return;

  const now = new Date();
  const collection = getPurchaseOrdersCollection();
  const existing = await collection.countDocuments();

  if (existing === 0) {
    const docs = buildDemoPurchaseOrders(now).map((d) => ({
      ...d,
      createdAt: now,
      updatedAt: now,
    }));
    await collection.insertMany(docs as any);
    log.info(`Seeded ${docs.length} demo purchase orders`);
  } else {
    log.info(
      `Skipping demo PO seed — ${existing} purchase order(s) already exist; marking as seeded`
    );
  }

  await settings.updateOne(
    { _id: POS_SEEDED_KEY } as any,
    { $set: { _id: POS_SEEDED_KEY, value: true, seededAt: now } },
    { upsert: true }
  );
}

/**
 * Force re-seed (idempotent on poNumber via the unique index). Used by the
 * `/api/purchase-orders/seed-demo` endpoint when the user wants to refresh
 * dummy data — wipes existing rows first so ETAs are anchored to "now".
 */
export async function reseedDemoPurchaseOrders(): Promise<{
  inserted: number;
}> {
  const now = new Date();
  const collection = getPurchaseOrdersCollection();
  await collection.deleteMany({});
  const docs = buildDemoPurchaseOrders(now).map((d) => ({
    ...d,
    createdAt: now,
    updatedAt: now,
  }));
  await collection.insertMany(docs as any);
  if (db) {
    await db.collection("settings").updateOne(
      { _id: POS_SEEDED_KEY } as any,
      { $set: { _id: POS_SEEDED_KEY, value: true, seededAt: now } },
      { upsert: true }
    );
  }
  return { inserted: docs.length };
}
