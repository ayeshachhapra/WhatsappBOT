# AI Chat And Agent Architecture

## Mental Model

This app has three related AI flows, but they do different jobs:

1. **Message ingestion and enrichment** reads WhatsApp group messages, stores them, and adds AI metadata such as topic, summary, references, sentiment, ETA, OCR text, and embeddings.
2. **AI chat** answers the user's questions by searching stored WhatsApp messages and asking Gemini to answer from that retrieved context. This is retrieval-augmented generation, not an autonomous agent loop.
3. **The autonomous agent** runs during message ingestion. For each qualifying inbound supplier message, it asks Gemini for one structured decision, then optionally sends one guarded WhatsApp reply.

High-level flow:

```text
WhatsApp/Baileys
  -> WhatsAppManager
  -> pipeline queue
  -> OCR / extraction / embedding / PO update / alerts
  -> MongoDB
  -> AI chat, agent activity, scheduler, dashboard, frontend UI
```

Startup begins in `src/index.ts`:

```text
connectDb()
  -> createVectorIndex()
  -> seed default alert rules and demo POs
  -> start Express API
  -> start scheduler
  -> optionally auto-connect WhatsApp
```

The Express app in `src/server/index.ts` mounts the main API routes, including `/api/chat`, `/api/agent`, `/api/messages`, `/api/whatsapp`, `/api/drafts`, `/api/outbox`, and scheduler-related routes.

## End-To-End Message Ingestion

WhatsApp ingestion starts in `src/whatsapp/manager.ts`. The app uses Baileys to connect to WhatsApp Web, listens for `messages.upsert`, unwraps message wrappers, filters to supported group messages, and ignores groups that are not tracked.

For accepted messages, the manager builds an `IncomingMessage` with:

- WhatsApp IDs: `msgId`, `groupJid`, `senderJid`
- human labels: `groupName`, `sender`
- direction: `fromMe`
- content: `body`, `messageType`, optional image bytes
- timestamp

It then calls `queueMessage()` in `src/pipeline/index.ts`.

The pipeline is an in-process FIFO queue with a maximum size of 500. Each queued message goes through `processMessage()`:

1. **Tracked-group and duplicate checks**
   The pipeline verifies the group is still tracked and skips duplicate `msgId`s.

2. **Base document insert**
   A `MessageDocument` is inserted into MongoDB immediately with raw body, sender, group, timestamp, and empty enrichment fields. This means the message is preserved even if later AI enrichment fails.

3. **Vision OCR when needed**
   If the message has image media, `ocrImage()` in `src/ai/vision.ts` sends the image bytes to Gemini through `generateContent`. The output becomes the message body or is combined with the caption.

4. **Structured extraction**
   `extractMessage()` in `src/ai/extract.ts` calls Gemini with `generateContent` and `responseMimeType: "application/json"`. It extracts topic, summary, entities, action items, sentiment, reference numbers, and due date.

5. **Embedding**
   `generateEmbedding()` in `src/ai/embed.ts` creates a 384-dimensional local embedding using `Xenova/all-MiniLM-L6-v2`. The embedding input is the extracted summary when available, otherwise the message body.

6. **Reference inheritance**
   If a supplier replies without a PO/reference number, the pipeline can inherit references from the most recent sent agent clarifying question in the same group within a 30-minute window. This lets short replies like "customs hold" stay attached to the correct PO thread.

7. **Mongo enrichment update**
   The original message document is updated with extraction results, embedding, `extractedAt`, and inherited reference metadata when applicable.

8. **Alert rules**
   Enabled keyword alert rules are checked against the body, topic, and summary. Matches create alert trigger documents.

9. **Purchase-order enrichment**
   `updatePurchaseOrdersFromMessage()` matches extracted or inherited references to `purchaseOrders.poNumber`, updates inferred status, ETA, last update fields, and `awaitingReply`.

10. **Autonomous agent trigger**
    `maybeRunAgent()` runs after enrichment so the agent sees the latest message metadata and PO state.

## How AI Chat Works

The chat page is user-driven. It starts in `frontend/src/pages/Chat.tsx`, where the user sends a question to:

