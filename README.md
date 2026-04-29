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
