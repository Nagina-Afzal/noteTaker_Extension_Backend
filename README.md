# Meet Notetaker Backend

Node.js/Express backend for the Meet Notetaker Chrome extension. It owns the
Groq API key, talks to Groq Whisper and Llama, and persists meetings in
Supabase Postgres.

Audio is uploaded **directly from the extension to Cloudinary** (unsigned
upload). This backend never proxies audio bytes — it only receives a URL and
passes that URL to Groq.

## Endpoints

| Method | Path                    | Body / notes                                             | Returns |
| ------ | ----------------------- | -------------------------------------------------------- | ------- |
| POST   | `/api/transcribe`       | `{ audioUrl, meetingId? }`                               | `{ transcript }` |
| POST   | `/api/summarize`        | `{ transcript, meetingId? }`                             | `{ overview, keyPoints, actionItems, notes }` |
| POST   | `/api/ask`              | `{ question, transcript }`                               | `{ answer }` |
| POST   | `/api/retranscribe`     | `{ meetingId, audioUrl? }`                               | `{ transcript, overview, keyPoints, actionItems, meeting }` |
| POST   | `/api/meetings`         | `{ id?, title?, audioUrl, audioPublicId?, durationSeconds? }` | `{ meeting }` (201) |
| GET    | `/api/meetings`         | —                                                        | `{ meetings: [...] }` |
| GET    | `/api/meetings/:id`     | —                                                        | `{ meeting }` |
| PATCH  | `/api/meetings/:id`     | Any of `title, transcript, overview, keyPoints, actionItems, audioUrl, audioPublicId, durationSeconds` | `{ meeting }` |
| DELETE | `/api/meetings/:id`     | —                                                        | `{ ok: true }` |
| GET    | `/api/health`           | —                                                        | `{ ok, checks }` |

All errors return JSON of the form `{ "error": "...", "detail": "..." }`.
There are **no silent nulls** — every failure path returns a non-2xx status
with a message the UI can display.

Request bodies are capped at **2 MB** (JSON). Audio never flows through this
service, so that limit only needs to accommodate transcripts.

## Environment variables

| Variable       | Required | Description |
| -------------- | -------- | ----------- |
| `GROQ_API_KEY` | yes      | Groq API key. Server-side only. |
| `DATABASE_URL` | yes      | Supabase Postgres connection string. |
| `PORT`         | no       | Local listen port (default `3000`). |

See `.env.example`.

## Database setup

Run `schema.sql` against your Supabase database (SQL Editor or `psql`):

