# Koe TTS Studio + MCP

A self-hosted text-to-speech studio (Microsoft neural voices via edge-tts, plus optional offline Piper) and an **MCP server** so agents can generate voiceovers on demand — free, no ElevenLabs.

It is built to be a **free public product**:

```
agent / browser ──free tenant key──> TTS Studio ──> edge-tts ──> ephemeral MP3 zip
        │                                │
        └── auto-registers on first use  └── deletes audio after 15 minutes
```

- **Multi-tenant** — every MCP install and every browser gets its own free key (issued server-side) with independent hourly/daily quotas.
- **Rate-limited** — per-key and per-IP limits, a bounded global queue, a global daily word budget, and a circuit breaker for upstream (Microsoft) failures.
- **Ephemeral audio** — generated zips are deleted after 15 minutes; job metadata after 1 hour; a restart wipes all audio. Nothing depends on permanent storage.
- **One small SQLite file** — issued keys and every counter live in `KOE_DB_PATH` (`./koe.db` by default), so limits survive restarts and a key is revocable by deleting its row. `KOE_SECRET` still signs download links and hashed subjects.

## Use it from any agent (hosted MCP)

The public instance runs at **<https://koe.kennedyazeru.space>**. The **hosted MCP server** is at `https://koe.kennedyazeru.space/mcp`. Agents connect by URL — no install, no local Node, no config file. The same URL serves a human setup page in a browser.

1. Open <https://koe.kennedyazeru.space/mcp> and click **Create key** (the page solves the proof-of-work challenge for you).
2. Point your client at `https://koe.kennedyazeru.space/mcp` with `Authorization: Bearer <key>` (or `x-api-key: <key>`).
3. Ask the agent to call `studio_status`, then `generate_voiceover`.

Works with Claude custom connectors (static request header, currently beta), Claude Code (`--transport http`), Cursor, or any streamable-HTTP MCP client. The endpoint is **stateless** and returns JSON (no SSE required), which keeps it compatible with a reverse proxy and ephemeral container disk.

Because the audio lives on the server rather than the caller's disk, hosted `generate_voiceover` returns a **short-lived signed download URL** (`/audio/:id?dl=…`, no API key needed) plus inline audio for short clips. The local stdio server below is still available for developers and saves files directly.

> **Building an agent?** [AGENTS.md](AGENTS.md) is the full agent-facing reference: exact MCP tool schemas, response shapes, recipes, error handling and the raw HTTP API. [DESIGN.md](DESIGN.md) records the visual system and the analytics measurement language.

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

Keys are issued **server-side**: `POST /keys` writes an opaque `koe_sk_<32 hex>` record into SQLite, and every request validates against that table. Nothing client-side can be counted.

```bash
# 1. Ask which anti-abuse gate is active
curl https://koe.kennedyazeru.space/keys/challenge
# → { "mode": "pow", "challenge": "…", "pow": { "leadingZeroHexChars": 4 } }
#   (or { "mode": "turnstile", "sitekey": "…" } when Turnstile is configured)

# 2. Solve it — proof-of-work: find a nonce whose sha256(challenge + nonce)
#    starts with 4 zero hex chars (~65k tries, well under a second) — and mint
curl -X POST https://koe.kennedyazeru.space/keys \
     -H "Content-Type: application/json" \
     -d '{"challenge":"<from step 1>","nonce":"0f3a"}'
# → 201 { "key": "koe_sk_9f2c…", "tenant": "…", "limits": {…} }

# 3. Use it
curl -H "x-api-key: koe_sk_..." -H "Content-Type: application/json" \
     -d '{"text":"Hello from Koe","voice":"en-US-AndrewNeural"}' \
     https://koe.kennedyazeru.space/tts
```

- `POST /api/register` is a thin alias of `POST /keys` — same gate, same `201 {key}` body, so older callers keep working instead of getting a 404.
- Challenges are single-use and expire after 5 minutes; a wrong or replayed one is `403 pow_challenge_invalid` / `pow_failed`.
- With `TURNSTILE_SITEKEY` + `TURNSTILE_SECRET` set, the gate becomes Cloudflare Turnstile instead of proof-of-work (headless clients then need `TTS_API_KEY`).
- Keys are rows, so they are revocable: delete the row (or wipe `KOE_DB_PATH`) and the key stops working on the next request. The studio UI and the MCP client re-mint automatically when a stored key starts returning `401` — see [MIGRATION-v3-keys.md](MIGRATION-v3-keys.md).
- `KOE_REQUIRE_KEY=true` rejects anonymous calls. The bundled MCP server and studio UI register a key automatically, so end users never see this step.
- `API_KEY` is an operator/admin key. It bypasses all limits and can see every tenant's jobs. Keep it private.

### Kill switch

