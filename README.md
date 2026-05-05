# WATracker — WhatsApp Group Tracker Bot

Single-user WhatsApp bot that:

- Connects to your WhatsApp account (Baileys) and lets you pick which groups to track
- Captures every message from those groups and stores it in MongoDB
- Runs AI extraction (topic / summary / entities / action items / sentiment) over each message via Vertex AI Gemini
- Lets you ask free-form questions over the captured history (RAG: vector search + structured filters + Gemini)
- Schedules automated follow-up messages back to those groups, with a per-schedule toggle for **draft & approve** vs **auto-send**, where the message text itself can be AI-generated from recent group activity

## Architecture

```
WhatsApp (Baileys)  →  messages.upsert  →  pipeline (in-process queue)
                                            │
                                ┌───────────┼───────────┐
                                ▼           ▼           ▼
                        Mongo: messages  Vertex extract  Local embed
                                            │
                                            ▼
                                  Mongo: messages (enriched + vectors)

[ AI Chat /api/chat ]    →  vector + filter search  →  Gemini answer (SSE stream)
[ Scheduler (cron) ]     →  draft (Gemini) → approve OR auto-send → Baileys.sendTextMessage
[ React SPA ]            →  /api/* (groups, messages, chat, schedules, drafts)
```

Single Node process running:

- Express API server
- One Baileys WhatsApp socket
- node-cron scheduler
- In-process message pipeline
- Vite React frontend (built and served as static SPA in production)

## Tech stack

| Layer       | Choice                                        |
| ----------- | --------------------------------------------- |
| Language    | TypeScript                                    |
| Backend     | Express.js                                    |
| WhatsApp    | @whiskeysockets/baileys                       |
| DB          | MongoDB Atlas (with vector search)            |
| AI / extract| Vertex AI Gemini-2.5-flash                    |
| Embeddings  | @xenova/transformers MiniLM-L6-v2 (384 dims, local) |
| Scheduler   | node-cron                                     |
| Frontend    | React + Vite                                  |
| Deploy      | Docker → Cloud Run (GCP)                      |

## Setup

### Prerequisites

- Node.js 20+
- A MongoDB Atlas cluster (vector search support required for `/api/chat` to use embeddings; otherwise it falls back to filtered find)
- A Google AI Studio API key (https://aistudio.google.com/app/apikey)

### Install

```bash
npm install
cd frontend && npm install && cd ..
```

### Configure

```bash
cp .env.example .env
# edit .env: MONGODB_URI, GEMINI_API_KEY, GEMINI_MODEL
```

### MongoDB vector index

The server attempts to create a vector search index on `messages.embedding` on startup. If your cluster doesn't support `createSearchIndexes` programmatically, create it manually in Atlas with the definition:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" },
    { "type": "filter", "path": "groupJid" },
    { "type": "filter", "path": "sentiment" },
    { "type": "filter", "path": "timestamp" }
  ]
}
```

Index name: `vector_index`.

### Run (dev)

In two terminals:

```bash
# terminal 1: backend (auto-connects WhatsApp by default)
npm run dev

