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
