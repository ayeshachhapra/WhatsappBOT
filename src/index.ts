import { config } from "./config";
import {
  connectDb,
  createVectorIndex,
  disconnectDb,
  seedDefaultRulesIfNeeded,
} from "./db/mongo";
import { whatsapp } from "./whatsapp/manager";
import { startScheduler, stopScheduler } from "./scheduler";
import { startHttpServer } from "./server";
import createLogger from "./utils/logger";

const log = createLogger("Bootstrap");

async function main() {
  log.info("Starting WATracker...");
  log.info(
    `Config: port=${config.port}, db=${config.mongodbDbName}, tz=${config.timezone}`
  );

  await connectDb();
  await createVectorIndex();
  await seedDefaultRulesIfNeeded();

  const server = startHttpServer();
  startScheduler();

  if (config.whatsappAutoConnect) {
    log.info("Auto-connecting WhatsApp...");
    whatsapp.connect().catch((err) =>
      log.error("Initial WhatsApp connect failed", { error: err.message })
    );
  } else {
    log.info("WHATSAPP_AUTO_CONNECT=false — start manually via /api/whatsapp/connect");
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down gracefully`);
    stopScheduler();
    try {
      await whatsapp.shutdown();
    } catch (err: any) {
      log.warn("WhatsApp shutdown error", { error: err.message });
    }
    server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("Fatal startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
