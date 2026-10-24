# AGENTS.md — How to use Koe TTS Studio

This repo is a self-hosted text-to-speech studio plus an **MCP server** (`mcp/`). If you are an AI agent, this file is your complete reference for generating voiceover audio on demand — no ElevenLabs, no paid APIs. Everything below was verified against the actual code.

It is also a **free public product**: every MCP install auto-registers its own signed free key, quotas are enforced per tenant, and generated audio is **ephemeral** (deleted automatically).

```
you (agent) ──MCP tools──> mcp/index.js ──HTTPS──> TTS Studio ──> edge-tts/piper ──> MP3/WAV
                                        │                │
                                        │                └── audio deleted after ~15 min
                                        └── auto free key in ~/.koe/credentials.json
                                        └── saves the audio file(s) to a local folder and returns the path(s)
```

## TL;DR

1. Call `generate_voiceover` with the script text and (optionally) a voice id.
2. The MCP auto-registers/reuses a free tenant key, so there is nothing to pay for or configure.
3. It returns JSON whose `files` array holds a **local absolute path** to the finished MP3.
4. Use that file (ffmpeg, Remotion, HyperFrames, an editor, ...) in your video project.
5. If anything fails, call `studio_status` (and `get_usage` for quota) — it tells you if the server is reachable, asleep, rate-limited, or missing an engine.

**Free-tier limits at a glance** (all env-tunable): a registered key gets **60 requests/hour, 2,000 words/hour, 20,000 words/day**. Anonymous callers get 20/500/3,000. The whole instance shares **2 concurrent jobs, a 20-job queue, and 30,000 words/day**. One job may be at most **6,000 words / 40,000 characters**. Audio expires after **900 s**; job metadata after **1 hour**. Hit a limit → `429` with `retryAfterSeconds`.


---

## 0. Hosted endpoint — no install (recommended for end users)

The studio serves the same tools over **Streamable HTTP** at `POST /mcp`, so an
agent can connect by URL instead of running `mcp/index.js`:

```
POST https://koe.kennedyazeru.space/mcp
Authorization: Bearer koe_sk_...        (or: x-api-key: koe_sk_...)
```

- **Stateless**, JSON responses (no SSE), safe behind the Caddy reverse proxy.
- `GET /mcp` with `Accept: text/html` is the human setup page (tabs for Claude,
  Claude Code, Cursor, and a copy-paste "set this up for me" agent prompt).
- The caller's free key is re-used for every tool call, so per-key limits and
  tenant isolation apply exactly as in the HTTP API.
- `generate_voiceover` returns a **short-lived signed `downloadUrl`**
  (`GET /audio/:id?dl=...`, no key needed) plus inline base64 audio for short
  clips — it cannot write to the caller's disk.
- `POST /mcp` without a key returns `401` when `KOE_REQUIRE_KEY=true`.

Use the stdio server below when the agent can save files locally.

---

## 1. MCP tools

Transport: stdio. Server name: `koe-tts-studio`. All tool results are `content: [{ type: "text", text: <JSON string> }]`. On failure the result carries `isError: true` and the text starts with `Error: `.

### `studio_status`

Pings the studio's `/health`. **Call this first whenever a generate call fails.**

- Parameters: none
- Returns (pretty-printed JSON):

