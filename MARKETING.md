# Koe — marketing plan

Written 2026-11-20, against the live instance. Companion to `LAUNCH.md` (the
Product Hunt kit); this file is everything that happens *before* PH day.

---

## 0. The diagnosis, in numbers

Day one of the social announcement (`/stats.json`, 2026-11-20 08:43Z):

| | |
| --- | --- |
| Visitors (24 h) | **9** |
| People who generated audio | **2** |
| Voiceovers | 5 · 184 words |
| Downloads | 5 (5/5 — nobody hit the 15-min expiry) |
| MCP tool calls | 21 (4 turned into audio) |
| Throttling | none: 0 active / 0 queued of 4 slots |

Two facts, and they pull in different directions:

1. **The product converts.** 2 of 9 visitors generated audio; downloads match
   voiceovers one-for-one; agents are calling tools unprompted. Nothing in the
   funnel needs fixing.
2. **The reach is the problem.** Nine visitors in 24 h is not a launch, it is a
   post nobody saw. Marketing from here is *distribution*, not copywriting.

So: don't rewrite the site, don't add features. Get the film in front of people
who already want a voice for their agent, and make Koe findable where they look.

---

## 1. Positioning (locked — reuse verbatim)

**One line:** Give your agent a voice — free, no API bill

**Three proof points, in this order:**
- A hosted **MCP server**: six tools over Streamable HTTP, so Claude Code,
  Cursor or any client can generate a voiceover mid-task.
- **Four engines** — Microsoft neural (`edge`), offline `piper`, `kokoro`,
  `kitten` — and dozens of voices, MP3 or WAV.
- **Free key, no account, no card.** 60 requests/hour, 2,000 words/hour. Audio
  is deleted after 15 minutes, so nothing piles up.

**Audiences, in priority order:**
1. Agent builders (Claude Code / Cursor / MCP users) who hit "I need audio" in a
   pipeline and don't want an API bill.
2. Video and faceless-channel creators tired of ElevenLabs pricing.
3. Self-hosters who want TTS on their own box (the Docker path).

**Never say:** open source (`LICENSE` is proprietary, all rights reserved).
Say "free to use". **Never** put a word count of 6,000 in copy — the live
per-job cap is **2,000 words / 40,000 characters**; the wider number is stale in
`AGENTS.md`.

---

## 2. Lever 1 — MCP directories (do this first, it is the whole game)

An MCP server is found by being in the registries agents and humans search. This
is free, mechanical, and outlives any single post.

Submit in this order:

| # | Where | How | Cost | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Official MCP Registry** | `mcp-publisher` with a `server.json` pointing at the **remote** URL, domain proof for `koe.kennedyazeru.space` | free | Do this first: PulseMCP, GitHub's registry and Glama all ingest it |
| 2 | **Smithery** | `smithery.ai/new`, paste `https://koe.kennedyazeru.space/mcp` | free | It *scans* your server — see the auth catch below |
| 3 | **Glama** | "Add MCP Server" form (display name + short description) | free | It health-checks and grades; a 100 % uptime badge is worth having |
| 4 | **awesome-remote-mcp-servers** | one-line PR (remote servers only) | free | Highest-visibility list for hosted servers |
| 5 | **awesome-mcp-servers** | one-line PR — **needs a Glama badge** | free | 92k stars; days-to-weeks review |
| 6 | **mcp.so**, **mcpservers.org**, **LobeHub**, **cursor.directory**, **mcpserverlist** | web form each | free (mcp.so has a $39 fast lane) | Do them in one sitting |
| 7 | **Docker MCP Catalog** | PR to `docker/mcp-registry` | free | Later — the repo already has a Dockerfile |
| — | **PulseMCP** | *skip* | — | Submissions are paused; it says it will pull from the official registry |

**The auth catch — fix this before submitting to Smithery or Glama.** Both
inspect and health-check the server. `POST /mcp` *always* requires a live key
(`AGENTS.md` §0), so their scan gets a `401` and the listing shows as unhealthy
or empty. Serve a static, keyless description at:

