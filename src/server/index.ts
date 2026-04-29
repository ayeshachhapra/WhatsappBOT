import express from "express";
import cors from "cors";
import path from "path";
import { config } from "../config";
import createLogger from "../utils/logger";

import whatsappRoutes from "./routes/whatsapp";
import groupsRoutes from "./routes/groups";
import messagesRoutes from "./routes/messages";
import chatRoutes from "./routes/chat";
import schedulesRoutes from "./routes/schedules";
import draftsRoutes from "./routes/drafts";
import sendLogRoutes from "./routes/sendLog";
import alertsRoutes from "./routes/alerts";
import threadsRoutes from "./routes/threads";
import autoChaseRoutes from "./routes/autoChase";
import ordersRoutes from "./routes/orders";
import sendersRoutes from "./routes/senders";
import alertRulesRoutes from "./routes/alertRules";
import alertTriggersRoutes from "./routes/alertTriggers";

const log = createLogger("Server");

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      log[level](`${req.method} ${req.url} → ${status} (${duration}ms)`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api/whatsapp", whatsappRoutes);
  app.use("/api/groups", groupsRoutes);
  app.use("/api/messages", messagesRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/schedules", schedulesRoutes);
  app.use("/api/drafts", draftsRoutes);
  app.use("/api/send-log", sendLogRoutes);
  app.use("/api/alerts", alertsRoutes);
  app.use("/api/threads", threadsRoutes);
  app.use("/api/auto-chase", autoChaseRoutes);
  app.use("/api/orders", ordersRoutes);
  app.use("/api/senders", sendersRoutes);
  app.use("/api/alert-rules", alertRulesRoutes);
  app.use("/api/alert-triggers", alertTriggersRoutes);

  // Serve built frontend in production
  const frontendPath = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });

  return app;
}

export function startHttpServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    log.info(`API listening on http://localhost:${config.port}`);
  });
}