```json
{
  "status": "ok",
  "uptime": 8328,
  "jobs": 9,
  "time": "2026-10-19T14:30:17.135Z",
  "backend": "native",
  "engines": { "edge": true, "piper": false },
  "authRequired": true,
  "adminKeyConfigured": false,
  "keyRequired": true,
  "freeKeys": true,
  "queue": { "active": 0, "queued": 0, "concurrency": 2, "queueMax": 20 },
  "ephemeral": { "audioTtlSeconds": 900, "jobTtlSeconds": 3600 },
  "limits": { "register": { "keysPerIpPerDay": 3 }, "key": { "requestsPerHour": 60, "wordsPerHour": 2000, "wordsPerDay": 20000 }, "anon": { "requestsPerHour": 20, "wordsPerHour": 500, "wordsPerDay": 3000 }, "perJob": { "maxWords": 6000, "maxChars": 40000, "maxPreviewChars": 600 }, "global": { "concurrency": 2, "queueMax": 20, "wordsPerDay": 30000 }, "audio": { "ttlSeconds": 900, "jobTtlSeconds": 3600, "note": "Generated audio is ephemeral: it is deleted automatically. Download promptly." }, "keyRequired": true },
  "studioUrl": "https://koe.kennedyazeru.space",
  "client": {
    "keyMode": "auto",
    "credentialsFile": "C:/Users/You/.koe/credentials.json",
    "usage": { "subject": "key", "usage": { "hour": { "requests": 1, "words": 42, "requestsLimit": 60, "wordsLimit": 2000, "resetsInSeconds": 2100 }, "day": { "requests": 1, "words": 42, "wordsLimit": 20000, "resetsInSeconds": 50000 } } }
  }
}
```

Reading it:
- `backend: "native"` = the server runs the `edge-tts`/`piper` CLIs directly (the production Docker image). `"docker"` = local Docker images.
- `engines.edge` / `engines.piper` = which engines are actually usable. If `engines.piper` is `false`, requests with `engine: "piper"` will 503.
- `keyRequired: true` = the server requires a free key. The MCP registers one automatically; `client.keyMode` is `env` (explicit `TTS_API_KEY`), `stored`, `auto`, or `none`.
- `queue` / `limits` = current queue depth and the public rate policy. `ephemeral` = how long audio and jobs live.
- `client.usage` = this install's current window (same shape as the `get_usage` tool; `null` if no key yet).

### `list_voices`

Lists the curated voice catalog (same list the studio UI shows).

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `engine` | `"edge" \| "piper"` | `"edge"` | `edge` = Microsoft neural voices (cloud, many languages). `piper` = offline voice on the server host. |
| `lang` | string, optional | — | Prefix filter: `"en"`, `"en-GB"`, `"fr"`, `"pt-BR"`, ... Case-insensitive. |

Returns an array of `{ "id", "name", "lang", "gender", "style" }`. The `id` is what you pass as `voice` to `generate_voiceover`. An unmatched filter returns an `isError` result telling you to list unfiltered.

**Note:** voices come from this static catalog (`mcp/index.js`), not from a server endpoint. Any valid Microsoft voice *name* also works as the `voice` string — the server passes it straight to `edge-tts` — but stick to catalog ids unless you have a specific reason not to.

### `generate_voiceover`

The main tool. Submits a TTS job, polls it to completion, downloads the result, **merges multi-part jobs into a single file**, saves it locally, and returns the path.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `text` | string, required | — | The script. Paragraph breaks allowed; blank-line-separated paragraphs are synthesized as separate parts (see §4). |
| `voice` | string | `"en-US-GuyNeural"` | Voice id from `list_voices`. |
| `engine` | `"edge" \| "piper"` | `"edge"` | `edge` supports rate/pitch and is much higher quality. |
| `rate` | number 0.5–2 | `1` | Speed multiplier. 1 = normal, 1.25 = brisk, 0.85 = deliberate. |
| `pitch` | integer −100–100 | `0` | Pitch shift in Hz. |
| `file_name` | string, optional | `voiceover-<jobId>` | Output name without folder; `.mp3`/`.wav` suffix optional (it is added for you). Folders/special chars are sanitized. |
| `timeout_seconds` | integer 30–900 | `300` | How long to wait before giving up (the server keeps working). |
| `cleanup` | boolean | `true` | Deletes the job + zip from the server after download. Audio is deleted automatically after ~15 min even if you set `false`. |

Success result:

```json
{
  "files": ["C:/voiceovers/intro-narration.mp3"],
  "merged": true,
  "format": "mp3",
  "jobId": "1792426000000-ab12c",
  "voice": "en-US-GuyNeural",
  "engine": "edge",
  "parts": 1,
  "wordCount": 42,
  "expiresInSeconds": 894,
  "note": "The studio audio is ephemeral; your local file is the permanent copy."
}
```

