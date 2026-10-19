# Koe TTS Studio + MCP

A self-hosted text-to-speech studio (Microsoft neural voices via edge-tts, plus optional offline Piper) and an **MCP server** so your agent can generate voiceovers on demand — free, no ElevenLabs.

> **Building an agent?** [AGENTS.md](AGENTS.md) is the full agent-facing reference: exact MCP tool schemas, response shapes, recipes, error handling and the raw HTTP API.

```
your agent ──(MCP: generate_voiceover)──> mcp/index.js ──(HTTPS)──> TTS Studio (Render free tier) ──> edge-tts ──> MP3
                                                    └──> saves voiceover-*.mp3 on your machine
```

## TTS Studio server (`server.js`)

Same API as before (`POST /tts`, `GET /job/:id`, `GET /jobs`, `GET /download/:id`, previews, `GET /health`), plus:

- **Two backends** (env `TTS_BACKEND`):
  - `docker` — shells out to the `edge-tts` / `piper-tts` Docker images, exactly like before. Auto-selected when the docker CLI exists (your local setup keeps working unchanged).
  - `native` — runs the `edge-tts` / `piper` CLIs directly. Used on **Render**, where no Docker daemon exists inside the runtime container. Set automatically in the Dockerfile.
- **Optional API key** — set `API_KEY` and every route except `/health` requires it (header `x-api-key`, `Authorization: Bearer`, or `?key=`). Recommended once deployed.
- The studio UI (`index.html`) is served at `/` and now works same-origin. Open it once as `https://<your-service>/?key=<API_KEY>` and the key is remembered in that browser.
- `/health` reports `backend`, `engines` (edge/piper availability) and whether auth is on.

Local usage is unchanged: `npm install && node server.js` (docker backend) — the UI still opens from `index.html` as a file and talks to `http://localhost:3000`.

## Deploy on Render (free tier)

The repo ships a `Dockerfile` (node 20 + python `edge-tts`, no docker-in-docker needed) and a `render.yaml` blueprint.

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Web Service → connect the repo**. Render picks up `render.yaml` (blueprint) automatically — or choose **Runtime: Docker** and keep the defaults.
3. After the first deploy (~3–5 min), open the service → **Environment** → copy the generated **`API_KEY`** value.
4. Health check path is `/health` (set automatically by the blueprint).
5. Optional: open the studio UI at `https://<your-service>.onrender.com/?key=<API_KEY>`.

Free-plan realities:

- 0.1 CPU / 512 MB RAM; the instance **sleeps after ~15 min idle** and the first request after that takes ~60 s (the MCP tools wait for this).
- 750 instance-hours per month.
- The filesystem is **ephemeral**: job zips and history disappear on redeploy/sleep. The MCP downloads audio immediately, so this doesn't matter for agent use.
- Piper (offline engine) is installed best-effort in the image; if it's missing, `engines.piper` is `false` in `/health` and edge voices still work.

## MCP server (`mcp/`)

Lets any MCP-capable agent (Claude Desktop, Claude Code, etc.) generate voiceovers and get a **local file path** back.

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
        "TTS_STUDIO_URL": "https://koe-tts-studio.onrender.com",
        "TTS_API_KEY": "<API_KEY from the Render dashboard>"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add koe-tts \
  -e TTS_STUDIO_URL=https://koe-tts-studio.onrender.com \
  -e TTS_API_KEY=<API_KEY> \
  -- node C:/Users/User/koe/mcp/index.js
```

Environment variables:

| Var | Default | Meaning |
| --- | --- | --- |
| `TTS_STUDIO_URL` | `http://localhost:3000` | Base URL of the studio (local or Render) |
| `TTS_API_KEY` | *(none)* | API key, if the studio requires one |
| `VOICEOVER_DIR` | `./voiceovers` (relative to the agent's cwd) | Where generated audio files are saved |

### Tools

| Tool | What it does |
| --- | --- |
| `studio_status` | Pings `/health`; shows backend, available engines, auth. Call first if something fails. |
| `list_voices` | Voices by engine (`edge`/`piper`) and optional language filter (`en`, `fr`, …). |
| `generate_voiceover` | Narrates `text` with a chosen `voice`, `rate` (0.5–2), `pitch`; submits the job, polls it, downloads and **merges parts into one MP3/WAV**, saves it locally and returns the path. `cleanup: true` (default) deletes the job from the server afterwards. |
| `get_voiceover_status` | Job status by id (e.g. after a timeout). |
| `list_recent_voiceovers` | Last 10 jobs on the server. |

Smoke-test the wiring without an agent:

```bash
cd mcp && TTS_STUDIO_URL=http://localhost:3000 node test-client.js
```

### Notes

- edge-tts is free but unofficial (Microsoft's consumer endpoint); occasionally rate-limited — a retry usually clears it.
- Very long scripts are split into ~3000-char parts by the studio; the MCP merges them back into a single file (MP3s concatenated, WAVs re-muxed properly).
- Keep `API_KEY` set on Render — otherwise anyone with the URL can burn your free hours.
