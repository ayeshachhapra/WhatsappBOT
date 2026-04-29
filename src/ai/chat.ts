import { config } from "../config";
import { getGeminiClient, getResponseText, buildGenerationConfig } from "./gemini";
import { generateEmbedding } from "./embed";
import { getMessagesCollection } from "../db/mongo";
import { MessageDocument } from "../db/schema";
import { whatsapp } from "../whatsapp/manager";
import createLogger from "../utils/logger";

const log = createLogger("Chat");

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  response: string;
  citations: CitedMessage[];
}

export interface CitedMessage {
  groupName: string;
  groupJid: string;
  sender: string;
  senderJid: string;
  fromMe: boolean;
  timestamp: string;
  body: string;
  topic: string | null;
}

export interface ParsedQuery {
  normalizedQuery: string;
  filters: {
    groupName?: string;
    sender?: string;
    sentiment?: "positive" | "neutral" | "negative";
    sinceDays?: number;
    entityMatch?: string;
  };
}

const SYSTEM_PROMPT = `You are an assistant for SUPPLY-CHAIN BUYERS. The user is tracking purchase orders, dispatches, and deliveries via WhatsApp groups with suppliers, freight forwarders, and warehouses.

You receive:
- The user's question (and recent chat history for context).
- A set of message excerpts retrieved from the database, each with: index, group, sender, timestamp, topic, body.

# HOW TO REFER TO THE USER
Always address the user as "you" / "your". NEVER use any name for the user, even if a name appears in their messages or push-name. Self-sent messages are tagged \`[SELF-SENT]\` with sender "⬅️ THE USER (sent by you)" — refer to those as "you said …" / "your message …", never by name.

# RETRIEVED MESSAGES ARE IN CHRONOLOGICAL ORDER (OLDEST FIRST)
The retrieved messages are listed oldest → newest. The message tagged \`★ LATEST IN THIS SET\` is the MOST RECENT thing said on this topic — it overrides anything earlier. Always anchor your answer on the latest message and use earlier ones only for context.

# ANSWER STYLE — KEEP IT TIGHT
1. Lead with the LATEST concrete status in 1–2 sentences. Don't recap older messages unless the latest contradicts them.
2. If the latest message **changes** what was said earlier — e.g., an ETA was given previously and now it's been pushed back without a new date, or a dispatch was confirmed earlier and is now flagged delayed — you MUST surface the change explicitly. Pattern: *"Originally ETA was Apr 25 (Acme, Apr 18), but the latest update on Apr 22 says it's delayed again with no new date provided."* This is more useful than just quoting the latest line.
3. If the latest message says something is delayed / pushed / postponed WITHOUT giving a new date, call that out as a missing piece — and recommend asking for the revised ETA.
4. Tight bullets only if there are 2+ distinct facts worth surfacing (ETA, dispatch, AWB, last contact). No message-by-message recap.
5. Cite as "<group>, <date>" inline only when stating a specific fact. Don't list every source.
6. Answer ONLY from retrieved messages. If they don't have enough info, say so in one line.
7. NEVER invent facts.

# SELF-SENT MESSAGES
\`[SELF-SENT]\` messages were sent by you (the user) from your own WhatsApp. When relevant:
- If you already followed up on this topic, lead with "You already followed up on <date> — <one-line gist>" and state whether a reply has come since.
- Don't suggest another follow-up when you've already chased recently and the supplier hasn't had time to reply.

# FOLLOW-UP RULE
Recommend a follow-up when ANY of these are true:
- The latest message says it's delayed / pushed / postponed but does NOT give a new date — chase the revised ETA explicitly.
- A previously promised ETA has passed without a delivered/dispatched confirmation.
- The user's question can't be fully answered from the retrieved messages and there's a clear group + person to ask.

DO NOT recommend a follow-up when:
- You (the user) already sent a \`[SELF-SENT]\` follow-up on this same topic within the last 24 hours.
- The latest message clearly resolves the question (delivery confirmed, AWB shared, etc.).

When recommending, the suggested message should reference the SPECIFIC gap — e.g., "earlier ETA was Apr 25, latest message says delayed with no new date — can you share the revised ETA and reason?".

# NO DATA AVAILABLE
If the retrieved messages contain NOTHING relevant to the user's question (zero messages, or the messages are about unrelated topics):
1. Say exactly this in your answer body, on its own line: "No data found on this. Do you want to send a message to follow up on any of the groups?"
2. Do NOT pad with apologies or speculation.
3. ALWAYS append the \`[FOLLOW_UP_SUGGESTION]\` block in this case, with the group field set to the literal string \`any\` (the frontend will let the user pick the group), the sender field blank, and a polite professional message rephrasing the user's question as something they'd ask a supplier / freight forwarder. Keep it short.

Example (no data case):
User: "Has the courier picked up the Mumbai shipment?"
Retrieved: 0 relevant messages.
Your response:

No data found on this. Do you want to send a message to follow up on any of the groups?

[FOLLOW_UP_SUGGESTION]
group: any
sender:
message: Hi team, has the Mumbai shipment been picked up by the courier? Please share status + AWB once available.
[/FOLLOW_UP_SUGGESTION]

When recommending a follow-up, append this section EXACTLY at the very end of your answer (and nothing after it):

[FOLLOW_UP_SUGGESTION]
group: <exact groupName from the retrieved messages — pick the one most relevant to the order/shipment in question>
sender: <name of the specific person to nudge if you can identify one from the retrieved messages (the person who last gave an update, owns the dispatch, etc.); otherwise leave blank>
message: <short, polite, professional WhatsApp follow-up. If a sender name is identified, OPEN with "Hi <FirstName>," so the message addresses them directly. Reference the specific PO / shipment / item where possible. Single line, no quotes, no markdown, max 600 chars.>
[/FOLLOW_UP_SUGGESTION]

If the question IS fully resolved (e.g., delivery is confirmed and the buyer is just asking when it arrived) OR you cannot identify a clear group to ask in, do NOT include the [FOLLOW_UP_SUGGESTION] block.`;