- `files` — absolute local paths. Usually one file. If merging failed (rare WAV-format mismatch), you get several `*.partNN.wav` files and a `note` explaining it.
- `format` — `"mp3"` for edge, `"wav"` for piper.
- `expiresInSeconds` — how long the studio keeps its server-side copy; the local file never expires.
- Output location: `VOICEOVER_DIR` env var, else `./voiceovers` relative to the **agent's working directory**.

**Rate limits/errors:** the MCP retries once automatically when the queue is full or the upstream is cooling down (`429`/`503` with a short `retryAfterSeconds`). A persistent `429` means the tenant's hourly/daily words or requests are exhausted — wait for the reset or check `get_usage`. A `413` means the script exceeds 6,000 words / 40,000 chars per job.

Timing reality check: a short sentence takes ~2–5 s on a warm server. The public instance is a small EC2 box with a 2-job concurrency limit; if the container was just restarted, allow the first call a little longer. A multi-thousand-word script can take minutes — raise `timeout_seconds`.

### `get_voiceover_status`

Check one job by id — use it after a `generate_voiceover` timeout (the error message contains the job id) or for jobs started elsewhere.

| Param | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | The `jobId` from a generate call. |

Returns the raw job object (see §3 for the shape and status values). Jobs are tenant-isolated and expire after `jobTtlSeconds` (default 1 hour) — a `404` means it is gone; regenerate.

### `list_recent_voiceovers`

Your 10 newest jobs (newest first): `{ id, status, voice, engine, wordCount, createdAt, completedAt, expiresInSeconds, error }` per job. Tenant isolation means you never see another user's jobs.

### `get_usage`

No parameters. Returns this install's free-tier window:

```json
{
  "keyMode": "auto",
  "subject": "key",
  "usage": {
    "hour": { "requests": 3, "words": 812, "requestsLimit": 60, "wordsLimit": 2000, "resetsInSeconds": 1830 },
    "day":  { "requests": 3, "words": 812, "wordsLimit": 20000, "resetsInSeconds": 59000 }
  }
}
```

Use it before a very long batch, or after a `429`, to decide whether to wait.

---

## 2. Recipes

**Standard narration (most video work):**

```
list_voices(lang: "en")            → pick an id
generate_voiceover(
  text: "<your script>",
  voice: "en-US-AndrewNeural",
  rate: 1.05,
  file_name: "scene-01-narration"
)
→ files[0] is the MP3; feed it to your video pipeline
```

**Several scenes = several calls.** Generate one file per scene with ordered names (`scene-01-...`, `scene-02-...`) so they land in a predictable sequence. Keep `voice` and `rate` identical across scenes for a consistent read.

**Recovering a timed-out job** (the generate call reported a timeout; the server may have finished anyway):

1. `get_voiceover_status(job_id)` → when `status` is `"done"`, check `expiresInSeconds`; audio is ephemeral (default 15 min), and the server may also have restarted.
2. The MCP has no "download by id" tool, so fetch it over HTTP and unzip (the zip holds `part_001.mp3`, `part_002.mp3`, ... in order). Use your key from `TTS_API_KEY` or from `~/.koe/credentials.json`:

```bash
curl -H "x-api-key: $TTS_API_KEY" -o job.zip "$TTS_STUDIO_URL/download/<jobId>"
```

3. If the job is `failed`, read its `error` field and fix the input (bad voice id, engine unavailable, ...). If the job vanished entirely (`404`) or the audio expired (`410`), just call `generate_voiceover` again. A `403` means the job belongs to a different tenant/key.

**Piper (offline) voice:** `generate_voiceover(text: ..., engine: "piper")` — no rate/pitch, slower on a free instance, returns WAV. Only if `studio_status` shows `engines.piper: true`.

---

## 3. Job object & status values

The server's job JSON (returned by `GET /job/:id`):

```json
{
  "id": "1792426000000-ab12c",
  "status": "done",
  "voice": "en-US-GuyNeural",
  "engine": "edge",
  "rate": 1,
  "pitch": 0,
  "parts": 2,
  "wordCount": 812,
  "words": 812,
  "textChars": 4633,
  "createdAt": "2026-10-19T14:33:20.101Z",
  "completedAt": "2026-10-19T14:33:31.900Z",
  "audioExpiresAt": "2026-10-19T14:48:31.900Z",
  "audioDeletedAt": null,
  "expiresInSeconds": 894,
  "file": "1792426000000-ab12c.zip",
  "error": null,
  "progress": 100
}
```

