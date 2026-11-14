---
name: koe-voiceover
description: Generate spoken narration for video, slides, podcasts or demos using the free Koe TTS Studio MCP server. Use when a task needs a voiceover track, an audio version of a script, or per-scene narration files to drop into Remotion, HyperFrames, ffmpeg or an editor. Produces MP3 (Microsoft neural voices, ~30 languages) or WAV (offline Piper), with per-key rate and word quotas.
---

# Koe voiceover

Koe is a text-to-speech studio that exposes voiceover generation as MCP tools.
You send a script, it returns finished audio. No ElevenLabs account, no key
purchase — a free tenant key is issued by the server itself and is rate-limited.

## When to use this

Use it whenever the deliverable needs **spoken audio from a script**:

- narration for a video, explainer, product demo or slideshow
- one audio file per scene, to be sequenced with visuals
- a spoken version of a blog post, README or newsletter
- placeholder voice tracks while a human records the final take

Do **not** use it for music, sound effects, voice cloning or transcription — it
only synthesises a given script into a given voice.

## Connect

Hosted, no install:

```
URL:    https://koe.kennedyazeru.space/mcp       (Streamable HTTP, stateless, JSON)
Header: Authorization: Bearer koe_sk_...        (or  x-api-key: koe_sk_...)
```

Getting the key: open <https://koe.kennedyazeru.space/mcp> in a browser and
press **Create key** — the page solves the proof-of-work challenge and shows the
key once. A key is also mintable without a browser:

1. `GET https://koe.kennedyazeru.space/keys/challenge` → `{ challenge }`
2. find a `nonce` where `sha256(challenge + nonce)` starts with `0000` (4 zero
   hex characters)
3. `POST https://koe.kennedyazeru.space/keys` with `{ challenge, nonce }` →
   `201 { key, tenant, limits }`

Keys are free, tied to a quota, and capped at **3 free keys per IP per day**. Store the key
in the client's MCP config, not in a script you might commit. If a call answers
`401 {"error":"invalid_key"}` the key was revoked or issued by an older build —
mint a new one.

Prefer the local stdio server (`mcp/index.js` from the repo) when the agent can
write files: it saves the audio to disk and returns absolute paths. The hosted
endpoint cannot write to your disk, so it returns a signed download URL instead.

## Tools

| Tool | Use |
| --- | --- |
| `studio_status` | First call on failure. Server reachability, which engines are live, queue depth, limits, `killSwitch`, `db.ok`. |
| `list_voices` | Catalog for an engine. `{ engine?: "edge" \| "piper" \| "kokoro", lang?: "en" }` |
| `generate_voiceover` | The main tool — see below. |
| `get_voiceover_status` | One job by id, after a timeout. |
| `list_recent_voiceovers` | Your 10 newest jobs. |
| `get_usage` | This key's current hour/day window before a long batch, or after a `429`. |

### `generate_voiceover`

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `text` | string, required | — | The script. |
| `voice` | string | `en-US-GuyNeural` | Id from `list_voices`. |
| `engine` | `edge` \| `piper` \| `kokoro` | `edge` | `edge` is highest quality and supports rate + pitch. |
| `rate` | number 0.5–2 | `1` | 1.05–1.2 reads well over visuals. |
| `pitch` | integer −100–100 | `0` | Hz shift, not semitones; keep within ±20. |
| `file_name` | string | `voiceover-<jobId>` | Extension added for you. |
| `timeout_seconds` | integer 30–900 | `300` | Raise it for long scripts. |
| `cleanup` | boolean | `true` | Deletes the server-side job after download. |

Success (hosted) returns `jobId`, `parts`, `wordCount`, `format`, and a
short-lived signed `downloadUrl` you can fetch without a key, plus inline audio
for short clips. **Download promptly**: server-side audio is deleted after
900 s and job metadata after 1 hour.

## Workflow

1. `studio_status` if you have never called the server in this session — confirms
   `engines.edge` is `true` and shows the live queue.
2. `list_voices(engine, lang)` once, then reuse the chosen `voice` id. Voice ids
   are **never** interchangeable between engines: an edge id sent with
   `engine: "kokoro"` is a `400` whose body lists the valid ids.
3. `generate_voiceover` per scene, with ordered names (`scene-01-intro`,
   `scene-02-body`, …) and an identical `voice` + `rate` across scenes.
4. Use the returned URL/path in the video pipeline, then discard it locally.

### Writing the script

- Continuous prose is synthesised as one chunk — the most natural prosody.
- A **blank line** starts a new part; parts are merged back into one file. Use it
  deliberately (hard section breaks), not by accident.
- Paragraphs over ~3000 characters are auto-split at sentence boundaries, so
  there is no need to pre-chunk.
- Write numbers as you want them spoken ("2026" vs "two thousand twenty-six").
- One job may be at most **6,000 words / 40,000 characters**; beyond that, split
  per scene (`400` / `413` otherwise).

## Limits

Per key: **60 requests/hour, 2,000 words/hour, 20,000 words/day**. Instance-wide:
**2 concurrent jobs**, 20-job queue, 30,000 words/day. Previews: 600 characters.

Serialize large jobs — this is a small self-hosted box, not a fleet. Do not fan
out parallel generations.

## Reacting to failures

| What you get | What to do |
| --- | --- |
| `429` with `retryAfterSeconds` | Read it and wait. `reason` distinguishes `hourly_requests`, `hourly_words`, `daily_words`, `global_daily_words`, `queue_full`, `mint_cap`. Quota is not refunded. |
| `503 {"error":"temporarily_disabled"}` | Operator kill switch — nothing to fix, retry later. |
| `503 {"error":"tts_unavailable","engine":"kokoro"}` | Optional Kokoro sidecar is down. Use `engine: "edge"`; no quota was charged. |
| `503` "cooling down after upstream errors" | Circuit breaker; wait `retryAfterSeconds` (60 s – 10 min). |
| Timeout waiting for a job | The job keeps running — `get_voiceover_status(job_id)` and fetch when `done`. |
| `401 invalid_key` | Mint a new free key (above). |
| `403` "belongs to another tenant" | You changed key or IP; jobs are tenant-isolated. |
| `410` | Audio expired (15 min TTL). Regenerate. |

When a generate call fails and the cause is unclear, call `studio_status` first:
it separates "server unreachable" from "quota" from "engine missing".

## Self-hosting

The whole studio is in this repo and runs on one small box, with an ISC licence:
`docker` + a single SQLite file for keys and counters. See `README.md` and
`DEPLOY.md`. Point `TTS_STUDIO_URL` (stdio server) or the MCP URL (hosted) at
your own instance to escape the shared quotas.