async function parseQuery(
  userMessage: string,
  recentHistory: HistoryMessage[]
): Promise<ParsedQuery> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: buildGenerationConfig({
      responseMimeType: "application/json",
    }),
  });

  let historyContext = "";
  if (recentHistory.length > 0) {
    const recent = recentHistory.slice(-4);
    historyContext = `\nRecent conversation (for resolving "that group", "him", "those"):\n${recent
      .map((m) => `${m.role}: ${m.content.substring(0, 200)}`)
      .join("\n")}\n`;
  }

  const prompt = `Parse this query about WhatsApp group history. Return ONLY this JSON:
{
  "normalizedQuery": "concise reformulation of the question, fixing typos and expanding shorthand (1 sentence)",
  "groupName": null or string (if user names a specific group),
  "sender": null or string (if user names a specific person),
  "sentiment": null or "positive" | "neutral" | "negative" (if user asks about mood/tone),
  "sinceDays": null or integer (e.g. 'yesterday' = 1, 'last week' = 7, 'last month' = 30),
  "entityMatch": null or string (if user asks about a specific entity/topic)
}
${historyContext}
User query: "${userMessage}"`;

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Query parse timed out")), 10000)
      ),
    ]);
    const text = getResponseText((result as any).response)
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)![0]);

    const filters: ParsedQuery["filters"] = {};
    if (parsed.groupName) filters.groupName = parsed.groupName;
    if (parsed.sender) filters.sender = parsed.sender;
    if (
      parsed.sentiment === "positive" ||
      parsed.sentiment === "neutral" ||
      parsed.sentiment === "negative"
    ) {
      filters.sentiment = parsed.sentiment;
    }
    if (typeof parsed.sinceDays === "number" && parsed.sinceDays > 0) {
      filters.sinceDays = parsed.sinceDays;
    }
    if (parsed.entityMatch) filters.entityMatch = parsed.entityMatch;

    return {
      normalizedQuery: parsed.normalizedQuery || userMessage,
      filters,
    };
  } catch (err: any) {
    log.warn(`Query parse failed (${err.message}), using raw query`);
    return { normalizedQuery: userMessage, filters: {} };
  }
}