`status` walks through: `"queued"` → `"generating (i/n)"` while parts run → `"done"` or `"failed"` (then `error` holds the message). `progress` (0–100) appears once the first part finishes. Treat anything not `done`/`failed` as still running.

After the audio TTL, `file` becomes `null`, `audioDeletedAt` is set, and `GET /download/:id` returns `410`. The job object itself is pruned after `jobTtlSeconds` (default 1 hour). The job's `tenant` id is never exposed in API responses.

---

## 4. Script formatting rules (edge engine)

- **Single newlines / continuous prose** = one synthesized chunk → most natural prosody. Use this for normal narration.
- **Blank lines** start a new part (each blank-line-separated paragraph is synthesized separately, then merged into one file). Use deliberately — e.g. to chunk a very long script or force a hard breath between sections.
- The server auto-splits any paragraph longer than ~3000 characters at sentence boundaries, so you never need to pre-chunk. Very long scripts just report a higher `parts` count.
- Numbers, abbreviations and punctuation are pronounced by Microsoft's neural voices; write numbers the way you want them spoken ("2026" vs "two thousand twenty-six").

## 5. Parameters: what actually matters

- `rate` is the workhorse for video pacing — narration over visuals often reads better at 1.05–1.2.
- `pitch` is a ±Hz shift, not semitones; keep it within ±20 unless you want an effect.
- edge voices carry the "style" hint in their catalog entry (News, Warm, Conversational...) — pick the style to match the piece rather than the gender alone.
- Piper ignores rate/pitch entirely.

---

## 6. Direct HTTP API (no MCP required)

Use this when you are not running through the MCP (scripts, curl, another runtime) or for the recovery flow in §2. Public endpoints are `/health`, `/api/register`, `/api/limits`, `/`, and `/studio`. Everything else accepts a free tenant key via header `x-api-key: <key>`, `Authorization: Bearer <key>`, or `?key=<key>`; when `KOE_REQUIRE_KEY=true`, a key is mandatory for those routes. The operator's `API_KEY` is an unlimited admin key.

Base URL: local `http://localhost:3000`, or your hosted URL.

| Endpoint | Method | Body / params | Returns |
| --- | --- | --- | --- |
| `/api/register` | POST | — (empty body) | `{ key, tenant, limits }` — a free tenant key; capped per IP/day |
| `/api/limits` | GET | — | Public rate policy (no secrets) |
| `/usage` | GET | — | This caller's usage vs limits (admin → `{ unlimited: true }`) |
| `/stats.html` | GET | — | Operator dashboard page (loads without a key; its data needs the admin key) |
| `/stats.json` | GET | — | The same numbers as JSON — admin key required |
| `/tts` | POST | `{ text, voice?, rate?, pitch?, engine? }` (same semantics as the MCP tool) | `{ jobId, parts, wordCount }` — immediately; synthesis runs in the background |
| `/job/:id` | GET | — | Job object (§3); 404 if unknown/expired, 403 if another tenant's |
| `/download/:id` | GET | — | ZIP of parts (`part_001.mp3`, ...); `409` if not done yet, `410` if audio expired, `404` unknown |
| `/jobs` | GET | — | This tenant's 100 newest jobs |
| `/job/:id` | DELETE | — | `{ deleted: "<id>" }`; removes job + audio |
| `/tts-preview` | POST | `{ voice?, text?, rate?, pitch? }` (text ≤ 600 chars) | Streams a preview MP3 directly (`audio/mpeg`), edge only, metered |
| `/tts-preview-piper` | POST | `{ voice?, text? }` | Streams a preview WAV, piper only, metered |
| `/health` | GET | — | See §1 `studio_status`; never requires auth |
| `/` | GET | — | Redirects to `/mcp` |
| `/studio` | GET | — | The studio web UI |

