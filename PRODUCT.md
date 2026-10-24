# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** video and audio creators who work through an AI agent. They write or prompt a script in an agent session (Claude Desktop, Claude Code, Cursor, or any streamable-HTTP MCP client) and want a narration file back inside a pipeline — Remotion, HyperFrames, an editor, a render script. Their success is an MP3 sitting in the project, not an account dashboard.

**Secondary:** people who open the studio in a browser to audition a voice, preview a line, or generate one file by hand without wanting to run anything locally.

Both arrive with the same posture: no account, no card, no vendor evaluation. They are replacing ElevenLabs-style paid TTS for a personal or small-team project, and they can leave the moment setup is confusing or the free tier surprises them.

## Product Purpose

Koe is a self-hosted text-to-speech studio plus an MCP server that lets an agent generate voiceover on demand with Microsoft's neural voices (`edge-tts`), optionally offline Piper. It exists so a creator can get narration without a paid API, an account, or a build step.

Success looks like: an agent connects to the hosted MCP URL, calls `generate_voiceover`, and gets a usable audio file (a local path from the stdio server, a signed download URL plus inline audio from the hosted one) on the first try — and the operator's instance stays up and inside its free budget.

## Positioning

The free tier *is* the product, and it is bound by construction rather than by trust. Every install mints its own signed tenant key automatically (no signup, no payment), quotas are enforced per tenant, and generated audio is ephemeral — zips deleted after 15 minutes, jobs after an hour, audio wiped on restart. Keys are stateless HMACs with no database behind them; counters and job metadata persist on a small mounted volume, so the app survives a container recreate without turning into a stateful service.

A neighboring paid TTS vendor cannot copy that honestly: their economics need retained output and metered accounts. Koe's limits (per key, per IP, per job, plus a global queue and daily word budget) exist to keep a free public instance from being burned, not to upsell.

## Operating Context

- **Hosted MCP** at `POST /mcp` on the AWS deployment — stateless, JSON (no SSE), safe behind the Caddy reverse proxy. `GET /mcp` is the human setup page with tabs for Claude, Claude Code, and Cursor, plus a copy-paste "set this up for me" agent prompt.
- **Local stdio MCP** (`mcp/index.js`) for developers: same tools, but it saves audio to a local path and merges multi-part jobs into one file — the shape a video pipeline needs.
- **Studio UI** (`index.html`) at `/studio` (the root `/` redirects to `/mcp`): script entry, voice catalog, preview, job list, usage.
- **Raw HTTP API** (`/tts`, `/job/:id`, `/download/:id`, `/audio/:id`, `/jobs`, `/usage`, `/api/register`, `/health`) for scripts and curl.
- Deployed on a single EC2 instance: Docker container behind Caddy with a Let's Encrypt certificate, persisted counters/job metadata on a mounted volume, and ephemeral audio. Local dev runs `node server.js` on port 3000, with a Docker backend when Docker is present. See `DEPLOY.md` and `ops/`.
- `AGENTS.md` is the agent-facing contract (tool schemas, response shapes, error recipes); `README.md` is the human/operator reference.

## Capabilities and Constraints

**Confirmed capabilities:** multi-tenant free keys with per-key and per-IP quotas; per-job splitting into ~3000-character parts that the MCP merges back into one file; edge (MP3, rate/pitch, many languages) and Piper (WAV, offline, no rate/pitch) engines; previews metered at 600 characters; a bounded global queue with a circuit breaker for upstream failures; signed short-lived download links for hosted audio; admin key that bypasses limits; operator analytics with hashed visitor ids and bot-separated user counts; 34 automated tests.

**Hard constraints future work must respect:**

- `edge-tts` is Microsoft's *unofficial* consumer endpoint — free, unauthenticated, occasionally throttled. Copy and product claims must not imply an official Microsoft relationship or guaranteed SLA.
- No database. Usage counters are in-memory with a best-effort snapshot; `KOE_SECRET` is the only piece that must stay stable (rotating it invalidates every free key, and clients silently re-register).
- Script text is never persisted — only counts, voice, engine, status, timings.
- Audio is ephemeral by design and the UI/docs must say so plainly; a local download is the only permanent copy.
- Default limits (all env-tunable): registered key 60 requests / 2,000 words per hour, 20,000 words/day; anonymous 20 / 500 / 3,000; per job 6,000 words or 40,000 characters; instance-wide 2 concurrent jobs, 20-job queue, 30,000 words/day; 3 free keys per IP per day.
- Terminology in use: "studio" (the server + UI), "voiceover"/"job", "part", "free tenant key", "hosted MCP", "stdio MCP". Error states matter and are specified: 400 validation, 401 key, 403 other tenant, 404 unknown, 409 not ready, 410 expired, 413 too long, 429 rate/queue, 503 engine down or cooling down.

**Deliberately undecided:** monetization and any paid tier; whether the project is offered as a clone-and-run template versus a single hosted instance; public roadmap.

## Brand Commitments

- Name: **Koe**. One hosted public instance at `koe.kennedyazeru.space`.
- Promise to preserve: free, no signup, no card, no ElevenLabs.
- Voice of the product so far: plain, technical, honest about limits — it names its own constraints (ephemeral audio, sleeping instance, unofficial upstream, rate limits) instead of hiding them. No growth-hack tone, no fake social proof.
- Growth posture: it should read as a real product people recommend to each other, not a demo or a private script.

## Evidence on Hand

- Working server, guard, MCP server, and test suite in this repo (`server.js`, `guard.js`, `hosted-mcp.js`, `mcp/`, `test/`), all committed.
- Real generated audio (`output.mp3`, `preview.mp3`) and a `voiceovers/` output directory.
- Precise public limits published in three places (`/api/limits`, `README.md`, `AGENTS.md`) — usable as real product content.
- **Absences future work must not fabricate:** no testimonials, no customer logos, no benchmarks, no usage numbers, no press, no pricing, no roadmap, no team page. Any such element would be invented.

## Product Principles

1. **Free must stay free.** Every design or product decision has to keep the public instance inside its budget; convenience for one user never comes at the cost of the operators' queue.
2. **The agent path is the product.** A creator's first success is a tool call returning a file, so setup friction, tool output shape, and error messages outrank browser-side flourish.
3. **Honesty about limits builds trust.** Ephemeral audio, small-instance limits, upstream throttling, and quotas are stated up front and in the same plain voice everywhere.
4. **Nothing permanent on the server.** Ephemerality is the architecture, not a policy toggle; the local file or signed download is the artifact.
5. **Self-hosting must not rot.** Anything added has to keep working with stateless keys, no database, and a wiped disk on boot.
