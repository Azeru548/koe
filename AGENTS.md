# AGENTS.md — How to use Koe TTS Studio

This repo is a self-hosted text-to-speech studio plus an **MCP server** (`mcp/`). If you are an AI agent, this file is your complete reference for generating voiceover audio on demand — no ElevenLabs, no paid APIs. Everything below was verified against the actual code.

```
you (agent) ──MCP tools──> mcp/index.js ──HTTPS──> TTS Studio (localhost or Render) ──> edge-tts/piper ──> MP3/WAV
                                        └── saves the audio file(s) to a local folder and returns the path(s)
```

## TL;DR

1. Call `generate_voiceover` with the script text and (optionally) a voice id.
2. It returns JSON whose `files` array holds a **local absolute path** to the finished MP3.
3. Use that file (ffmpeg, Remotion, HyperFrames, an editor, ...) in your video project.
4. If anything fails, call `studio_status` first — it tells you if the server is reachable, asleep, or missing an engine.

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
  "studioUrl": "https://your-service.onrender.com"
}
```

Reading it:
- `backend: "native"` = the server runs the `edge-tts`/`piper` CLIs directly (Render). `"docker"` = local Docker images.
- `engines.edge` / `engines.piper` = which engines are actually usable. If `engines.piper` is `false`, requests with `engine: "piper"` will 503.
- `authRequired: true` = the server demands an API key; if you get 401s, your `TTS_API_KEY` is wrong or missing.

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
| `cleanup` | boolean | `true` | Deletes the job + zip from the server after download. Set `false` to keep it downloadable via HTTP. |

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
  "wordCount": 42
}
```

- `files` — absolute local paths. Usually one file. If merging failed (rare WAV-format mismatch), you get several `*.partNN.wav` files and a `note` explaining it.
- `format` — `"mp3"` for edge, `"wav"` for piper.
- Output location: `VOICEOVER_DIR` env var, else `./voiceovers` relative to the **agent's working directory**.