```
GET /.well-known/mcp/server-card.json
```

with name, description, the six tool names + one-line schemas, and the transport
`streamable-http`. ~40 lines in `server.js`, public path, no key. Without it you
will be listed as broken; with it, Smithery publishes on the spot.

**Also, every description must carry the key line**, because a directory user
who pastes the URL into Claude gets a 401 and blames you:

> Free key at https://koe.kennedyazeru.space/mcp — sign in, press *Create key*,
> paste it as the bearer token. No account, no card.

**Listing copy, ready to paste** (same everywhere, keeps the directories
consistent):

- **Name:** Koe TTS Studio
- **Short (60–80 ch):** Free text-to-speech for your AI agent. No API bill.
- **Long:** Koe gives any MCP client a voice: one hosted endpoint, six tools
  (generate, status, voices, usage, recent, health), four engines and dozens of
  voices, MP3 or WAV. A free key is minted on the setup page — no account, no
  card, 60 requests/hour. Generated audio is ephemeral and deleted after 15
  minutes.
- **Endpoint:** `https://koe.kennedyazeru.space/mcp` · **Setup:**
  `https://koe.kennedyazeru.space/mcp` · **Docs:** `.../docs`
- **Tags:** text-to-speech, audio, voice, tts, media

---

## 3. Lever 2 — the film, cut for where people actually watch

The asset is **42 s, 3840×2160, horizontal**, and it is good. On a phone in a
feed that is the wrong shape and it is too long. Three cuts, all from the same
timeline:

| Cut | Spec | Where |
| --- | --- | --- |
| **A** | 42 s, 1080×1920 vertical, burned-in captions | Reels, TikTok, Shorts |
| **B** | 15 s vertical — the reveal + one line of proof | Shorts, X, LinkedIn |
| **C** | 9 s loop, 1080×1080 — the product generating a line | X, LinkedIn |

Rules that decide whether these work:
- **Burned-in captions**, always. Most feed plays are muted.
- **First 1.5 s is the promise**, not the logo — "your agent, with a voice".
- **Vertical means re-laying out the text**, not centre-cropping the 4K cut: the
  compositions are 16:9 and a crop slices the copy. Re-render at 1080×1920 from
  the storyboard.
- Post the vertical cuts **before** the horizontal one on every feed, and keep
  the 4K master for YouTube and the PH gallery.

---

## 4. Lever 3 — community posts (copy below, edit the voice to yours)

Post in this order, one per day, never the same text twice.

**X / short form**
> Your agent can write the script but it can't say it out loud.
>
> Koe is a free MCP server that gives it a voice: any Claude Code / Cursor
> session, six tools, four engines, MP3 back in seconds.
>
> No account. No card. No API bill.
> koe.kennedyazeru.space

**Thread (5 posts)**
1. The hook above.
2. "The setup is one line: `https://koe.kennedyazeru.space/mcp`, then paste the
   free key the page mints for you. No signup screen, no credit card, nothing to
   install if your client speaks Streamable HTTP."
3. "What it actually does: `generate_voiceover` takes your script, returns a file
   path. `list_voices`, `get_usage`, `studio_status` when something looks wrong.
   Six tools, not sixty."
4. "Why four engines: Microsoft neural for quality, piper and kokoro for offline
   and speed, kitten when you want a different read. Same six tools, one endpoint."
5. "It costs me one small box. Free tier is 60 requests/hour, 2,000 words/hour,
   and generated audio is deleted after 15 minutes. If it earns a place in your
   pipeline, buy me a malt — the free tier doesn't depend on it."

