import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config";

let client: GoogleGenerativeAI | null = null;

export function getGeminiClient(): GoogleGenerativeAI {
  if (!client) {
    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not set in .env");
    }
    client = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return client;
}

export function getResponseText(response: any): string {
  return (
    response?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text || "")
      .join("") || ""
  );
}

/**
 * Build a generationConfig that respects the user's defaults from .env
 * and lets per-call overrides win.
 */
export function buildGenerationConfig(overrides: Record<string, any> = {}): any {
  const base: any = {
    temperature: config.geminiTemperature,
    maxOutputTokens: config.geminiMaxOutputTokens,
  };

  // Pass thinking level through if set (Gemini 2.5+ / Gemini 3 feature).
  // Some models accept a thinkingConfig with a budget; some accept "level".
  // We pass both to maximize compatibility — the model ignores unknown fields.
  if (config.geminiThinkingLevel) {
    base.thinkingConfig = { thinkingLevel: config.geminiThinkingLevel };
  }

  return { ...base, ...overrides };
}
