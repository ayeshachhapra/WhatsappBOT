import type {
  WASocket,
  WAMessage,
  ConnectionState,
  AuthenticationState,
} from "@whiskeysockets/baileys";

const esmImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<typeof import("@whiskeysockets/baileys")>;

let _baileys: typeof import("@whiskeysockets/baileys") | null = null;
async function getBaileys() {
  if (!_baileys) _baileys = await esmImport("@whiskeysockets/baileys");
  return _baileys;
}

import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import { EventEmitter } from "events";
import { config } from "../config";
import { useMongoDBAuthState } from "./auth-state-mongo";
import { getDb, getTrackedGroups } from "../db/mongo";
import { queueMessage, IncomingMessage } from "../pipeline";
import createLogger from "../utils/logger";

const log = createLogger("WhatsApp");

const baileysLogger = pino({ level: "silent" });

const MAX_DEDUP_IDS = 1000;
const WATCHDOG_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const WATCHDOG_SILENCE_THRESHOLD_MS = 15 * 60 * 1000;
const RECONNECT_BASE_DELAY_MS = 5 * 1000;
const RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;

export type WhatsAppStatus =
  | "disconnected"
  | "qr_ready"
  | "connecting"
  | "authenticated"
  | "ready"
  | "auth_failure";

export interface StatusEvent {
  status: WhatsAppStatus;
  qr?: string;
  message?: string;
}

function getMessageBody(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    null
  );
}

function getMessageType(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "empty";
  if (m.conversation) return "conversation";
  if (m.extendedTextMessage) return "extendedText";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.documentMessage) return "document";
  if (m.documentWithCaptionMessage) return "documentWithCaption";
  if (m.stickerMessage) return "sticker";
  if (m.audioMessage) return "audio";
  if (m.contactMessage) return "contact";
  if (m.locationMessage) return "location";
  if (m.reactionMessage) return "reaction";
  if (m.protocolMessage) return "protocol";
  return "unknown(" + Object.keys(m).join(",") + ")";
}

function isSupportedMessage(msg: WAMessage): boolean {
  const m = msg.message;
  if (!m) return false;
  return !!(
    m.conversation ||
    m.extendedTextMessage ||
    m.imageMessage ||
    m.videoMessage ||
    m.documentMessage ||
    m.documentWithCaptionMessage
  );
}

function isImageMessage(msg: WAMessage): boolean {
  return !!msg.message?.imageMessage;
}

function getImageMimeType(msg: WAMessage): string {
  return msg.message?.imageMessage?.mimetype || "image/jpeg";
}

function unwrapMessageContent(
  content: WAMessage["message"]
): { inner: WAMessage["message"]; wrappers: string[] } {
  const wrappers: string[] = [];
  let current = content;
  while (current) {
    if (current.ephemeralMessage?.message) {
      wrappers.push("ephemeral");
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      wrappers.push("viewOnce");
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      wrappers.push("viewOnceV2");
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      wrappers.push("viewOnceV2Ext");
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      wrappers.push("docWithCaption");
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message) {
      wrappers.push("edited");
      current = current.editedMessage.message;
    } else {
      break;
    }
  }
  return { inner: current, wrappers };
}

const AUTH_COLLECTION = "whatsapp-auth";
const LOCAL_AUTH_DIR = ".wa_auth";

export class WhatsAppManager extends EventEmitter {
  private sock: WASocket | null = null;
  private _status: WhatsAppStatus = "disconnected";
  private _qrDataUrl: string | null = null;
  private lastStatusMessage = "";
  private messageCount = 0;
  private droppedCount = 0;
  private errorCount = 0;
  private rawEventCount = 0;
  private reconnectAttempts = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connecting = false;
  private _shuttingDown = false;
  private connectStartTime = 0;
  private lastEventTime = Date.now();
  private saveCreds: (() => Promise<void>) | null = null;
  private processedIds = new Set<string>();
  private processingIds = new Set<string>();
  private groupNameCache = new Map<string, string>();

  get status(): WhatsAppStatus {
    return this._status;
  }

  get qrDataUrl(): string | null {
    return this._qrDataUrl;
  }

  get stats() {
    return {
      status: this._status,
      message: this.lastStatusMessage,
      messageCount: this.messageCount,
      droppedCount: this.droppedCount,
      errorCount: this.errorCount,
      rawEventCount: this.rawEventCount,
    };
  }