Status codes: `400` bad input (empty text, invalid engine/voice/rate), `401` missing/wrong key, `403` another tenant's job, `404` unknown job, `409` job not ready, `410` audio expired, `413` script too long (6,000 words / 40,000 chars), `429` rate/queue limit (read `retryAfterSeconds`), `503` engine unavailable or upstream cool-down. Request body limit is 10 MB.

---

## 7. Failure modes & how to react

| Symptom | Cause | What to do |
| --- | --- | --- |
| First call after a restart takes longer, then works | the container was warming up | Nothing — the MCP already waits this out. Raise `timeout_seconds` for very long scripts. |
| `Could not reach the TTS Studio at <url> (...)` | Server down, wrong URL, or instance asleep/deleted | Call `studio_status`. Verify `TTS_STUDIO_URL`. Check the EC2 instance and Caddy container; see [DEPLOY.md](DEPLOY.md). |
| `The TTS Studio rejected TTS_API_KEY (401)` | An explicit `TTS_API_KEY` is wrong, or `KOE_SECRET` was rotated | Remove `TTS_API_KEY` so the MCP auto-registers a fresh free key, or fix the key. Auto/stored keys re-register on their own. |
| `429 — Hourly/Daily word limit reached ...` | This tenant's free quota is exhausted | Read `retryAfterSeconds`, call `get_usage`, wait for the window to reset. Requests are not refunded; failed jobs refund words. |
| `429 — The synthesis queue is full` | The instance's 20-job queue is full | The MCP retries once if the wait is ≤45 s; otherwise retry shortly. |
| `503 — Synthesis is cooling down after upstream errors` | Circuit breaker tripped by repeated edge-tts failures | Wait `retryAfterSeconds` (starts at 60 s, max 10 min) and retry. |
| `503 — Engine 'piper' is not available` | The server has no piper installed | Use `engine: "edge"`. |
| `413 — Script too long` | Over 6,000 words / 40,000 chars in one call | Split into multiple `generate_voiceover` calls (one per scene) and keep the same voice/rate. |
| `Timed out after Ns waiting for job <id>` | Script too long / slow instance | The job continues server-side — recover it per §2, or re-run with a bigger `timeout_seconds`. |
| `403 — this job belongs to another tenant` | You used a different key/IP than the one that created the job | Use the same key (or the admin key). Jobs are tenant-isolated. |
| `410 — Audio expired` | The 15 min audio TTL elapsed (or the server restarted) | Regenerate. The MCP downloads immediately, so this only bites with `cleanup: false`. |
| Occasional edge-tts network error / rate limit | Microsoft's free consumer endpoint throttling | Retry once or twice; it almost always clears. |
| Several `*.partNN.mp3` files instead of one | Parts couldn't be merged (WAV format mismatch; MP3 always merges) | Use the parts in order — they concatenate cleanly in any editor. |

## 8. Limits & etiquette

