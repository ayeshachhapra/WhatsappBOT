import { config } from "../config";
import { buildGenerationConfig, getGeminiClient, getResponseText } from "./gemini";
import { AgentAction } from "../db/schema";
import createLogger from "../utils/logger";

const log = createLogger("AgentLLM");

export interface AgentDecisionInput {
  /** Inbound message body (text or OCR-derived). */
  body: string;
  groupName: string;
  senderName: string;
  /** Reference numbers extracted from the message — or inherited from a
   *  recent agent ask_clarifying when the message itself didn't mention any. */
  referenceNumbers: string[];
  /** True when the refs above were inherited (the body did not name a PO). */
  refsWereInherited: boolean;
  /** Sentiment from the extractor, if available. */
  sentiment: string | null;
  /** PO context — only POs that are mentioned by the inbound message. */
  poContext: Array<{
    poNumber: string;
    productName: string;
    companyName: string;
    eta: string | null;
    status: string;
    awaitingReply: boolean;
  }>;
  /** Last few messages in the same group, oldest-first, for context. */
  recentHistory: Array<{
    timestamp: string;
    sender: string;
    fromMe: boolean;
    body: string;
  }>;
  /**
   * Agent's own recent actions in this same group. Crucial for closure
   * detection — lets the model see "we asked X 3 minutes ago, the inbound
   * is the answer, close the loop with thanks".
   */
  recentAgentActions: Array<{
    consideredAt: string;
    decision: AgentAction;
    inboundBody: string;
    outboundText: string | null;
  }>;
}

export interface AgentDecision {
  action: AgentAction;
  /** Outbound text to send. Null when action is "none" or "escalate". */
  message: string | null;
  reasoning: string;
}

const DECISION_SCHEMA = `Return ONLY a JSON object matching this exact shape:
{
  "action": "none" | "ask_clarifying" | "acknowledge" | "escalate",
  "message": string | null,
  "reasoning": string
}

CONVERSATION CLOSURE — read this first. Look at the recent group history:
- If our most recent message (fromMe = true) in this group asked a question, AND the inbound message you're considering directly answers it, you MUST set action = "acknowledge" and produce a brief thank-you. Do NOT ask another question. End the thread.
- The only exception is if the supplier's answer itself contains a NEW concerning fact (e.g. they answered "why are you delayed" with "the warehouse caught fire") — in that case action = "escalate" with message = null.
- If we've already asked a clarifying question on this PO recently and they've now answered it, ALWAYS close the loop with "acknowledge". Do not start a fresh investigation.

ASK-WHY-FIRST PRINCIPLE for "ask_clarifying":
- If the supplier mentions a problem state (delay, hold, stuck, postponed, issue, problem) but doesn't say WHY, your clarifying question MUST ask for the reason / root cause first. Example: "Hi @Manuel, what's causing the delay on PO-1003?"
- If the supplier mentions a state change (dispatched, shipped, delivered, ETA changed) without specifics, ask for the missing specifics: AWB number, exact date, location, or what triggered the change.
- Always prefer ONE question per message. Pick the single most useful unknown.
- Never re-ask a question already answered in the recent history.

Rules for "action":
- "none": the message is chitchat, off-topic, or already-complete information that needs no reply. Also use this if we've already asked the same kind of question very recently and it's pending.
- "ask_clarifying": something is unclear or missing — most importantly, the REASON behind a problem state, but also missing facts (AWB, specific ETA, dispatch confirmation). Ask ONE specific question.
- "acknowledge": the supplier provided a clear final answer (confirmed dispatch with AWB, confirmed delivery, gave a specific dated ETA, explained the cause of a delay). Reply with a short thank-you / noted that closes the thread.
- "escalate": something concerning that needs the human user (multi-day delay with no plan, supplier complaint, supplier non-cooperation, large-scale issue). Set message to null.

Rules for "message" when not null:
- Must be a single WhatsApp message, plain text, max 280 characters.
- Address the supplier by their first name with an @-mention prefix, e.g. "Hi @Manuel, ...".
- Be concise, professional, no emojis unless the supplier used them first.
- Reference the PO by its number when relevant (e.g. "PO-1003").
- Never invent ETAs / AWBs / facts — only ask about them.
- Acknowledgement messages should briefly thank AND restate the key fact you're noting (e.g. "Thanks @Manuel, noted — dispatch confirmed with AWB DTDC8821453, will track from there."). This makes it clear what you understood and signals the thread is closed.

Rules for "reasoning":
- One or two sentences explaining the decision. This is shown to the human user as an audit trail.
- When you choose "acknowledge", explicitly state which prior question this is closing (e.g. "Closing the thread — supplier answered our earlier ask about the delay reason.").`;