Timing reality check: a short sentence takes ~2–5 s on a warm server. On the Render free plan the instance sleeps after ~15 min idle; the first call then takes up to ~60 s (the MCP's 120 s HTTP timeout covers this). A multi-thousand-word script can take minutes — raise `timeout_seconds`.

### `get_voiceover_status`

Check one job by id — use it after a `generate_voiceover` timeout (the error message contains the job id) or for jobs started elsewhere.

| Param | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | The `jobId` from a generate call. |

Returns the raw job object (see §3 for the shape and status values).

### `list_recent_voiceovers`

The 10 newest jobs on the server (newest first), before any cleanup: `{ id, status, voice, engine, wordCount, createdAt, error }` per job. Useful for answering "did my job land?" across sessions.

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

1. `get_voiceover_status(job_id)` → when `status` is `"done"`, the zip is on the server (unless the server restarted — Render's disk is ephemeral).
2. The MCP has no "download by id" tool, so fetch it over HTTP and unzip (the zip holds `part_001.mp3`, `part_002.mp3`, ... in order):

```bash
curl -H "x-api-key: $TTS_API_KEY" -o job.zip "$TTS_STUDIO_URL/download/<jobId>"
```

3. If the job is `failed`, read its `error` field and fix the input (bad voice id, engine unavailable, ...). If the job vanished entirely (404/410), just call `generate_voiceover` again.

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
  "createdAt": "2026-10-19T14:33:20.101Z",
  "completedAt": "2026-10-19T14:33:31.900Z",
  "file": "1792426000000-ab12c.zip",
  "error": null,
  "progress": 100
}
```

`status` walks through: `"processing"` → `"generating (i/n)"` while parts run → `"done"` or `"failed"` (then `error` holds the message). `progress` (0–100) appears once the first part finishes. Treat anything not `done`/`failed` as still running.

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

Use this when you are not running through the MCP (scripts, curl, another runtime) or for the recovery flow in §2. All endpoints except `/health` require auth when the server has a key: header `x-api-key: <key>`, or `Authorization: Bearer <key>`, or `?key=<key>`.

Base URL: local `http://localhost:3000`, or your Render URL.

| Endpoint | Method | Body / params | Returns |
| --- | --- | --- | --- |
| `/tts` | POST | `{ text, voice?, rate?, pitch?, engine? }` (same semantics as the MCP tool) | `{ jobId, parts, wordCount }` — immediately; synthesis runs in the background |
| `/job/:id` | GET | — | Job object (§3); 404 if unknown |
| `/download/:id` | GET | — | ZIP of parts (`part_001.mp3`, ...); `409` if not done yet, `410` if the file is gone (server restart), `404` unknown |
| `/jobs` | GET | — | All jobs, newest first |
| `/job/:id` | DELETE | — | `{ deleted: "<id>" }`; removes job + zip |
| `/tts-preview` | POST | `{ voice?, text?, rate?, pitch? }` | Streams a preview MP3 directly (`audio/mpeg`), edge only |
| `/tts-preview-piper` | POST | `{ voice?, text? }` | Streams a preview WAV, piper only |
| `/health` | GET | — | See §1 `studio_status`; never requires auth |
| `/` | GET | — | The studio web UI |

Status codes: `400` bad input (empty text, invalid engine), `401` missing/wrong key, `404` unknown job, `409` job not ready, `410` zip gone, `503` engine unavailable on this server (e.g. `piper` where `engines.piper` is false). Request body limit is 10 MB.

---

## 7. Failure modes & how to react

| Symptom | Cause | What to do |
| --- | --- | --- |
| First call takes ~60 s, then works | Render free instance was asleep | Nothing — the MCP already waits this out. Raise `timeout_seconds` for very long scripts. |
| `Could not reach the TTS Studio at <url> (...)` | Server down, wrong URL, or instance asleep/deleted | Call `studio_status`. Verify `TTS_STUDIO_URL`. On Render, check the service is still deployed (free instances can be paused after 30 days inactive). |
| `TTS Studio rejected the API key (401)` | `TTS_API_KEY` missing or not matching the server's `API_KEY` | Fix the key in your MCP config. |
| `503 — Engine 'piper' is not available` | The server has no piper installed | Use `engine: "edge"`. |
| `Timed out after Ns waiting for job <id>` | Script too long / slow instance | The job continues server-side — recover it per §2, or re-run with a bigger `timeout_seconds`. |
| Occasional edge-tts network error / rate limit | Microsoft's free consumer endpoint throttling | Retry once or twice; it almost always clears. |
| Several `*.partNN.mp3` files instead of one | Parts couldn't be merged (WAV format mismatch; MP3 always merges) | Use the parts in order — they concatenate cleanly in any editor. |
| Job works locally, 410 on Render | Render's filesystem is ephemeral (redeploys/sleep wipe zips) | Re-generate. The MCP downloads immediately, so this only bites with `cleanup: false`. |

## 8. Limits & etiquette

- edge synthesis timeouts: 5 min per part on the server; piper: 10 min.
- The Render free plan is 0.1 CPU / 512 MB — serialize big jobs (one at a time); don't fan out parallel generations.
- edge-tts is free but unofficial (Microsoft's consumer endpoint). It is fine for personal voiceovers; don't hammer it.
- Keep `API_KEY` set on the deployed server — an open URL will get burned.

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
        "TTS_STUDIO_URL": "https://your-service.onrender.com",
        "TTS_API_KEY": "<API_KEY from the Render dashboard>"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add koe-tts \
  -e TTS_STUDIO_URL=https://your-service.onrender.com \
  -e TTS_API_KEY=<API_KEY> \
  -- node C:/Users/User/koe/mcp/index.js
```

Any other MCP client: same command + env shape. One-time `cd mcp && npm install` is required.

| Env var | Default | Meaning |
| --- | --- | --- |
| `TTS_STUDIO_URL` | `http://localhost:3000` | Studio base URL (local or Render) |
| `TTS_API_KEY` | *(none)* | API key, if the server requires one |
| `VOICEOVER_DIR` | `./voiceovers` (relative to agent cwd) | Where audio files are saved |

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