  get isReady(): boolean {
    return this._status === "ready" && this.sock !== null;
  }

  /**
   * Identity of the connected user — used to map older stored messages
   * (whose `sender` is the user's pushName, not "You") back to the user.
   */
  getOwnIdentity(): { jids: string[]; phoneDigits: string[]; name: string | null } {
    const u = (this.sock?.user as any) || null;
    if (!u) return { jids: [], phoneDigits: [], name: null };
    const jids: string[] = [];
    if (u.id) jids.push(u.id);
    if (u.lid) jids.push(u.lid);
    const phoneDigits = jids
      .map((j) => j.split("@")[0].split(":")[0])
      .filter(Boolean);
    return { jids, phoneDigits, name: u.name || null };
  }

  /**
   * If `jid` is an `@lid`, ask the target group's live metadata for the
   * matching participant's phone JID (`<digits>@s.whatsapp.net`). Returns
   * null when the group can't be fetched, the participant isn't found, or
   * the participant has no phone JID exposed (rare). Best-effort — never
   * throws; logs and returns null on failure so the caller can drop the
   * mention silently.
   */
  private async tryUpgradeLidToPhone(
    groupJid: string,
    jid: string
  ): Promise<string | null> {
    if (!this.sock) return null;
    if (!jid.toLowerCase().endsWith("@lid")) return null;
    if (!groupJid.endsWith("@g.us")) return null;
    try {
      const meta = await this.sock.groupMetadata(groupJid);
      const participants: any[] = (meta as any).participants || [];
      const lidDigits = jid.split("@")[0].split(":")[0];
      const match = participants.find((p) => {
        const candidates: string[] = [];
        if (p.lid) candidates.push(p.lid);
        if (p.id) candidates.push(p.id);
        if (p.jid) candidates.push(p.jid);
        return candidates.some((c) => {
          const d = String(c).split("@")[0].split(":")[0];
          return d === lidDigits;
        });
      });
      if (!match) return null;
      const phoneCandidates = [match.phoneNumber, match.id, match.jid].filter(
        (x) =>
          typeof x === "string" && x.toLowerCase().endsWith("@s.whatsapp.net")
      );
      return phoneCandidates[0] || null;
    } catch (err: any) {
      log.warn(`tryUpgradeLidToPhone failed for ${jid}: ${err.message}`);
      return null;
    }
  }

  private setStatus(status: WhatsAppStatus, extra?: Partial<StatusEvent>): void {
    this._status = status;
    this.lastStatusMessage = extra?.message || "";
    const event: StatusEvent = { status, ...extra };
    this.emit("status", event);
    log.info(`[status] ${status}${extra?.message ? ` — ${extra.message}` : ""}`);
  }

  private noteActivity(): void {
    this.lastEventTime = Date.now();
  }

  private resetTransientState(): void {
    this.processedIds.clear();
    this.processingIds.clear();
    this.groupNameCache.clear();
    this.rawEventCount = 0;
  }