```text
POST /api/chat/stream
```

The route in `src/server/routes/chat.ts` validates the message and calls `chatStream()` from `src/ai/chat.ts`. There is also a non-streaming route, `POST /api/chat`, which calls `chat()`.

The chat backend does this:

1. **Trim history**
   The last 10 user/assistant messages are kept. This history is only for conversational continuity, such as resolving "that group" or "him".

2. **Parse the user's query**
   `parseQuery()` calls Gemini with `generateContent` and JSON output. It returns:

   - `normalizedQuery`
   - optional filters: `groupName`, `sender`, `sentiment`, `sinceDays`, `entityMatch`

3. **Embed the normalized query**
   `searchMessages()` calls `generateEmbedding()` locally.

4. **Search stored WhatsApp messages**
   The code first tries MongoDB Atlas `$vectorSearch` against the `messages.embedding` field using the `vector_index` index. If vector search fails, it falls back to a filtered Mongo `.find()` sorted by recency.

5. **Fallback without filters**
   If no messages are found and query filters were applied, the search retries without filters.

6. **Patch self-sent messages**
   `patchSelfSent()` uses the connected WhatsApp identity to label older self-sent messages as `fromMe` and sender `You`.

7. **Format retrieved context**
   `formatMessages()` sorts retrieved messages oldest to newest, marks the latest item, includes topic, summary, action items, entities, refs, due date, and body snippets.

8. **Generate the answer**
   Gemini is called with `model.startChat({ history }).sendMessage(prompt)` for non-streaming chat, or `sendMessageStream(prompt)` for streaming chat. The system prompt requires the answer to use only retrieved messages and cite concrete facts inline.

9. **Return citations**
   `toCitations()` returns up to 12 retrieved messages. The frontend displays a collapsible source list.

This is a RAG flow:

```text
User question
  -> Gemini JSON query parse
  -> local embedding
  -> Mongo vector/filter retrieval
  -> Gemini answer grounded in retrieved messages
  -> streamed UI response with citations
```

It is not an autonomous agent loop. The chat call does not choose tools repeatedly, does not send WhatsApp messages by itself, and does not mutate stored messages. It can, however, include a `[FOLLOW_UP_SUGGESTION]` block. The frontend parses that block and lets the user save or send a draft through the drafts flow.

## How The Autonomous Agent Works

The autonomous agent is triggered from `maybeRunAgent()` in `src/pipeline/index.ts`. It runs once for a freshly stored inbound message after OCR, extraction, embedding, alert evaluation, and PO enrichment.

Before any LLM decision, hard guardrails decide whether the agent is allowed to consider the message:

- It never reacts to `fromMe` messages, which prevents self-reply loops.
- Agent settings must be enabled.
- The group must be in `agentSettings.allowedGroupJids`.
- Very short messages with no references are skipped unless references were inherited from a recent agent question.

When those checks pass, the pipeline loads decision context:

- matching purchase orders for the message references
- the last 8 messages in the same group
- the last 5 agent actions in the same group
- the extracted sentiment and reference numbers
- whether references were inherited from a prior agent ask

Then `decideAgentAction()` in `src/ai/agent.ts` calls Gemini with `generateContent`, JSON output, and temperature `0.3`.

Gemini must return exactly one decision:

```json
{
  "action": "none | ask_clarifying | acknowledge | escalate",
  "message": "string or null",
  "reasoning": "string"
}
```

The action meanings are:

- `none`: do nothing.
- `ask_clarifying`: ask one concise supplier question, usually about a missing root cause, ETA, AWB, dispatch detail, or confirmation.
- `acknowledge`: thank the supplier and close the thread when the reply answers a prior ask or gives a clear final update.
- `escalate`: log a concern for the human user; do not send a WhatsApp message.

If the decision is `ask_clarifying` or `acknowledge` and has outbound text, the pipeline still re-checks send guardrails:

- `mode === "observe"` means log the decision but never send.
- the group must still be allowlisted.
- cooldown must pass for that group.
- hourly and daily per-group caps must pass.
- WhatsApp must be connected and ready.