# terminal 2: frontend
npm run dev:frontend
```

Open <http://localhost:5173>.

1. **Connect** → click *Connect*, scan the QR with WhatsApp → Linked Devices.
2. **Groups** → pick which groups to track, save.
3. Send a message in one of those groups — it appears in **Messages** within ~10s with topic/summary/entities filled.
4. **Chat** → ask "what was discussed in <group> yesterday?"
5. **Schedules** → create a follow-up. Toggle `mode` (static vs ai_draft) and `autoSend`.
6. **Drafts** → if `autoSend=false`, AI drafts land here for approval.

### Build (production)

```bash
npm run build   # builds frontend (dist/) and backend (dist/)
npm start
```

## Environment variables

See `.env.example`. Notable:

- `MONGODB_URI`, `MONGODB_DB_NAME`
- `GEMINI_API_KEY` — Google AI Studio API key
- `GEMINI_MODEL` (default `gemini-2.5-flash`)
- `GEMINI_TEMPERATURE` (default `0.1`), `GEMINI_MAX_OUTPUT_TOKENS` (default `8192`)
- `GEMINI_THINKING_LEVEL` (optional, e.g. `LOW` / `MEDIUM` / `HIGH` — only honored by models that support it)
- `PORT` (default 5000), `TIMEZONE` (default `Asia/Kolkata`)
- `WHATSAPP_AUTO_CONNECT` (default true)
- `FOLLOWUP_LOOKBACK_HOURS` (default 24) — how far back the AI drafter reads when composing follow-ups

## API

| Method | Path                                | Purpose                                   |
| ------ | ----------------------------------- | ----------------------------------------- |
| GET    | `/api/whatsapp/status`              | Connection state + QR                     |
| GET    | `/api/whatsapp/stream`              | SSE: live status + QR updates             |
| POST   | `/api/whatsapp/connect`             | Begin connection                          |
| POST   | `/api/whatsapp/disconnect`          | Logout the socket                         |
| POST   | `/api/whatsapp/logout`              | Disconnect + wipe auth (force re-pair)    |
| GET    | `/api/whatsapp/groups`              | All groups the account is in              |
| GET    | `/api/groups/tracked`               | Currently tracked groups                  |
| PUT    | `/api/groups/tracked`               | Set tracked groups                        |
| GET    | `/api/messages`                     | Filtered message list                     |
| GET    | `/api/messages/stats`               | Counts per group                          |
| POST   | `/api/chat`                         | One-shot question                         |
| POST   | `/api/chat/stream`                  | SSE-streamed answer                       |
| GET / POST / PUT / PATCH / DELETE | `/api/schedules`      | CRUD scheduled follow-ups |
| POST   | `/api/schedules/:id/trigger`        | Run now                                   |
| GET    | `/api/drafts?status=pending`        | List drafts                               |
| PUT    | `/api/drafts/:id`                   | Edit draft text                           |
| POST   | `/api/drafts/:id/approve`           | Send + mark sent                          |
| POST   | `/api/drafts/:id/reject`            | Mark rejected                             |
| GET    | `/api/send-log`                     | Recent sends                              |

## Email follow-ups (POC)

Parallel to the WhatsApp scheduled-follow-ups flow, you can send a one-off
**email** follow-up to a supplier from the PO detail page and capture their
reply via Postmark Inbound. The user composes the email in our UI, hits "Send
Follow-Up", and we open Gmail compose in a new tab pre-filled with To / Cc /
Subject (with a `[FU-<tag>]` tracking tag) / Body. The user reviews and sends
manually. When the supplier replies (Reply All, so the Cc'd `ayesha@moviant.ai`
gets a copy), Postmark POSTs the parsed reply to our webhook, we match it to
the originating follow-up, and the PO page shows the reply inline.

```
[PO detail page]                 Gmail (new tab, user-driven)
     │                                   │
     │  POST /api/email-follow-ups       │
     ├──────────────────────────────────▶│
     │  ◀── { id, gmailComposeUrl }      │
     │                                   ▼
     │                            User clicks Send
     │                                   │
     │                                   ▼
     │                          supplier@example.com    ── Reply All ──▶
     │                                                  ayesha@moviant.ai
     │                                                        │
     │                                                        ▼
     │                                                Postmark Inbound
     │                                                        │
     │  POST /api/webhooks/inbound-email (basic auth)         │
     │ ◀──────────────────────────────────────────────────────┘
     │  matches via subject tag → updates follow-up to "replied"
```

### API

| Method | Path                                          | Purpose                                                       |
| ------ | --------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/api/email-follow-ups`                       | Create draft + return Gmail compose URL + mailto fallback URL |
| POST   | `/api/email-follow-ups/:id/mark-sent`         | Optimistic: flip status to `sent` after the user opens Gmail  |
| POST   | `/api/email-follow-ups/:id/link-reply`        | Manually link an unmatched reply (admin)                      |
| GET    | `/api/email-follow-ups?purchaseOrderId=...`   | List a PO's follow-ups + their replies                        |
| GET    | `/api/inbound-replies?matched=true\|false`    | List recent replies for the admin page                        |
| POST   | `/api/webhooks/inbound-email`                 | Postmark Inbound webhook target (HTTP Basic Auth)             |

### Reply matching (in order, first hit wins)

