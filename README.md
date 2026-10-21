# Koe TTS Studio + MCP

A self-hosted text-to-speech studio (Microsoft neural voices via edge-tts, plus optional offline Piper) and an **MCP server** so agents can generate voiceovers on demand — free, no ElevenLabs.

It is built to be a **free public product**:

```
agent / browser ──free tenant key──> TTS Studio ──> edge-tts ──> ephemeral MP3 zip
        │                                │
        └── auto-registers on first use  └── deletes audio after 15 minutes
```

- **Multi-tenant** — every MCP install and every browser gets its own signed free key with independent hourly/daily quotas.
- **Rate-limited** — per-key and per-IP limits, a bounded global queue, a global daily word budget, and a circuit breaker for upstream (Microsoft) failures.
- **Ephemeral audio** — generated zips are deleted after 15 minutes; job metadata after 1 hour; a restart wipes all audio. Nothing depends on permanent storage.
- **Zero database** — keys are stateless HMACs; usage counters live in memory with a best-effort snapshot. `KOE_SECRET` is the only piece that must be stable.

## Use it from any agent (hosted MCP)

The studio is also a **hosted MCP server** at `https://<your-host>/mcp`. Agents connect by URL — no install, no local Node, no config file. The same URL serves a human setup page in a browser.

1. Open `https://<your-host>/mcp` and click **Create key**.
2. Point your client at `https://<your-host>/mcp` with `Authorization: Bearer <key>` (or `x-api-key: <key>`).
3. Ask the agent to call `studio_status`, then `generate_voiceover`.

Works with Claude custom connectors (static request header, currently beta), Claude Code (`--transport http`), Cursor, or any streamable-HTTP MCP client. The endpoint is **stateless** and returns JSON (no SSE required), which suits Render's load balancer and free plan.

Because the audio lives on the server rather than the caller's disk, hosted `generate_voiceover` returns a **short-lived signed download URL** (`/audio/:id?dl=…`, no API key needed) plus inline audio for short clips. The local stdio server below is still available for developers and saves files directly.

> **Building an agent?** [AGENTS.md](AGENTS.md) is the full agent-facing reference: exact MCP tool schemas, response shapes, recipes, error handling and the raw HTTP API.

---

## Free tier

| | Registered free key | Anonymous (no key) | Admin (`API_KEY`) |
| --- | --- | --- | --- |
| Requests / hour | 60 | 20 | unlimited |
| Words / hour | 2,000 | 500 | unlimited |
| Words / day | 20,000 | 3,000 | unlimited |
| Job visibility | own jobs only | own jobs only (per IP) | all jobs |

Global safety rail: **2** concurrent jobs, a **20**-job queue, and **30,000** words/day across the whole instance. One job may be at most **6,000 words / 40,000 characters**. Free keys are capped at **3 per IP per day**. Previews are metered too and limited to 600 characters.

All of these are environment variables (see below).

### How keys work

```bash
# Mint a free key (no payment, no account)
curl -X POST https://your-service.onrender.com/api/register
# → { "key": "koe_sk_ab12cd34ef56_...", "tenant": "ab12cd34ef56", "limits": {...} }

# Use it
curl -H "x-api-key: koe_sk_..." -H "Content-Type: application/json" \
     -d '{"text":"Hello from Koe","voice":"en-US-AndrewNeural"}' \
     https://your-service.onrender.com/tts
```

- Keys are signed with `KOE_SECRET` and contain no server-side state, so registration works even on a wiped Render disk. Rotating `KOE_SECRET` invalidates old keys; the MCP and UI re-register automatically.
- `KOE_REQUIRE_KEY=true` rejects anonymous calls. The bundled MCP server and studio UI register a key automatically, so end users never see this step.
- `API_KEY` is an operator/admin key. It bypasses all limits and can see every tenant's jobs. Keep it private.

### Ephemeral audio

- Audio zips live in `output/audio/` and are deleted after `KOE_AUDIO_TTL_SEC` (default **900 s**).
- Job metadata lives in `output/jobs.json` and is pruned after `KOE_JOB_TTL_SEC` (default **1 hour**).
- Previews are written to `output/previews/` and swept after `KOE_PREVIEW_TTL_SEC` (default **10 min**).
- On boot all audio/preview/work files are deleted; jobs that were mid-flight are marked failed. `GET /download/:id` returns `410` once audio expires.
- Script text is never stored on disk — only counts, voice, engine, status and timings.

---

## TTS Studio server (`server.js`)