Only after those checks does the code call:

```text
whatsapp.sendTextMessage(groupJid, decision.message, optional mention)
```

Every consideration is written to `agentActions`, including no-op decisions and skipped sends. That collection is what powers the Agent page, outbox summaries, open thread summaries, and audit trail.

The agent flow is:

```text
Inbound WhatsApp message
  -> pipeline enrichment
  -> maybeRunAgent()
  -> load settings/context/history
  -> Gemini JSON decision
  -> parse/validate decision
  -> optional guarded send
  -> agentActions audit record
```

This is an agent-style decision loop at the application level: each inbound message creates one observe-decide-act cycle. It is not a multi-step LLM tool-calling agent where the model repeatedly calls tools until it reaches a final answer.

## LLM Calls Vs Agent Decisions

The code uses Gemini in several places, but not every Gemini call is an agent.

| Flow | File | Gemini call type | Purpose | Agent loop? |
| --- | --- | --- | --- | --- |
| OCR / vision | `src/ai/vision.ts` | `generateContent` with image bytes | Extract text from images/documents | No |
| Message extraction | `src/ai/extract.ts` | `generateContent` JSON | Convert one WhatsApp message into structured metadata | No |
| Chat query parse | `src/ai/chat.ts` | `generateContent` JSON | Normalize the user's question and extract search filters | No |
| Chat answer | `src/ai/chat.ts` | `startChat().sendMessage()` or `sendMessageStream()` | Answer from retrieved messages | No, RAG |
| Agent decision | `src/ai/agent.ts` | `generateContent` JSON, temperature `0.3` | Choose `none`, `ask_clarifying`, `acknowledge`, or `escalate` | Yes, one app-level decision cycle |
| AI scheduled drafts | `src/ai/follow-up-drafter.ts` | Gemini text generation | Draft scheduled follow-up text from recent messages | No |

Shared Gemini setup is in `src/ai/gemini.ts`. It creates a `GoogleGenerativeAI` client from `GEMINI_API_KEY`, uses `config.geminiModel`, and applies default generation config from environment settings such as temperature, max output tokens, and optional thinking level.

Embedding is not a Gemini call. It is local sentence-transformer inference through `@xenova/transformers`, with a fallback hash-style embedding if the model fails.

## Data And Collections

The main AI-related Mongo collections are defined in `src/db/schema.ts` and initialized in `src/db/mongo.ts`.

### `messages`

Stores every accepted tracked WhatsApp message. Important fields:

- source fields: `msgId`, `groupJid`, `groupName`, `sender`, `senderJid`, `fromMe`, `body`, `messageType`, `bodySource`, `timestamp`
- enrichment fields: `topic`, `summary`, `entities`, `actionItems`, `sentiment`, `referenceNumbers`, `dueDate`, `embedding`, `extractedAt`
- inherited reference fields: `referenceSource`, `inheritedFromAgentActionId`

Indexes include unique `msgId`, group/timestamp, timestamp, reference numbers, due date, sender/timestamp, and the Atlas vector search index `vector_index` on `embedding`.

### `agentSettings`

Singleton settings document with `_id: "default"`.

Controls whether the agent is enabled, which groups it can send to, whether it is in `active` or `observe` mode, cooldown seconds, hourly cap, and daily cap.

Defaults:

```text
enabled: false
allowedGroupJids: []
maxMessagesPerGroupPerHour: 4
maxMessagesPerGroupPerDay: 12
cooldownSeconds: 90
mode: active
```

### `agentActions`

Audit trail for every agent consideration. It records the trigger message, group, sender, inbound body, decision, reasoning, outbound text, whether it was sent, skip reason, references, mention info, and send error.

This collection is central to:

- recent activity on the Agent page
- open thread summaries
- outbox display for autonomous sends
- reference inheritance for supplier replies

### `purchaseOrders`

Tracks PO master state. The pipeline updates matching POs whenever a message references them. Important fields include `poNumber`, `eta`, `status`, `awaitingReply`, `lastUpdateMsgId`, and `lastUpdateAt`.

