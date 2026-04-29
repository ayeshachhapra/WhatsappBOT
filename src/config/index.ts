import dotenv from "dotenv";
dotenv.config();

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseFloatOrDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseIntOrDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const config = {
  // Gemini (Google AI Studio API key auth)
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiTemperature: parseFloatOrDefault(process.env.GEMINI_TEMPERATURE, 0.1),
  geminiMaxOutputTokens: parseIntOrDefault(process.env.GEMINI_MAX_OUTPUT_TOKENS, 8192),
  geminiThinkingLevel: (process.env.GEMINI_THINKING_LEVEL || "").trim().toUpperCase() || null,

  // MongoDB
  mongodbUri: process.env.MONGODB_URI || "mongodb://localhost:27017/watracker",
  mongodbDbName: process.env.MONGODB_DB_NAME || "watracker",

  // Server
  port: parseIntOrDefault(process.env.PORT, 5000),
  timezone: process.env.TIMEZONE || "Asia/Kolkata",

  // WhatsApp
  whatsappAutoConnect: parseBoolean(process.env.WHATSAPP_AUTO_CONNECT, true),
  whatsappReconnectOnConflict: parseBoolean(
    process.env.WHATSAPP_RECONNECT_ON_CONFLICT,
    false
  ),

  // Pipeline / drafter
  followupLookbackHours: parseIntOrDefault(process.env.FOLLOWUP_LOOKBACK_HOURS, 24),
};