`KOE_KILL_SWITCH=true` answers `503 {"error":"temporarily_disabled"}` on `POST /tts`, `POST /tts-preview*` and `POST /mcp` **before** auth, quota, queueing or any upstream work. Flip it in the environment and restart to stop all generation instantly; everything else (health, key issuance, usage, dashboards) keeps answering.

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
| `POST /keys` | public (gated) | Mint a free key → `201 {key, tenant, limits}`; PoW or Turnstile gate, capped per IP/day |
| `GET /keys/challenge` | public | Which gate to solve: `{mode:"pow"\|"turnstile", challenge?, sitekey?}` |
| `POST /api/register` | public (gated) | Thin alias of `POST /keys` (same gate, same body) |
| `GET /api/limits` | public | Public limit policy (no secrets) |
| `GET /usage` | key | This caller's usage vs limits |
| `GET /healthz` | public | Backend, engines, queue, limits, TTLs, and DB reachability |
| `GET /health` | public | Alias of `/healthz` |
| `GET /` | public | Redirects to `/mcp` |
| `GET /studio` | public | Studio UI |
| `GET /stats.html` | public shell | Operator analytics dashboard; data needs the admin key |
| `GET /stats.json` | admin | Machine-readable counters used by the dashboard |
| `GET /stats` | admin | Server-rendered operator report (`?key=` works) |

Auth accepts `x-api-key: <key>`, `Authorization: Bearer <key>`, or `?key=<key>`. `POST /mcp` always needs a live key row (or the admin key). Status codes: `400` validation or a job over `KOE_MAX_JOB_WORDS`, `401 {"error":"invalid_key"}` missing/unknown key, `403` another tenant's job or a failed issuance gate, `404` unknown, `409` not ready, `410` audio expired, `413` script over the 40,000-char cap, `429 {"reason":…}` rate/queue/global limit, `503 {"error":"temporarily_disabled"}` kill switch, engine unavailable or upstream cool-down.

Rejections carry a `reason` (`hourly_requests`, `hourly_words`, `daily_words`, `global_daily_words`, `job_too_long`, `kill_switch`, `queue_full`, `invalid_key`, `mint_cap`) and, for limits, a `retryAfterSeconds` reset window.

### Two backends

- `TTS_BACKEND=native` — runs the `edge-tts` / `piper` CLIs directly (the production Docker image). Default when Docker is unavailable.
- `TTS_BACKEND=docker` — shells out to the `edge-tts` / `piper-tts` Docker images (local dev). Auto-selected when the `docker` CLI exists.

Docker invocations use `execFile` (no shell), so script text and voice ids are never interpreted as shell commands.

---

## Deploy on AWS (EC2 + Docker + Caddy)

Production is a single EC2 instance running the `koe` container behind Caddy, with a Let's Encrypt certificate and two systemd timers (watchdog and disk guard). The complete runbook is in **[DEPLOY.md](DEPLOY.md)**; the reusable scripts and unit files are in **[ops/](ops/)**.

**Short version**

```bash
# on the instance
sudo dnf install -y docker git
sudo systemctl enable --now docker

mkdir -p ~/koe-ops
# copy ops/koe.env.example to ~/koe-ops/koe.env and fill in secrets
# copy ops/rebuild.sh, ops/watchdog.sh, ops/disk-guard.sh to ~/koe-ops/
bash ~/koe-ops/rebuild.sh
```

`rebuild.sh` clones/pulls the repo, builds the image, recreates `koe` on `127.0.0.1:8080`, and starts Caddy. `KOE_SECRET` must stay stable — it signs download links and every hashed subject id. `API_KEY` is the operator key used by `/stats`, `/stats.json`, and the analytics dashboard.

The Docker image installs Node 20 + `edge-tts` and best-effort Piper. It keeps runtime data (`jobs.json`, `state.json`, `stats.json`, and `koe.db`) on a mounted volume so a container recreate does not wipe issued keys, usage counters or job metadata — set `KOE_DB_PATH=/data/koe.db` alongside `KOE_STATE_FILE`/`KOE_JOBS_FILE`/`KOE_STATS_FILE`.

> `render.yaml` remains in the repo as a legacy blueprint. It is not the production target.

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
        "TTS_STUDIO_URL": "https://koe.kennedyazeru.space"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add koe-tts \
  -e TTS_STUDIO_URL=https://koe.kennedyazeru.space \
  -- node C:/Users/User/koe/mcp/index.js
