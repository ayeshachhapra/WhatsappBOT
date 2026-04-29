/**
 * Wipe all message-derived chat data so the system can start fresh.
 *
 * Wipes:        messages, alertTriggers, drafts, sendLog
 * Resets:       purchaseOrders.{lastUpdateMsgId, lastUpdateAt, awaitingReply}
 * Preserves:    purchaseOrders rows, groupFilters, alertRules, scheduledMessages, settings
 *
 * Run with:  npx ts-node src/scripts/reset-chat-data.ts
 */
import { connectDb, disconnectDb, getDb } from "../db/mongo";

async function main() {
  console.log("Connecting to MongoDB...");
  await connectDb();
  const db = getDb();

  const wipe = ["messages", "alertTriggers", "drafts", "sendLog"];
  const counts: Record<string, number> = {};

  for (const name of wipe) {
    const before = await db.collection(name).estimatedDocumentCount();
    if (before === 0) {
      counts[name] = 0;
      continue;
    }
    const result = await db.collection(name).deleteMany({});
    counts[name] = result.deletedCount;
  }

  // Reset PO fields that pointed at messages we just deleted.
  const poReset = await db.collection("purchaseOrders").updateMany(
    {},
    {
      $set: {
        lastUpdateMsgId: null,
        lastUpdateAt: null,
        awaitingReply: false,
        updatedAt: new Date(),
      },
    }
  );

  console.log("\nDeleted:");
  for (const name of wipe) {
    console.log(`  ${name.padEnd(20)} ${counts[name]} doc(s)`);
  }
  console.log(`\nReset purchaseOrders fields on ${poReset.modifiedCount} row(s).`);
  console.log("\nDone. Start the bot and you'll see a clean message log.");

  await disconnectDb();
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
