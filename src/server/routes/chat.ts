import { Router } from "express";
import { chat, chatStream } from "../../ai/chat";
import createLogger from "../../utils/logger";

const log = createLogger("Route:chat");
const router = Router();

router.post("/", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }
    const result = await chat(message, Array.isArray(history) ? history : []);
    res.json(result);
  } catch (err: any) {
    log.error("Chat failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/stream", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    await chatStream(message, Array.isArray(history) ? history : [], (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.end();
  } catch (err: any) {
    log.error("Chat stream failed", { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "chunk", data: "\n\nSorry, an error occurred." })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    }
  }
});

export default router;