```

No key is required in the config. On first use the MCP asks `GET /keys/challenge`, answers the proof-of-work, mints the key with `POST /keys`, saves it in `~/.koe/credentials.json` (keyed by studio URL), and reuses it. Each user/install therefore gets an independent quota. If the studio starts answering `401` (for example after an upgrade that invalidates old keys), the client clears the stored key and mints a fresh one automatically. Set `TTS_API_KEY` only if you want to force a specific key (for example the operator's admin key).

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
| `KOE_SECRET` | generated | **Set this in production.** Signs download links, hashed anon subjects and key ids (keys themselves are DB rows) |
| `KOE_DB_PATH` | `./koe.db` | SQLite file holding issued keys and every counter (`keys`, `usage`, `mint_ips`, `global_usage`). One connection per process; restarts resume from it |
| `API_KEY` | *(none)* | Admin key: unlimited, sees all jobs |
| `KOE_REQUIRE_KEY` | `false` | Reject anonymous callers |
| `KOE_REGISTER_IP_DAY` | `3` | Free keys per IP per day |
| `KOE_HOURLY_REQUESTS` | `60` | Requests/hour per key *(legacy name: `KOE_KEY_REQ_HOUR`)* |
| `KOE_HOURLY_WORDS` | `2000` | Words/hour per key *(legacy: `KOE_KEY_WORDS_HOUR`)* |
| `KOE_DAILY_WORDS` | `20000` | Words/day per key *(legacy: `KOE_KEY_WORDS_DAY`)* |
| `KOE_ANON_REQ_HOUR` | `20` | Requests/hour per anonymous IP |
| `KOE_ANON_WORDS_HOUR` | `500` | Words/hour per anonymous IP |
| `KOE_ANON_WORDS_DAY` | `3000` | Words/day per anonymous IP |
| `KOE_MAX_JOB_WORDS` | `6000` | Per-request word cap; larger jobs are `400` before counting *(legacy: `KOE_MAX_WORDS_PER_JOB`)* |
| `KOE_MAX_CHARS_PER_JOB` | `40000` | Per-request character cap (`413`) |
| `KOE_MAX_CHARS_PER_PREVIEW` | `600` | Preview text cap |
| `KOE_GLOBAL_CONCURRENCY` | `2` | Simultaneous upstream jobs |
| `KOE_GLOBAL_QUEUE` | `20` | Max queued jobs |
| `KOE_GLOBAL_DAILY_WORDS` | `30000` | Instance-wide hard daily word ceiling *(legacy: `KOE_GLOBAL_WORDS_DAY`)* |
| `KOE_KILL_SWITCH` | `false` | `true` → `503 {"error":"temporarily_disabled"}` on every generation endpoint |
| `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` | *(unset)* | Set **both** to swap the proof-of-work issuance gate for Cloudflare Turnstile |
| `KOE_AUDIO_TTL_SEC` | `900` | Audio zip lifetime |
| `KOE_JOB_TTL_SEC` | `3600` | Job metadata lifetime |
| `KOE_PREVIEW_TTL_SEC` | `600` | Preview file lifetime |
| `KOE_SWEEP_INTERVAL_SEC` | `60` | Cleanup sweep interval |
| `KOE_COOLDOWN_SEC` | `60` | Base upstream failure cool-down (doubles, max 10 min) |
| `KOE_STATE_FILE` | `.koe-state.json` | Only the generated `KOE_SECRET` fallback — counters live in SQLite |
| `KOE_OUTPUT_DIR` | `./output` | Runtime audio/work/job directory |
| `KOE_JOBS_FILE` | `output/jobs.json` | Job metadata file |
| `KOE_STATS_FILE` | `.koe-stats.json` | Persisted traffic/voiceover counters used by `/stats` |
| `KOE_PUBLIC_URL` | request origin | Absolute base used in hosted-MCP download links (set it if you run behind a proxy) |
| `KOE_MCP_INLINE_AUDIO_MAX` | `3145728` | Max bytes of audio to inline in an MCP response; `0` returns only the link |
| `KOE_MCP_POLL_MS` | `2000` | How often hosted `generate_voiceover` polls a job |

## Operator analytics

`/stats.html` is a public shell; its numbers come from the admin-only `/stats.json`. Open the page, paste `API_KEY`, and it reads:

- **Traffic** — all HTTP hits, voiceover jobs, MCP calls, previews, downloads, and new keys, all-time and today.
- **Product users** — unique subjects with a real product action (voiceover, MCP call, preview, download, or registration) in the last 5 minutes / hour / 24 hours.
- **Visitors** — all unique subjects, including crawlers and page loads. The dashboard shows these separately so bot traffic cannot inflate the user count.
- **Request sources** — top subjects by HTTP requests; **Voiceover users** — top subjects by words generated.
- **Daily ledger** — 14 days of counters.

Counters persist to `KOE_STATS_FILE` (default `.koe-stats.json`; `/data/stats.json` in the production container). Anonymous visitor ids are keyed HMACs from `guard.anonSubject()`, never raw IPs. Older raw-IP records are migrated on load. Job and audio data remain ephemeral.

---

## Notes

- edge-tts is free but unofficial (Microsoft's consumer endpoint); occasional throttling is expected. The circuit breaker pauses new work briefly instead of hammering it.
- Very long scripts are split into ~3000-char parts by the studio; the MCP merges them back into a single file (MP3s concatenated, WAVs re-muxed properly).
- Tests: `npm test` (34 tests: guard limits, key auth, tenant isolation, validation, ephemeral cleanup, analytics privacy/accounting, hosted MCP handshake and signed audio links).