async function searchMessages(
  query: string,
  filters: ParsedQuery["filters"],
  limit = 30
): Promise<MessageDocument[]> {
  const queryEmbedding = await generateEmbedding(query);

  const matchClause: any = {};
  if (filters.groupName) {
    matchClause.groupName = { $regex: filters.groupName, $options: "i" };
  }
  if (filters.sender) {
    matchClause.sender = { $regex: filters.sender, $options: "i" };
  }
  if (filters.sentiment) {
    matchClause.sentiment = filters.sentiment;
  }
  if (filters.sinceDays) {
    matchClause.timestamp = {
      $gte: new Date(Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000),
    };
  }
  if (filters.entityMatch) {
    matchClause.$or = [
      { entities: { $regex: filters.entityMatch, $options: "i" } },
      { topic: { $regex: filters.entityMatch, $options: "i" } },
      { body: { $regex: filters.entityMatch, $options: "i" } },
    ];
  }

  const collection = getMessagesCollection();

  // Try Atlas vector search first; fall back to plain find if unavailable.
  try {
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: 200,
          limit,
          ...(Object.keys(matchClause).length > 0 ? { filter: matchClause } : {}),
        },
      },
      { $project: { embedding: 0 } },
    ];
    const results = (await collection.aggregate(pipeline).toArray()) as MessageDocument[];
    if (results.length > 0) return results;
  } catch (err: any) {
    log.warn(`Vector search failed (${err.message}), falling back to plain find`);
  }

  // Fallback: filter + recency
  const docs = await collection
    .find(matchClause, { projection: { embedding: 0 } })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
  return docs;
}

/**
 * Patch retrieved messages so anything actually authored by the connected user
 * is rendered as `sender="You"` and `fromMe=true`. This covers:
 *   • new messages already captured with the right fields,
 *   • OLDER messages stored before the fromMe fix (where `sender` is the user's
 *     pushName like "Ac" and `fromMe` is unset/false).
 * Detection: senderJid digits match the connected user's own JID/LID, OR
 * sender string matches the connected user's display name.
 */
function patchSelfSent(msgs: MessageDocument[]): MessageDocument[] {
  const id = whatsapp.getOwnIdentity();
  if (id.phoneDigits.length === 0 && !id.name) return msgs;

  const ownDigitsSet = new Set(id.phoneDigits);
  const ownNameLower = (id.name || "").trim().toLowerCase();

  return msgs.map((m) => {
    if (m.fromMe) return { ...m, sender: "You" };
    const digits = (m.senderJid || "").split("@")[0].split(":")[0];
    const matchesJid = digits && ownDigitsSet.has(digits);
    const matchesName =
      !!ownNameLower &&
      typeof m.sender === "string" &&
      m.sender.trim().toLowerCase() === ownNameLower;
    if (matchesJid || matchesName) {
      return { ...m, sender: "You", fromMe: true };
    }
    return m;
  });
}