**LinkedIn**
> I built a text-to-speech service that agents can call directly, and gave it
> away: no account, no card, a free key that is minted on the setup page.
>
> The reason is boring. Every voiceover I needed for a product film meant another
> API bill and another dashboard. Koe is one hosted MCP endpoint — an agent asks
> for a line, gets an MP3 back, and the audio is deleted after 15 minutes so
> nothing accumulates.
>
> It runs on one small box with four engines behind it. Free tier: 60
> requests/hour, 2,000 words/hour. Here is the 42-second film it made for
> itself, voiced by itself: [link]

**Show HN** (post on a weekday morning, PT; be in the comments for two hours)
> **Show HN: Koe – free text-to-speech MCP server, no API key to buy**
>
> I kept needing voiceover audio inside agent pipelines and kept landing on
> per-character pricing, so I built the thing I wanted: a hosted MCP server with
> six tools, four TTS engines (Microsoft neural, piper, kokoro, kitten), and a
> free key that the setup page mints for you — no account, no card.
>
> Quotas are per key: 60 requests/hour, 2,000 words/hour, 2,000 words per job.
> Generated audio is deliberately ephemeral (deleted after 15 min) because it is
> meant to be downloaded by the agent, not stored by me. The whole thing runs on
> one EC2 box behind Caddy, so concurrency is 4 and the queue is 20 — it is a
> free service, not a startup.
>
> Endpoint: https://koe.kennedyazeru.space/mcp (Streamable HTTP, bearer key).
> Setup page with the key: https://koe.kennedyazeru.space/mcp — [docs]
>
> Happy to answer anything about the quota/queue design or the engines.

**Reddit** — read each sub's self-promo rules first; the honest version:
- r/SideProject, r/ClaudeAI, r/mcp, r/cursor: the Show HN text works.
- r/LocalLLaMA: only pitch the **offline** engines (piper / kokoro / kitten) and
  the self-host path — that sub will punish a cloud-service pitch.

**Do not:** ask for upvotes anywhere, claim open source, or spam the same text
across subs in one hour.

---

## 5. Cadence

| Day | Do |
| --- | --- |
| 1 | `server-card.json` shipped → Official MCP Registry → Smithery → Glama |
| 2 | Remaining directories (mcp.so, mcpservers.org, LobeHub, cursor.directory) + the two awesome-list PRs |
| 3 | Vertical cut **A** live on Reels / TikTok / Shorts; X thread |
| 4 | LinkedIn post + cut **B** |
| 5 | Show HN (morning PT), then sit in the comments |
| 6 | r/SideProject + r/mcp post; answer everything |
| 7 | "What I learned giving away a TTS server for a week" post with real numbers from `/stats.json` |
| 8+ | Product Hunt, per `LAUNCH.md` — you now have a week of numbers to answer "who uses this" in the comments |

---

## 6. Measurement

`GET /stats.json?key=<API_KEY>` (admin) is the only truthful source. Watch:

- `windows["24h"].visitors` and `.users` — reach and product use.
- `today.tts`, `today.downloads`, `today.words` — did anyone *finish*.
- `days[]` — compare the day after each post to the day before it.
- `slots` — should stay idle; if not, it is working.

Targets for two weeks of directories + film: **50 visitors/day**, 20 %
visitor→voiceover, 3 new keys/day. At 2 users and 184 words/day today you are at
under 1 % of the 30,000-word daily ceiling, so capacity is a non-issue until
launch day.

Two blind spots worth closing, both small:
- `registers` counts `POST /api/register` only, but the MCP mints through
  `POST /keys` — **signups are undercounted** on the dashboard.
- There is no referrer breakdown, so you cannot say which platform earned the
  click. Caddy's access log has the `Referer`; the dashboard does not.

---

## 7. Guardrails

- One person, one small box: **never** post two "go try it" pushes the same day,
  and don't fan out parallel generations anywhere.
- Say the limits out loud in public copy. "Free, 60 req/hour, 2,000 words/hour,
  audio deleted after 15 min" builds more trust than a vague "unlimited".
- Support address is on the site (`pixelpro548@gmail.com`, landing/mcp/docs
  footers) — point to it rather than to DMs you will not read.