Local usage: `npm install && node server.js` → <http://localhost:3000>. `/` redirects to the MCP setup page at `/mcp`; the studio UI is served at `/studio`. It talks to the same origin (or `http://localhost:3000` when opened as a file).

### Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /tts` | key (or anon if allowed) | Submit a job → `{ jobId, parts, wordCount }` immediately |
| `GET /job/:id` | key / same tenant | Job status |
| `GET /jobs` | key / same tenant | Up to 100 recent jobs for this tenant |
| `GET /download/:id` | key / same tenant | ZIP of parts; `409` not ready, `410` expired |
| `GET /audio/:id` | key / same tenant, or signed `?dl=` | Single merged MP3/WAV; `409` not ready, `410` expired |
| `POST /mcp` | key | Hosted MCP server (streamable HTTP, stateless, JSON responses) |
| `GET /mcp` | public (HTML) | Human setup page for the MCP server |
| `DELETE /job/:id` | key / same tenant | Delete job + audio |
| `POST /tts-preview` | key (metered) | Stream an edge voice MP3 |
| `POST /tts-preview-piper` | key (metered) | Stream a Piper WAV |
| `POST /api/register` | public | Mint a free tenant key (per-IP capped) |
| `GET /api/limits` | public | Public limit policy (no secrets) |
| `GET /usage` | key | This caller's usage vs limits |
| `GET /health` | public | Backend, engines, queue, limits, TTLs |
| `GET /` | public | Redirects to `/mcp` |
| `GET /studio` | public | Studio UI |

Auth accepts `x-api-key: <key>`, `Authorization: Bearer <key>`, or `?key=<key>`. Status codes: `400` validation, `401` missing/invalid key, `403` another tenant's job, `404` unknown, `409` not ready, `410` audio expired, `413` script too large, `429` rate/queue limit, `503` engine unavailable or upstream cool-down.

### Two backends

- `TTS_BACKEND=native` — runs the `edge-tts` / `piper` CLIs directly (Render/Docker image). Default when Docker is unavailable.
- `TTS_BACKEND=docker` — shells out to the `edge-tts` / `piper-tts` Docker images (local dev). Auto-selected when the `docker` CLI exists.

Docker invocations use `execFile` (no shell), so script text and voice ids are never interpreted as shell commands.

---

## Deploy on Render (free tier)

`render.yaml` is a ready blueprint; the `Dockerfile` installs Node 20 + `edge-tts` and best-effort Piper.

1. Push the repo to GitHub.
2. Render → **New → Web Service** → connect the repo; the blueprint sets Docker, the health check, and the env vars.
3. **Keep the generated `KOE_SECRET` stable** — it signs every free key. (`API_KEY` is the optional admin key.)
4. Health check: `/health`.

The blueprint sets `KOE_REQUIRE_KEY=true`, `KOE_SECRET`, a 2/20 global queue, a 30k/day global budget, and the 15 min / 1 h TTLs.

Free-plan realities: 0.1 CPU / 512 MB, sleeps after ~15 min idle (first request wakes it in ~60 s), 750 instance-hours/month, and an ephemeral filesystem. That is compatible with this design by construction: audio was already ephemeral, and keys are stateless.

---

## MCP server

### Hosted (recommended)