  private rememberProcessedId(msgId: string): void {
    this.processedIds.add(msgId);
    if (this.processedIds.size > MAX_DEDUP_IDS) {
      const first = this.processedIds.values().next().value;
      if (first) this.processedIds.delete(first);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      log.info(
        `[heartbeat] status=${this._status} msgs=${this.messageCount} dropped=${this.droppedCount} errors=${this.errorCount} raw=${this.rawEventCount}`
      );
    }, 60000);
  }

  private startWatchdog(): void {
    if (this.watchdogInterval) return;
    this.watchdogInterval = setInterval(() => {
      if (this._status !== "ready" || !this.sock) return;
      const silentMs = Date.now() - this.lastEventTime;
      if (silentMs < WATCHDOG_SILENCE_THRESHOLD_MS) return;
      const silentMinutes = Math.round(silentMs / 60000);
      log.warn(
        `[watchdog] No WhatsApp activity for ${silentMinutes} minutes - staying connected.`
      );
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  private async createAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    const isDeployed =
      config.mongodbUri &&
      !config.mongodbUri.includes("localhost") &&
      !config.mongodbUri.includes("127.0.0.1");

    log.info(`[auth] Strategy: isDeployed=${isDeployed}`);

    if (isDeployed) {
      log.info(`[auth] Using MongoDB auth state (collection: ${AUTH_COLLECTION})`);
      try {
        const collection = getDb().collection(AUTH_COLLECTION);
        const authState = await useMongoDBAuthState(collection);
        log.info("[auth] MongoDB auth state ready");
        return authState;
      } catch (err: any) {
        log.error("[auth] MongoDB auth failed, falling back to local file auth", {
          error: err.message,
        });
      }
    }

    log.info(`[auth] Using local file auth state (dir: ${LOCAL_AUTH_DIR})`);
    const { useMultiFileAuthState } = await getBaileys();
    return await useMultiFileAuthState(LOCAL_AUTH_DIR);
  }

  private async getGroupName(jid: string): Promise<string> {
    const cached = this.groupNameCache.get(jid);
    if (cached) return cached;
    try {
      if (!this.sock) return jid;
      const metadata = await this.sock.groupMetadata(jid);
      const name = metadata.subject || jid;
      this.groupNameCache.set(jid, name);
      return name;
    } catch (err: any) {
      log.warn(`Failed to fetch group metadata for ${jid}`, { error: err.message });
      return jid;
    }
  }

  private async handleMessage(msg: WAMessage): Promise<void> {
    this.rawEventCount++;
    this.noteActivity();

    const { inner, wrappers } = unwrapMessageContent(msg.message);
    if (wrappers.length > 0) {
      log.info(`[unwrap] Wrappers: [${wrappers.join(" → ")}]`);
      msg.message = inner;
    }

    const msgId = msg.key.id || `unknown_${Date.now()}`;
    const chatId = msg.key.remoteJid || "";
    const isGroup = chatId.endsWith("@g.us");
    const msgType = getMessageType(msg);
    const body = getMessageBody(msg);

    if (!isGroup) {
      this.droppedCount++;
      return;
    }
    if (this.processedIds.has(msgId) || this.processingIds.has(msgId)) {
      return;
    }
    this.processingIds.add(msgId);

    try {
      const isImage = isImageMessage(msg);

      if (!isSupportedMessage(msg) && !isImage) {
        this.droppedCount++;
        this.rememberProcessedId(msgId);
        return;
      }

      const chatName = await this.getGroupName(chatId);
      const tracked = await getTrackedGroups();

      if (tracked.length === 0) {
        log.info(`[filter] No tracked groups configured — dropping "${chatName}"`);
        this.droppedCount++;
        this.rememberProcessedId(msgId);
        return;
      }

      const isTracked = tracked.some((g) => g.jid === chatId);
      if (!isTracked) {
        this.droppedCount++;
        this.rememberProcessedId(msgId);
        return;
      }

      // Allow image messages with no caption — they'll go through OCR.
      if ((!body || body.trim().length === 0) && !isImage) {
        this.droppedCount++;
        this.rememberProcessedId(msgId);
        return;
      }

      const fromMe = !!msg.key.fromMe;

      // Prefer the phone JID (`@s.whatsapp.net`) over the LID (`@lid`) so that
      // outbound @-mentions actually render as tags in WhatsApp. Newer Baileys
      // versions expose `participantPn` (and sometimes `senderPn`) on the key /
      // message; fall back to whatever is available.
      const keyAny = msg.key as any;
      const msgAny = msg as any;
      const sockUserAny = this.sock?.user as any;
      const ownJid =
        sockUserAny?.id ||
        sockUserAny?.lid ||
        "self";
      const ownName = sockUserAny?.name;

      const senderName = fromMe
        ? "You"
        : msg.pushName || msg.key.participant || msg.key.remoteJid || "unknown";

      const senderJid = fromMe
        ? ownJid
        : keyAny.participantPn ||
          msgAny.participantPn ||
          keyAny.senderPn ||
          msgAny.senderPn ||
          msg.key.participant ||
          msg.key.remoteJid ||
          "unknown";

      void ownName; // referenced for clarity even when unused

      const timestamp = msg.messageTimestamp
        ? new Date(
            typeof msg.messageTimestamp === "number"
              ? msg.messageTimestamp * 1000
              : Number(msg.messageTimestamp) * 1000
          )
        : new Date();

      // Download image bytes if this is an image message
      let imageBytes: Buffer | undefined;
      let imageMimeType: string | undefined;
      if (isImage) {
        try {
          const baileys = await getBaileys();
          const buf = await baileys.downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: baileysLogger as any, reuploadRequest: this.sock!.updateMediaMessage }
          );
          if (buf && Buffer.isBuffer(buf)) {
            imageBytes = buf;
            imageMimeType = getImageMimeType(msg);
            log.info(
              `[image] Downloaded ${buf.length} bytes (${imageMimeType}) from ${chatName}`
            );
          }
        } catch (err: any) {
          log.warn(`[image] Download failed for ${msgId}: ${err.message}`);
        }
      }

      const incoming: IncomingMessage = {
        msgId,
        groupJid: chatId,
        groupName: chatName,
        sender: senderName,
        senderJid,
        fromMe,
        body: body || "",
        messageType: msgType,
        timestamp,
        imageBytes,
        imageMimeType,
      };

      this.messageCount++;
      log.info(
        `[accept] msg #${this.messageCount} from "${senderName}" in "${chatName}": "${body.substring(0, 120)}"`
      );
      this.emit("message", incoming);

      try {
        const result = await queueMessage(incoming);
        if (result.stored) {
          log.info(`[pipeline] stored — id=${result.msgId}`);
        } else {
          log.info(`[pipeline] skipped — reason=${result.reason}`);
        }
        this.rememberProcessedId(msgId);
      } catch (err: any) {
        this.errorCount++;
        log.error(`[pipeline] crashed`, { error: err.message, stack: err.stack });
      }
    } catch (err: any) {
      this.errorCount++;
      log.error(`handleMessage crashed (id=${msgId})`, {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      this.processingIds.delete(msgId);
    }
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(delay: number, context: string): void {
    this.clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._status !== "disconnected") return;
      this.connect().catch((err) => {
        log.error(`[auto-reconnect] ${context} failed`, { error: err.message });
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const { DisconnectReason } = await getBaileys();
    this.noteActivity();

    if (qr) {
      const elapsed = Date.now() - this.connectStartTime;
      log.info(`[lifecycle] QR received (${elapsed}ms since connect)`);
      try {
        this._qrDataUrl = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        this.setStatus("qr_ready", { qr: this._qrDataUrl ?? undefined });
      } catch (err: any) {
        log.error("[lifecycle] QR generation failed", { error: err.message });
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reason =
        (lastDisconnect?.error as Boom)?.output?.payload?.message ||
        lastDisconnect?.error?.message ||
        "unknown";

      log.warn(`[lifecycle] CLOSED: code=${statusCode} reason="${reason}"`);
      this.cleanupSocket();
      this._connecting = false;

      if (this._shuttingDown) {
        this.setStatus("disconnected", { message: "Shut down" });
        this.stopTimers();
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        log.error("[lifecycle] LOGGED OUT - clearing credentials");
        await this.clearAuthSession();
        this.setStatus("auth_failure", { message: "Logged out. Scan QR again." });
        this.stopTimers();
        return;
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        this.setStatus("disconnected", { message: "Replaced by another session" });
        this.stopTimers();
        if (config.whatsappReconnectOnConflict) {
          this.scheduleReconnect(10000, "Connection replaced");
        }
      } else {
        this.reconnectAttempts++;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
          RECONNECT_MAX_DELAY_MS
        );
        log.info(
          `[lifecycle] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
        );
        this.setStatus("disconnected", {
          message: `Reconnecting in ${Math.round(delay / 1000)}s...`,
        });
        this.stopTimers();
        this.scheduleReconnect(delay, `Attempt #${this.reconnectAttempts}`);
      }
    }

    if (connection === "open") {
      const elapsed = Date.now() - this.connectStartTime;
      this._qrDataUrl = null;
      this.reconnectAttempts = 0;
      this.setStatus("ready");
      log.info(`[lifecycle] READY (${elapsed}ms since connect)`);
      this.startHeartbeat();
      this.startWatchdog();
    }
  }

  private cleanupSocket(): void {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners("connection.update");
        this.sock.ev.removeAllListeners("creds.update");
        this.sock.ev.removeAllListeners("messages.upsert");
      } catch {}
      this.sock = null;
    }
  }

  async connect(): Promise<void> {
    if (this._connecting) {
      log.warn(`connect() ignored - already connecting`);
      return;
    }
    this.cleanupSocket();
    this._connecting = true;
    this.clearReconnectTimer();
    this._shuttingDown = false;
    this.connectStartTime = Date.now();
    this.resetTransientState();
    this.setStatus("connecting");

    log.info("WhatsApp connection sequence starting (Baileys)...");

    try {
      const baileys = await getBaileys();

      let waVersion: [number, number, number] | undefined;
      try {
        const { version } = await baileys.fetchLatestBaileysVersion();
        waVersion = version;
        log.info(`WA Web version: ${version.join(".")}`);
      } catch (err: any) {
        log.warn("Failed to fetch WA version, using default", { error: err.message });
      }

      const { state, saveCreds } = await this.createAuthState();
      this.saveCreds = saveCreds;

      this.sock = baileys.default({
        auth: {
          creds: state.creds,
          keys: baileys.makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        version: waVersion,
        browser: ["WATracker", "Chrome", "20.0.04"],
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
      });
      this._connecting = false;

      this.sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
        void this.handleConnectionUpdate(update);
      });

      this.sock.ev.on("creds.update", async () => {
        this.noteActivity();
        if (this.saveCreds) await this.saveCreds();
      });

      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        // "notify" = new messages received from the network.
        // "append" = messages added to history — typically self-sent messages
        //            from the user's primary phone (when WA Web is linked).
        // We process both so that follow-ups the user types from their own
        // phone get captured and the AI knows what's already been said.
        if (type !== "notify" && type !== "append") return;
        for (const msg of messages) {
          void this.handleMessage(msg);
        }
      });
    } catch (err: any) {
      this.cleanupSocket();
      this._connecting = false;
      this.stopTimers();
      this.setStatus("disconnected", { message: err.message || "connection failed" });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._shuttingDown = true;
    this.clearReconnectTimer();
    this.stopTimers();
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try {
          this.sock.end(undefined);
        } catch {}
      }
    }
    this.cleanupSocket();
    this.setStatus("disconnected", { message: "Manually disconnected" });
  }

  async shutdown(): Promise<void> {
    log.info("[lifecycle] Shutting down gracefully...");
    this._shuttingDown = true;
    this.clearReconnectTimer();
    this.stopTimers();
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {}
    }
    this.cleanupSocket();
    this.setStatus("disconnected", { message: "Server shutdown" });
  }

  async clearAuthSession(): Promise<void> {
    const isDeployed =
      config.mongodbUri &&
      !config.mongodbUri.includes("localhost") &&
      !config.mongodbUri.includes("127.0.0.1");

    if (isDeployed) {
      try {
        await getDb().collection(AUTH_COLLECTION).deleteMany({});
        log.info(`Cleared MongoDB auth session (${AUTH_COLLECTION})`);
      } catch (err: any) {
        log.warn("Failed to clear MongoDB auth session", { error: err.message });
      }
    } else {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const authDir = path.join(process.cwd(), LOCAL_AUTH_DIR);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          log.info("Cleared local auth session");
        }
      } catch (err: any) {
        log.warn("Failed to clear local auth session", { error: err.message });
      }
    }
  }

  async sendTextMessage(
    jid: string,
    text: string,
    mentions?: Array<string | { jid: string; name?: string }>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.sock || this._status !== "ready") {
      return { success: false, error: "WhatsApp not connected" };
    }
    try {
      // Normalise to { jid, name? } objects, supporting the legacy plain-string form.
      const normalised = (mentions || [])
        .map((m) =>
          typeof m === "string"
            ? { jid: m, name: undefined }
            : m && typeof m === "object" && typeof m.jid === "string"
            ? { jid: m.jid, name: typeof m.name === "string" ? m.name : undefined }
            : null
        )
        .filter((m): m is { jid: string; name: string | undefined } => !!m && m.jid.includes("@"));

      // Only `@s.whatsapp.net` phone JIDs render as proper mention pills in WA.
      // `@lid` JIDs do not render — but before dropping them, try to upgrade
      // each one to a phone JID by inspecting the target group's live
      // participant list (Baileys exposes phone + LID per participant).
      const upgraded: { jid: string; name: string | undefined }[] = [];
      for (const m of normalised) {
        if (m.jid.toLowerCase().endsWith("@s.whatsapp.net")) {
          upgraded.push(m);
          continue;
        }
        const phoneJid = await this.tryUpgradeLidToPhone(jid, m.jid);
        if (phoneJid) {
          log.info(
            `[mentions] upgraded ${m.jid} → ${phoneJid} via group metadata`
          );
          upgraded.push({ jid: phoneJid, name: m.name });
        } else {
          upgraded.push(m); // will get dropped below, with a warning
        }
      }
      const phoneOnly = upgraded.filter((m) =>
        m.jid.toLowerCase().endsWith("@s.whatsapp.net")
      );
      const droppedLid = upgraded.length - phoneOnly.length;
      if (droppedLid > 0) {
        log.warn(
          `[mentions] dropped ${droppedLid} non-phone JID(s) — they would not render as tags in WhatsApp`
        );
      }
      // Never tag the connected user themselves on outbound follow-ups —
      // an @-mention is meant to ping the supplier we're chasing, not us.
      const ownDigits = new Set(this.getOwnIdentity().phoneDigits);
      const phoneMentions = phoneOnly.filter((m) => {
        const digits = m.jid.split("@")[0].split(":")[0];
        if (digits && ownDigits.has(digits)) {
          log.warn(`[mentions] dropping self-mention for ${digits} on outbound message`);
          return false;
        }
        return true;
      });

      // Step 1: For each mention with a display name, anchor the pill on the
      // first occurrence of the name. We accept TWO author conventions:
      //   (a) `@John` — already tagged. We just swap the name for digits.
      //   (b) `John`  — bare name (this is how AI-drafted follow-ups read,
      //                 e.g. "Hi Enrique, following up..."). We splice the @
      //                 onto the first occurrence so WhatsApp renders a pill
      //                 right where the name appears.
      let finalText = text;
      for (const m of phoneMentions) {
        const digits = m.jid.split("@")[0];
        const name = m.name?.trim();
        if (!digits || !name) continue;

        // (a) tagged form first — global so multiple "@John"s all get swapped.
        const taggedRe = new RegExp(`@${escapeRegex(name)}\\b`, "gi");
        if (taggedRe.test(finalText)) {
          finalText = finalText.replace(taggedRe, `@${digits}`);
          continue;
        }

        // (b) bare name form — replace only the FIRST occurrence; replacing
        // every "John" in a long message would be too aggressive (e.g. "ask
        // John to confirm with John's team").
        const bareRe = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
        if (bareRe.test(finalText)) {
          finalText = finalText.replace(bareRe, `@${digits}`);
        }
      }

      // Step 2: For @-mentions to render, the body must contain `@<phoneDigits>`
      // tokens that match each JID in the `mentions` array. Prepend any missing
      // tokens (e.g. when the composer used the JID without a name, or the user
      // edited the name out).
      const phoneJids = phoneMentions.map((m) => m.jid);
      if (phoneJids.length > 0) {
        const tokensInText = (finalText.match(/@\d+/g) || []).map((t) => t.slice(1));
        const missing = phoneJids
          .map((j) => j.split("@")[0])
          .filter((digits) => digits && !tokensInText.includes(digits));
        if (missing.length > 0) {
          finalText = missing.map((d) => `@${d}`).join(" ") + " " + finalText;
        }
      }

      await this.sock.sendMessage(jid, {
        text: finalText,
        ...(phoneJids.length > 0 ? { mentions: phoneJids } : {}),
      });
      log.info(
        `Message sent to ${jid}${phoneJids.length ? ` (mentions=${phoneJids.length})` : ""}: "${finalText.substring(0, 80)}..."`
      );
      return { success: true };
    } catch (err: any) {
      log.error(`Failed to send to ${jid}`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async fetchAllGroups(): Promise<{ jid: string; name: string }[]> {
    if (!this.sock || this._status !== "ready") return [];
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const result = Object.entries(groups).map(([jid, metadata]) => ({
        jid,
        name: metadata.subject || jid,
      }));
      for (const g of result) {
        this.groupNameCache.set(g.jid, g.name);
      }
      log.info(`Fetched ${result.length} groups`);
      return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      log.error("Failed to fetch groups", { error: err.message });
      return [];
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Singleton
export const whatsapp = new WhatsAppManager();
