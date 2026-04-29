import { config } from "../config";
import { getGeminiClient, getResponseText, buildGenerationConfig } from "./gemini";
import { Sentiment } from "../db/schema";
import createLogger from "../utils/logger";

const log = createLogger("Extract");

export interface ExtractionResult {
  topic: string | null;
  summary: string | null;
  entities: string[];
  actionItems: string[];
  sentiment: Sentiment | null;
  referenceNumbers: string[];
  dueDate: Date | null;
}

const EMPTY_RESULT: ExtractionResult = {
  topic: null,
  summary: null,
  entities: [],
  actionItems: [],
  sentiment: null,
  referenceNumbers: [],
  dueDate: null,
};

const SYSTEM_PROMPT = `You are processing a WhatsApp group message in a supply-chain (logistics / procurement) context. Return JSON only — no markdown, no commentary.

Schema:
{
  "topic": string | null,            // short noun phrase: what is this about
  "summary": string | null,          // one neutral sentence
  "entities": string[],              // names of people, products, places, orgs mentioned
  "actionItems": string[],           // any actions/asks/commitments stated in the message
  "sentiment": "positive" | "neutral" | "negative" | null,
  "referenceNumbers": string[],      // PO numbers, invoice numbers, AWB / tracking numbers, container IDs, vehicle numbers, e-way bill numbers, order IDs, SO numbers — anything that uniquely identifies a shipment, order, or document. Preserve original casing and punctuation. Empty array if none.
  "dueDate": string | null           // ISO date (YYYY-MM-DD) of the ETA / promised / scheduled / delivery date if one is mentioned. Use the most relevant one; null if none. Resolve relative dates ("tomorrow", "Friday", "next Monday") against the message timestamp provided.
}

If the message is empty, a sticker, just an emoji, or pure noise, return all fields as null/empty arrays.
Keep summary to one sentence. Entities, actionItems, referenceNumbers must be arrays of strings (use [] not null).`;

interface ExtractInput {
  groupName: string;
  sender: string;
  body: string;
  /** ISO timestamp of when the message was sent — used to resolve relative dates. */
  messageTimestamp?: string;
}

function buildUserPrompt(input: ExtractInput): string {
  return `Group: ${input.groupName}
Sender: ${input.sender}
Message timestamp: ${input.messageTimestamp || "(unknown)"}
Message: ${input.body}

Return only the JSON object.`;
}

function isValidSentiment(v: unknown): v is Sentiment {
  return v === "positive" || v === "neutral" || v === "negative";
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

function coerceDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  return d;
}

export async function extractMessage(input: ExtractInput): Promise<ExtractionResult> {
  const start = Date.now();
  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: buildGenerationConfig({
      responseMimeType: "application/json",
    }),
  });

  try {
    const result = await Promise.race([
      model.generateContent(buildUserPrompt(input)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Extraction timed out after 20s")), 20000)
      ),
    ]);

    const text = getResponseText((result as any).response)
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const objMatch = text.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      log.warn("No JSON object in extraction response", { raw: text.slice(0, 200) });
      return EMPTY_RESULT;
    }

    const parsed = JSON.parse(objMatch[0]);
    const validated: ExtractionResult = {
      topic: typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic.trim() : null,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : null,
      entities: coerceStringArray(parsed.entities),
      actionItems: coerceStringArray(parsed.actionItems),
      sentiment: isValidSentiment(parsed.sentiment) ? parsed.sentiment : null,
      referenceNumbers: coerceStringArray(parsed.referenceNumbers),
      dueDate: coerceDate(parsed.dueDate),
    };

    log.info(
      `Extraction done in ${Date.now() - start}ms — topic="${validated.topic}" refs=${validated.referenceNumbers.length} due=${validated.dueDate?.toISOString() || "none"}`
    );
    return validated;
  } catch (err: any) {
    log.warn(`Extraction failed: ${err.message} — returning empty result`);
    return EMPTY_RESULT;
  }
}