Already running at `POST /mcp` on your deployment — see [Use it from any agent](#use-it-from-any-agent-hosted-mcp) above. There is nothing to install and no environment variables to set; the caller's free key scopes every tool call. `GET /mcp` is the human setup page.

### Local stdio (`mcp/`)

Runs the same tools as a local process. It talks to a studio (local or hosted) and saves generated audio to a **local file path**, which is handy for video pipelines.

```bash
cd mcp
npm install
```

### Register it

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "koe-tts": {
      "command": "node",
      "args": ["C:/Users/User/koe/mcp/index.js"],
      "env": {
        "TTS_STUDIO_URL": "https://koe-tts-studio.onrender.com"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add koe-tts \
  -e TTS_STUDIO_URL=https://koe-tts-studio.onrender.com \
  -- node C:/Users/User/koe/mcp/index.js
```

No key is required in the config. On first use the MCP calls `POST /api/register`, saves the free key in `~/.koe/credentials.json` (keyed by studio URL), and reuses it. Each user/install therefore gets an independent quota. Set `TTS_API_KEY` only if you want to force a specific key (for example the operator's admin key).

### Tools

| Tool | What it does |
| --- | --- |
| `studio_status` | Pings `/health` and shows backend, engines, queue, limits, and your usage. Call first if something fails. |
| `list_voices` | Voices by engine (`edge`/`piper`) and optional language filter (`en`, `fr`, …). |
| `generate_voiceover` | Narrates `text`, polls the job, then either saves and **merges parts into one MP3/WAV** locally (stdio) or returns a **signed download URL + inline audio** (hosted). Retries briefly on queue-full/cool-down. |
| `get_voiceover_status` | Job status by id (e.g. after a timeout). |
| `list_recent_voiceovers` | Your last 10 jobs (tenant-isolated). |
| `get_usage` | Requests/words this hour and today, limits, and reset times. |

### MCP environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `TTS_STUDIO_URL` | `http://localhost:3000` | Base URL of the studio |
| `TTS_API_KEY` | *(none)* | Optional explicit key; disables auto-registration |
| `VOICEOVER_DIR` | `./voiceovers` | Where local audio files are saved |
| `KOE_CREDENTIALS_FILE` | `~/.koe/credentials.json` | Where auto-registered free keys are stored |
| `KOE_DISABLE_AUTO_REGISTER` | *(unset)* | Set to `1` to never mint a free key |

Smoke-test the wiring without an agent:

```bash
cd mcp && TTS_STUDIO_URL=http://localhost:3000 node test-client.js
```

---

## Server environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `TTS_BACKEND` | auto | `native` or `docker` |
| `KOE_SECRET` | generated | **Set this in production.** Signs free tenant keys |
| `API_KEY` | *(none)* | Admin key: unlimited, sees all jobs |
| `KOE_REQUIRE_KEY` | `false` | Reject anonymous callers |
| `KOE_REGISTER_IP_DAY` | `3` | Free keys per IP per day |
| `KOE_KEY_REQ_HOUR` | `60` | Requests/hour per key |
| `KOE_KEY_WORDS_HOUR` | `2000` | Words/hour per key |
| `KOE_KEY_WORDS_DAY` | `20000` | Words/day per key |
| `KOE_ANON_REQ_HOUR` | `20` | Requests/hour per anonymous IP |
| `KOE_ANON_WORDS_HOUR` | `500` | Words/hour per anonymous IP |
| `KOE_ANON_WORDS_DAY` | `3000` | Words/day per anonymous IP |
| `KOE_MAX_WORDS_PER_JOB` | `6000` | Per-request word cap |
| `KOE_MAX_CHARS_PER_JOB` | `40000` | Per-request character cap |
| `KOE_MAX_CHARS_PER_PREVIEW` | `600` | Preview text cap |
| `KOE_GLOBAL_CONCURRENCY` | `2` | Simultaneous upstream jobs |
| `KOE_GLOBAL_QUEUE` | `20` | Max queued jobs |
| `KOE_GLOBAL_WORDS_DAY` | `30000` | Instance-wide daily word budget |
| `KOE_AUDIO_TTL_SEC` | `900` | Audio zip lifetime |
| `KOE_JOB_TTL_SEC` | `3600` | Job metadata lifetime |
| `KOE_PREVIEW_TTL_SEC` | `600` | Preview file lifetime |
| `KOE_SWEEP_INTERVAL_SEC` | `60` | Cleanup sweep interval |
| `KOE_COOLDOWN_SEC` | `60` | Base upstream failure cool-down (doubles, max 10 min) |
| `KOE_STATE_FILE` | `.koe-state.json` | Best-effort state snapshot |
| `KOE_OUTPUT_DIR` | `./output` | Runtime audio/work/job directory |
| `KOE_JOBS_FILE` | `output/jobs.json` | Job metadata file |
| `KOE_PUBLIC_URL` | request origin | Absolute base used in hosted-MCP download links (set it if you run behind a proxy) |
| `KOE_MCP_INLINE_AUDIO_MAX` | `3145728` | Max bytes of audio to inline in an MCP response; `0` returns only the link |
| `KOE_MCP_POLL_MS` | `2000` | How often hosted `generate_voiceover` polls a job |

## Notes

- edge-tts is free but unofficial (Microsoft's consumer endpoint); occasional throttling is expected. The circuit breaker pauses new work briefly instead of hammering it.
- Very long scripts are split into ~3000-char parts by the studio; the MCP merges them back into a single file (MP3s concatenated, WAVs re-muxed properly).
- Tests: `npm test` (22 tests: guard limits, key auth, tenant isolation, validation, ephemeral cleanup, hosted MCP handshake and signed audio links).
