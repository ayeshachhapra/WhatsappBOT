import { Router } from "express";
import { whatsapp } from "../../whatsapp/manager";
import createLogger from "../../utils/logger";

const log = createLogger("Route:whatsapp");
const router = Router();

router.get("/status", (_req, res) => {
  res.json({ ...whatsapp.stats, qr: whatsapp.qrDataUrl });
});

router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ ...whatsapp.stats, qr: whatsapp.qrDataUrl });
  const onStatus = (event: any) => send(event);
  whatsapp.on("status", onStatus);
  req.on("close", () => {
    whatsapp.off("status", onStatus);
  });
});

router.post("/connect", async (_req, res) => {
  try {
    if (whatsapp.status === "ready") {
      return res.json({ message: "Already connected" });
    }
    whatsapp.resetReconnectAttempts();
    whatsapp.connect().catch((err) =>
      log.error("WhatsApp connect failed", { error: err.message })
    );
    res.json({ message: "Connecting..." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/disconnect", async (_req, res) => {
  try {
    await whatsapp.disconnect();
    res.json({ message: "Disconnected" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/logout", async (_req, res) => {
  try {
    await whatsapp.disconnect();
    await whatsapp.clearAuthSession();
    res.json({ message: "Logged out — auth cleared" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/groups", async (_req, res) => {
  try {
    const groups = await whatsapp.fetchAllGroups();
    res.json({ groups });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