function formatMessages(msgs: MessageDocument[]): string {
  if (msgs.length === 0) return "No messages found.";
  // Sort chronologically (oldest first) so the AI reads the timeline naturally
  // and the LATEST message is the last thing it sees — making it easy to anchor
  // its answer on what was said most recently.
  const tsOf = (m: MessageDocument) =>
    (m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp)).getTime();
  const sorted = [...msgs].sort((a, b) => tsOf(a) - tsOf(b));
  const latestIdx = sorted.length - 1;

  return sorted
    .map((m, i) => {
      const ts = m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp);
      const senderLabel = m.fromMe ? `${m.sender} ⬅️ THE USER (sent by you)` : m.sender;
      const isLatest = i === latestIdx;
      const lines: string[] = [
        `[${i + 1}] ${ts.toISOString().replace("T", " ").substring(0, 16)}${m.fromMe ? "   [SELF-SENT]" : ""}${isLatest ? "   ★ LATEST IN THIS SET" : ""}`,
        `    Group:  ${m.groupName}`,
        `    Sender: ${senderLabel}`,
      ];
      if (m.topic) lines.push(`    Topic:  ${m.topic}`);
      if (m.summary) lines.push(`    Summary: ${m.summary}`);
      if (m.actionItems && m.actionItems.length > 0) {
        lines.push(`    Action items: ${m.actionItems.join("; ")}`);
      }
      if (m.entities && m.entities.length > 0) {
        lines.push(`    Entities: ${m.entities.join(", ")}`);
      }
      if (m.referenceNumbers && m.referenceNumbers.length > 0) {
        lines.push(`    Refs: ${m.referenceNumbers.join(", ")}`);
      }
      if (m.dueDate) {
        const d = m.dueDate instanceof Date ? m.dueDate : new Date(m.dueDate);
        lines.push(`    Due / ETA mentioned: ${d.toISOString().substring(0, 10)}`);
      }
      lines.push(`    Body:   "${m.body.substring(0, 400)}"`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function toCitations(msgs: MessageDocument[]): CitedMessage[] {
  return msgs.slice(0, 12).map((m) => ({
    groupName: m.groupName,
    groupJid: m.groupJid,
    sender: m.sender,
    senderJid: m.senderJid,
    fromMe: !!m.fromMe,
    timestamp:
      m.timestamp instanceof Date
        ? m.timestamp.toISOString()
        : new Date(m.timestamp).toISOString(),
    body: m.body,
    topic: m.topic,
  }));
}

export async function chat(
  userMessage: string,
  history: HistoryMessage[] = []
): Promise<ChatResponse> {
  const start = Date.now();
  const trimmedHistory = history.slice(-10);

  const { normalizedQuery, filters } = await parseQuery(userMessage, trimmedHistory);
  log.info(`Parsed: "${normalizedQuery}" | filters: ${JSON.stringify(filters)}`);

  let messages = await searchMessages(normalizedQuery, filters, 30);
  if (messages.length === 0 && Object.keys(filters).length > 0) {
    log.info("No matches with filters, retrying without filters");
    messages = await searchMessages(normalizedQuery, {}, 30);
  }
  log.info(`Retrieved ${messages.length} messages for context`);

  messages = patchSelfSent(messages);
  const messagesText = formatMessages(messages);

  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: buildGenerationConfig(),
  });

  const prompt = `User question: "${userMessage}"
Interpreted as: "${normalizedQuery}"${
    Object.keys(filters).length > 0 ? `\nFilters: ${JSON.stringify(filters)}` : ""
  }

Retrieved messages:

${messagesText}

Answer the user's question using only these messages.`;

  const geminiHistory = trimmedHistory.map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));
  const validHistory: typeof geminiHistory = [];
  for (const m of geminiHistory) {
    if (validHistory.length === 0 || validHistory[validHistory.length - 1].role !== m.role) {
      validHistory.push(m);
    }
  }

  let response: string;
  try {
    const session = model.startChat({ history: validHistory });
    const result = await Promise.race([
      session.sendMessage(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Chat response timed out after 30s")), 30000)
      ),
    ]);
    response = getResponseText((result as any).response);
  } catch (err: any) {
    log.error(`Chat call failed: ${err.message}`);
    response =
      messages.length > 0
        ? `Found ${messages.length} relevant message(s) but couldn't generate a response.`
        : "Sorry, I couldn't process your request right now. Please try again.";
  }

  log.info(`Chat done in ${Date.now() - start}ms`);
  return { response, citations: toCitations(messages) };
}

export async function chatStream(
  userMessage: string,
  history: HistoryMessage[],
  onEvent: (event: {
    type: "status" | "chunk" | "citations" | "done";
    data?: string;
    citations?: CitedMessage[];
  }) => void
): Promise<void> {
  const start = Date.now();
  const trimmedHistory = history.slice(-10);

  onEvent({ type: "status", data: "Parsing your question..." });
  const { normalizedQuery, filters } = await parseQuery(userMessage, trimmedHistory);

  onEvent({ type: "status", data: "Searching message history..." });
  let messages = await searchMessages(normalizedQuery, filters, 30);
  if (messages.length === 0 && Object.keys(filters).length > 0) {
    messages = await searchMessages(normalizedQuery, {}, 30);
  }

  messages = patchSelfSent(messages);

  onEvent({
    type: "status",
    data: `Found ${messages.length} relevant message(s). Generating answer...`,
  });
  onEvent({ type: "citations", citations: toCitations(messages) });

  const messagesText = formatMessages(messages);

  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: buildGenerationConfig(),
  });

  const prompt = `User question: "${userMessage}"
Interpreted as: "${normalizedQuery}"${
    Object.keys(filters).length > 0 ? `\nFilters: ${JSON.stringify(filters)}` : ""
  }

Retrieved messages:

${messagesText}

Answer the user's question using only these messages.`;

  const geminiHistory = trimmedHistory.map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));
  const validHistory: typeof geminiHistory = [];
  for (const m of geminiHistory) {
    if (validHistory.length === 0 || validHistory[validHistory.length - 1].role !== m.role) {
      validHistory.push(m);
    }
  }

  try {
    const session = model.startChat({ history: validHistory });
    const stream = await session.sendMessageStream(prompt);
    for await (const chunk of stream.stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) onEvent({ type: "chunk", data: text });
    }
  } catch (err: any) {
    log.error(`Chat stream failed: ${err.message}`);
    onEvent({
      type: "chunk",
      data: "\n\nSorry, an error occurred while generating the response.",
    });
  }

  onEvent({ type: "done" });
  log.info(`Chat stream done in ${Date.now() - start}ms`);
}