function buildPrompt(input: AgentDecisionInput): string {
  const poBlock =
    input.poContext.length > 0
      ? input.poContext
          .map(
            (p) =>
              `- ${p.poNumber} (${p.productName}, ${p.companyName}): status=${p.status}, eta=${
                p.eta || "unknown"
              }, awaitingReply=${p.awaitingReply}`
          )
          .join("\n")
      : "(no PO master records matched this message)";

  const historyBlock =
    input.recentHistory.length > 0
      ? input.recentHistory
          .map(
            (m) =>
              `[${m.timestamp}] ${m.fromMe ? "(us)" : m.sender}: ${m.body.slice(0, 200)}`
          )
          .join("\n")
      : "(no recent history)";

  const agentBlock =
    input.recentAgentActions.length > 0
      ? input.recentAgentActions
          .map((a) => {
            const out =
              a.outboundText && a.outboundText.length > 0
                ? `→ "${a.outboundText.slice(0, 200)}"`
                : "(no message sent)";
            return `[${a.consideredAt}] decision=${a.decision} ${out}`;
          })
          .join("\n")
      : "(no prior agent activity in this group)";

  return `You are an autonomous SCM tracking agent operating inside a WhatsApp group chat. Your job is to keep purchase-order deliveries on track by asking suppliers WHY problems are happening (root cause), filling in missing facts, acknowledging clear updates, and escalating concerning patterns.

GROUP: ${input.groupName}
INBOUND MESSAGE FROM: ${input.senderName}
INBOUND BODY: ${input.body}
REFERENCE NUMBERS DETECTED: ${input.referenceNumbers.join(", ") || "(none)"}${
  input.refsWereInherited
    ? "\nNOTE: The supplier's message did NOT name a PO. The references above were inherited from your most recent ask_clarifying in this group — treat the inbound as a direct answer to that prior question."
    : ""
}
SENTIMENT: ${input.sentiment || "neutral"}

RELEVANT PURCHASE ORDERS:
${poBlock}

RECENT GROUP HISTORY (oldest first):
${historyBlock}

YOUR PRIOR DECISIONS IN THIS GROUP (oldest last — use this to detect "the supplier just answered our question, close the thread"):
${agentBlock}

${DECISION_SCHEMA}`;
}

function parseDecision(raw: string): AgentDecision {
  // Strip markdown fences and stray backticks the model sometimes wraps JSON in.
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Pull the first {...} block out — defends against the model adding prose.
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  }
  const parsed = JSON.parse(text);

  const validActions: AgentAction[] = ["none", "ask_clarifying", "acknowledge", "escalate"];
  if (!validActions.includes(parsed.action)) {
    throw new Error(`Agent returned invalid action: ${parsed.action}`);
  }
  const decision: AgentDecision = {
    action: parsed.action,
    message:
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : null,
    reasoning:
      typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "",
  };
  // For "none" and "escalate" the message must be null — strip if model leaked one.
  if (decision.action === "none" || decision.action === "escalate") {
    decision.message = null;
  }
  // For "ask_clarifying" / "acknowledge" the message must exist; downgrade to "none"
  // if the model contradicted itself (defensive — never silently send junk).
  if (
    (decision.action === "ask_clarifying" || decision.action === "acknowledge") &&
    !decision.message
  ) {
    decision.action = "none";
    decision.reasoning =
      decision.reasoning + " (downgraded — no message body produced)";
  }
  return decision;
}

export async function decideAgentAction(
  input: AgentDecisionInput
): Promise<AgentDecision> {
  const prompt = buildPrompt(input);
  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: buildGenerationConfig({
      temperature: 0.3,
      responseMimeType: "application/json",
    }),
  });

  const start = Date.now();
  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent decision timed out after 20s")), 20000)
    ),
  ]);
  const raw = getResponseText((result as any).response);
  log.info(`Decision in ${Date.now() - start}ms: ${raw.slice(0, 200)}`);

  try {
    return parseDecision(raw);
  } catch (err: any) {
    log.warn(`Failed to parse agent JSON: ${err.message}. Raw: ${raw.slice(0, 300)}`);
    // Fail safe: do nothing.
    return {
      action: "none",
      message: null,
      reasoning: `Agent JSON parse failed: ${err.message}`,
    };
  }
}