`awaitingReply` flips to `true` when the user/system sends a follow-up referencing the PO and back to `false` when a non-`fromMe` message references it.

### `drafts`

Stores user-reviewable outbound drafts. AI chat follow-up suggestions can be saved here, and scheduled messages can create drafts for approval.

### `sendLog`

Records scheduled or draft sends. Autonomous agent sends are not written here; they are represented in `agentActions` with `sent: true` and surfaced in `/api/outbox`.

## Guardrails, Failure Modes, And Timeouts

The code is designed so AI failures should not break ingestion.

### Ingestion and enrichment

- Duplicate WhatsApp `msgId`s are skipped.
- Unsupported or untracked messages are dropped before the pipeline.
- Empty messages after OCR are skipped.
- Extraction has a 20-second timeout and returns empty enrichment on failure.
- Vision OCR has a 35-second timeout and falls back to the caption or empty text.
- Embedding generation truncates input at 7,500 characters and falls back to local hash-style embedding on model failure.
- Atlas vector index creation is best effort; if unsupported, startup logs a warning.

### Chat

- Query parsing has a 10-second timeout. On failure, the raw user query is used with no filters.
- Vector search failure falls back to normal Mongo find.
- Chat answer generation has a 30-second timeout in non-streaming mode.
- Streaming mode emits status, citations, chunks, and done events over SSE.
- If answer generation fails, the API returns a short fallback response rather than failing the whole request.

### Agent

- The agent never reacts to self-sent messages.
- The agent only operates in explicitly allowlisted groups.
- Observe mode logs decisions but sends nothing.
- Cooldown, hourly cap, and daily cap are checked before sending.
- The LLM never controls routing; sends always use the inbound `groupJid`.
- If the LLM returns invalid JSON or an invalid action, the decision fails safe to `none`.
- If the LLM returns an outbound action without a message, it is downgraded to `none`.
- `none` and `escalate` always have `message: null`.
- All agent exceptions are swallowed and logged so they do not block the message pipeline.

## File Map

Core runtime:

- `src/index.ts`: application bootstrap.
- `src/server/index.ts`: Express app and route mounting.
- `src/config/index.ts`: environment-backed runtime config.

WhatsApp:

- `src/whatsapp/manager.ts`: Baileys connection, QR/auth lifecycle, message receive, media download, outbound sends, mentions.
- `src/whatsapp/auth-state-mongo.ts`: Mongo-backed WhatsApp auth state.

Message pipeline:

- `src/pipeline/index.ts`: queue, message processing, enrichment orchestration, alert evaluation, PO updates, agent trigger.

AI modules:

- `src/ai/gemini.ts`: Gemini client and generation config.
- `src/ai/vision.ts`: Gemini OCR for images.
- `src/ai/extract.ts`: Gemini structured extraction from messages.
- `src/ai/embed.ts`: local embeddings and fallback embeddings.
- `src/ai/chat.ts`: RAG chat query parsing, retrieval, answer generation, streaming.
- `src/ai/agent.ts`: Gemini JSON decision for autonomous agent actions.
- `src/ai/follow-up-drafter.ts`: AI-drafted scheduled follow-up text.

Persistence:

- `src/db/schema.ts`: TypeScript document interfaces.
- `src/db/mongo.ts`: Mongo connection, indexes, default settings, vector index, collection helpers.

API routes:

- `src/server/routes/chat.ts`: `/api/chat` and `/api/chat/stream`.
- `src/server/routes/agent.ts`: agent settings, activity, stats, summary.
- `src/server/routes/messages.ts`: message listing and mention-target lookup.
- `src/server/routes/drafts.ts`: draft save/approve/reject/send flow.
- `src/server/routes/outbox.ts`: unified outbox from drafts and agent actions.

Frontend:

- `frontend/src/pages/Chat.tsx`: streaming chat UI, follow-up suggestion parsing, save/send follow-up actions.
- `frontend/src/pages/Agent.tsx`: agent settings, summary, open threads, recent decision audit trail.
- `frontend/src/api.ts`: shared frontend API types for messages, agent settings/actions, outbox, and citations.