1. **Plus-addressed To/Cc** (`dev+followup-<tag>@moviant.ai`) — only useful once we move to programmatic send; parser is live now.
2. **`In-Reply-To` / `References` headers** — only useful with programmatic send.
3. **Subject tag `[FU-<tag>]`** — primary path for the POC.
4. **From-address heuristic** — if exactly one follow-up was sent to this address in the last 30 days, match it.
5. Otherwise the reply is persisted with `followUpId=null`, `isMatched=false`, `matchMethod="unmatched"` — never dropped. Triage from `/admin/inbound-replies`.

### Postmark setup

1. Sign up at [postmarkapp.com](https://postmarkapp.com) (free tier supports inbound).
2. In your Postmark server, create an **Inbound stream**. Postmark assigns you an inbound address like `xxxx@inbound.postmarkapp.com`.
3. Configure the **Inbound webhook URL** under that stream:
   - Production: `https://USER:PASSWORD@your-host/api/webhooks/inbound-email`
   - Local (via ngrok): `https://USER:PASSWORD@<ngrok-id>.ngrok-free.app/api/webhooks/inbound-email`
   - `USER` and `PASSWORD` must equal `INBOUND_WEBHOOK_USER` / `INBOUND_WEBHOOK_PASSWORD` in your `.env`.
4. Configure `ayesha@moviant.ai` to **forward** to the Postmark inbound address (via your mail provider's forwarding rules — Gmail / Google Workspace settings → Forwarding). Long term you can replace this with an MX record pointing your domain at Postmark.
5. Set `INBOUND_CC_EMAIL=ayesha@moviant.ai` in `.env` so every outbound follow-up Cc's that address.

### Local testing

1. Run the server: `npm run dev` (and `npm run dev:frontend` separately).
2. Open the frontend → Track → click **Email** on a PO row → set a supplier email → **Send Follow-Up**. Gmail opens in a new tab pre-filled. (You can close it without sending — the POC just verifies the URL contract.)
3. **Smoke the full pipe without leaving localhost:** `npm run smoke:email-followup`. This creates a temp PO, posts a fake Postmark payload to your webhook with the right basic-auth, and asserts the matching + idempotency + 401 paths.
4. **End-to-end against real Postmark:** install [ngrok](https://ngrok.com), run `ngrok http 5000`, paste the HTTPS URL into your Postmark inbound webhook config (with `USER:PASSWORD@`), then send a real email to your forwarding address. Watch the server logs for `InboundEmail` lines.
5. **Inspect raw payloads:** unmatched replies are listed at `/admin/inbound-replies` with their full body. The full Postmark payload is stored in `supplierReplies.rawPayload` for debugging.

### Known POC limitations

- We cannot verify the user actually hit Send in Gmail — `mark-sent` is optimistic.
- Plain "Reply" (not "Reply All") will bypass capture because mailto/Gmail compose URLs cannot set a `Reply-To` header. The subject tag still gives us a fallback if the supplier later forwards.
- No outbound email sending — the next iteration would swap in Postmark Outbound (or Resend), at which point the `outboundMessageId` field starts getting populated and the `In-Reply-To` matcher activates.

## Deploy (Cloud Run via Cloud Build)

```bash
gcloud builds submit --config cloudbuild.yaml
gcloud run deploy watracker \
  --image us-central1-docker.pkg.dev/$PROJECT_ID/watracker/watracker:latest \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars MONGODB_URI=...,VERTEX_PROJECT_ID=...
```

Mount your service-account credentials via `GOOGLE_CREDENTIALS_JSON` env var (raw JSON) or Cloud Run's secret manager integration.

## Verification checklist

1. **Pairing** — cold start, scan QR, status flips to `ready`. Restart server → reconnects from Mongo-stored auth without a new QR.
2. **Capture** — message in tracked group → appears in `/api/messages` within ~10s with topic/summary/entities/embedding populated.
3. **Filter** — message in non-tracked group → does NOT appear.
4. **Chat** — "what was discussed in <group> yesterday?" → answer cites real timestamps.
5. **Static + autoSend** — schedule fires, message arrives, sendLog row written.
6. **AI draft + manual approve** — at the cron tick, no message goes out; a row appears in `/api/drafts?status=pending`. Approve → it sends.
7. **AI draft + autoSend** — at the cron tick, message arrives without showing on Drafts page.
8. **Restart durability** — stop & restart Node; schedules continue, no duplicate sends in the same minute (atomic-claim guard).