- **Per registered free key:** 60 requests/hour, 2,000 words/hour, 20,000 words/day.
- **Anonymous (no key):** 20 requests/hour, 500 words/hour, 3,000 words/day.
- **Per job:** 6,000 words / 40,000 characters. Previews: 600 characters.
- **Per IP:** 3 free keys/day.
- **Instance-wide:** 2 concurrent jobs, 20-job queue, 30,000 words/day.
- **Retention:** audio 900 s, job metadata 1 hour, previews 10 min. Nothing is permanent.
- edge synthesis timeouts: 5 min per part on the server; piper: 10 min.
- The public instance is a small EC2 box — serialize big jobs (one at a time); don't fan out parallel generations.
- edge-tts is free but unofficial (Microsoft's consumer endpoint). It is fine for personal voiceovers; don't hammer it.
- Keep `KOE_SECRET` stable and `API_KEY` private on the deployed server. The free tier is deliberately bounded so the instance cannot be burned.

---

## 9. MCP registration (for the human to set up once)

Claude Desktop — `claude_desktop_config.json`:

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

Any other MCP client: same command + env shape. One-time `cd mcp && npm install` is required.

**No API key is needed in the config.** On first use the MCP calls `POST /api/register`, saves the free tenant key in `~/.koe/credentials.json` (keyed by studio URL), and reuses it forever. Each install gets its own quota. Set `TTS_API_KEY` only to force a specific key (for example the operator's admin key); doing so disables auto-registration.

| Env var | Default | Meaning |
| --- | --- | --- |
| `TTS_STUDIO_URL` | `http://localhost:3000` | Studio base URL (local or hosted) |
| `TTS_API_KEY` | *(none)* | Optional explicit key (admin or tenant); disables auto-registration |
| `VOICEOVER_DIR` | `./voiceovers` (relative to agent cwd) | Where audio files are saved |
| `KOE_CREDENTIALS_FILE` | `~/.koe/credentials.json` | Where auto-registered free keys are stored |
| `KOE_DISABLE_AUTO_REGISTER` | *(unset)* | Set to `1` to never mint a free key |

If the operator rotates `KOE_SECRET`, stored keys stop verifying; the MCP notices the `401`, clears the stale record, and registers a new free key automatically.

Smoke-test without an agent: `cd mcp && TTS_STUDIO_URL=http://localhost:3000 node test-client.js`

---

## 10. Voice catalog

Edge (Microsoft neural) — ids valid for `voice`:

| Id | Name | Lang | Gender | Style |
| --- | --- | --- | --- | --- |
| `en-US-GuyNeural` | Guy | en-US | M | News |
| `en-US-JennyNeural` | Jenny | en-US | F | Friendly |
| `en-US-AriaNeural` | Aria | en-US | F | Natural |
| `en-US-DavisNeural` | Davis | en-US | M | Chat |
| `en-US-AndrewNeural` | Andrew | en-US | M | Warm |
| `en-US-EmmaNeural` | Emma | en-US | F | Conversational |
| `en-GB-RyanNeural` | Ryan | en-GB | M | Chat |
| `en-GB-SoniaNeural` | Sonia | en-GB | F | Formal |
| `en-GB-LibbyNeural` | Libby | en-GB | F | Conversational |
| `en-AU-NatashaNeural` | Natasha | en-AU | F | Natural |
| `en-AU-WilliamNeural` | William | en-AU | M | Natural |
| `en-CA-ClaraNeural` | Clara | en-CA | F | Natural |
| `en-IN-NeerjaNeural` | Neerja | en-IN | F | Friendly |
| `es-ES-ElviraNeural` | Elvira | es-ES | F | Warm |
| `es-MX-DaliaNeural` | Dalia | es-MX | F | Friendly |
| `es-US-PalomaNeural` | Paloma | es-US | F | Casual |
| `fr-FR-DeniseNeural` | Denise | fr-FR | F | Elegant |
| `fr-CA-SylvieNeural` | Sylvie | fr-CA | F | Friendly |
| `de-DE-KatjaNeural` | Katja | de-DE | F | Professional |
| `de-DE-ConradNeural` | Conrad | de-DE | M | Professional |
| `it-IT-ElsaNeural` | Elsa | it-IT | F | Warm |
| `pt-BR-FranciscaNeural` | Francisca | pt-BR | F | Calm |
| `pt-PT-RaquelNeural` | Raquel | pt-PT | F | Warm |
| `zh-CN-XiaoxiaoNeural` | Xiaoxiao | zh-CN | F | Warm |
| `zh-CN-YunxiNeural` | Yunxi | zh-CN | M | Lively |
| `ja-JP-NanamiNeural` | Nanami | ja-JP | F | Polite |
| `ko-KR-SunHiNeural` | Sun-Hi | ko-KR | F | Bright |
| `ar-SA-ZariyahNeural` | Zariyah | ar-SA | F | Natural |
| `hi-IN-SwaraNeural` | Swara | hi-IN | F | Friendly |

Piper (offline): `en_US-lessac-medium` (male, en-US). Check `studio_status` for availability.

Microsoft ships 400+ voices; `list_voices` shows this curated set, but any official voice name (e.g. `en-US-EmmaNeural` variants like `en-US-EmmaMultilingualNeural`) usually works if passed directly — verify with a one-line `generate_voiceover` test.
