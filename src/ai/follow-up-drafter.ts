import { config } from "../config";
import { getGeminiClient, getResponseText, buildGenerationConfig } from "./gemini";
import { getMessagesCollection } from "../db/mongo";
import { GroupRef } from "../db/schema";
import createLogger from "../utils/logger";

const log = createLogger("Drafter");

const MAX_DIGEST_MESSAGES = 40;

export interface DraftInput {
  scheduleName: string;
  aiPrompt: string;
  targetGroups: GroupRef[];
  lookbackHours?: number;
}

async function buildDigest(
  targetGroups: GroupRef[],
  lookbackHours: number
): Promise<string> {
  if (targetGroups.length === 0) return "(no target groups configured)";
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const collection = getMessagesCollection();

  const docs = await collection
    .find(
      {
        groupJid: { $in: targetGroups.map((g) => g.jid) },
        timestamp: { $gte: since },
      },
      { projection: { embedding: 0 } }
    )
    .sort({ timestamp: -1 })
    .limit(MAX_DIGEST_MESSAGES)
    .toArray();

  if (docs.length === 0) {
    return `(no messages in target groups in the last ${lookbackHours} hours)`;
  }

  return docs
    .reverse()
    .map((m) => {
      const ts =
        m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp);
      const stamp = ts.toISOString().replace("T", " ").substring(0, 16);
      const summary = m.summary || m.body.substring(0, 200);
      return `[${stamp}] ${m.groupName} | ${m.sender}: ${summary}`;
    })
    .join("\n");
}

export async function draftFollowUp(input: DraftInput): Promise<string> {
  const lookbackHours = input.lookbackHours ?? config.followupLookbackHours;
  const start = Date.now();

  const groupNames = input.targetGroups.map((g) => g.name).join(", ");
  const digest = await buildDigest(input.targetGroups, lookbackHours);

  const prompt = `You are drafting a follow-up WhatsApp message for the group(s): ${groupNames}.

Recent messages in those groups (last ${lookbackHours} hours):
${digest}

User's intent for this follow-up: ${input.aiPrompt || "(no specific intent provided — write a polite, contextual nudge)"}

Write a concise, friendly WhatsApp message (max 600 characters). Plain text, no markdown, no emojis unless natural. Do not include greetings like "Dear all" — keep it casual and direct, as you would in a WhatsApp group. Return ONLY the message body, nothing else.`;

  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: buildGenerationConfig({ temperature: 0.6 }),
  });

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Drafter timed out after 25s")), 25000)
      ),
    ]);
    let text = getResponseText((result as any).response).trim();
    text = text.replace(/^["']|["']$/g, "").trim();
    if (text.length > 1000) text = text.substring(0, 1000);
    log.info(
      `Drafted follow-up for "${input.scheduleName}" in ${Date.now() - start}ms (${text.length} chars)`
    );
    return text;
  } catch (err: any) {
    log.error(`Drafter failed: ${err.message}`);
    throw new Error(`Failed to draft follow-up: ${err.message}`);
  }
}
