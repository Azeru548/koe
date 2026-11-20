# Product Hunt launch kit — Koe

Everything below is copy-paste ready for the Product Hunt submission form.
Facts here were checked against the live instance on 2026-11-19.

---

## 1. Listing fields

**Name:** Koe

**Tagline (60 char max):**

```
Give your agent a voice — free, no API bill
```

Alternates (both fit): `Free text-to-speech for your AI agent` ·
`A voice for your agent, free to start`

**Description (260 char max):**

```
Koe gives any agent a voice: a hosted MCP server plus a text-to-speech studio.
Send a script, get an MP3 back — six tools, four engines, dozens of voices.
Free key, no account, no card. Generated audio is deleted after 15 minutes, so
nothing piles up.
```

**Topics:** Developer Tools · Artificial Intelligence · Productivity · SaaS

**Links:**

- Website — https://koe.kennedyazeru.space
- Docs — https://koe.kennedyazeru.space/docs
- MCP setup — https://koe.kennedyazeru.space/mcp
- Studio — https://koe.kennedyazeru.space/studio

**Do not claim:** open source. `LICENSE` says proprietary, all rights
reserved. PH voters check; claim "free to use", never "open source".

---

## 2. Maker's first comment

```
Hi PH 👋

I build agents all day, and they keep hitting the same wall: an agent can
research, write and ship a whole project, but it can't speak. Every TTS API I
tried wanted an account, a card and a per-character bill for a test.

So Koe is the version I wanted: point your MCP client at it, call
generate_voiceover, and get a local MP3 back. A free key is issued
automatically on first use — there is nothing to sign up for.

What's actually in it:
· A hosted MCP server (Streamable HTTP) — copy one line into Claude, Cursor
  or Claude Code and it works.
· A studio at /studio: paste a script, pick a voice, tune rate and pitch,
  preview instantly.
· Four engines — Microsoft's neural voices, plus offline Piper, Kokoro and
  Kitten — and dozens of curated voices across a dozen languages.

What it deliberately isn't:
· Not another API key dashboard. No accounts, no card, no "contact sales".
· Not a storage service. Audio lives 15 minutes, then it's gone — your local
  copy is the permanent one.
· Not open source. It's one person's small box; the free tier is real and
  rate-limited so it stays up for everyone.

It is free because I run it for my own videos and it had room left over. If it
earns a place in your workflow, there's a "buy me a malt" card in the nav —
it goes to the server bill, and the free tier stays the same either way.

Happy to answer anything about the limits, the engines, or why the toy is
built out of one box and a Caddy container. 🥂
```

---

## 3. Assets

**Logo:** `logo image.png` (1408×1408) — square, so it drops into PH's 240×240
slot without cropping. `assets/logo-mark.png` is the tall mark used in the nav;
it will letterbox, don't use it for the listing.

**Gallery — 5 panels, 1270×760 each (PH's ratio):**

1. Hero on the landing page — "Give your agent a voice", with the film still
   behind it.
2. The MCP one-liner as code, big and readable: `claude mcp add koe-tts …`.
3. `/studio` — voice rail, script box, generate button, waveform.
4. A frame from `videos/koe-launch/koe-en-4k.mp4` (the 42 s launch film).
5. An honest limits panel: "Free tier — 60 requests/hour, 2,000 words/hour,
   20,000 words/day per key. Audio deleted after 15 minutes."

**Video:** upload the 42 s film (`koe-en-4k.mp4`, 29.9 MB, 3840×2160). PH
re-encodes; if the upload is rejected for size, a 1080p cut works.

---

## 4. Day-of timeline (Pacific Time)

- **T-1 day:** create the draft, upload logo + gallery + video, save. Have the
  first comment ready to paste — the form keeps it separate from the listing.
- **12:01 AM PT:** publish. PH's day starts then; publishing later costs you a
  full day of ranking.
- **First 30 min:** post the maker comment immediately, then reply to
  everything for the next 3–4 hours. Replies count toward ranking.
- **Never ask for upvotes** — ask people to "check it out and leave a
  comment". Asking for votes gets listings demoted.

---

## 5. Capacity: the one real launch risk

Measured off the live instance (`/api/limits`, `/healthz`):

| limit | value |
| --- | --- |
| per key | 60 requests/h · 2,000 words/h · 20,000 words/day |
| anonymous | not used — a key is required for everything |
| per job | 2,000 words / 40,000 chars |
| **instance-wide** | **30,000 words/day**, 4 concurrent jobs, 20-job queue |

30,000 words a day is roughly **600 visitors each trying a 50-word line**.
A front-page day can easily do 5–10× that, and when the global counter runs
out every visitor gets `429 global_daily_words` until UTC midnight — the site
stays up, but nobody can generate. That is the failure mode to decide on
before publishing.

Options, cheapest first:

1. **Raise the ceiling for launch week.** `ops/rebuild.sh` hardcodes
   `-e KOE_GLOBAL_WORDS_DAY=30000`. Changing it to
   `${KOE_GLOBAL_WORDS_DAY:-30000}` lets `ops/koe.env` lift it to e.g. 250,000
   without another code edit. Cost: more edge-tts traffic, which Microsoft's
   free endpoint may throttle — the circuit breaker already handles that with
   a `503` + `retryAfterSeconds`.
2. **Leave it and budget the 429s.** The error body is honest and tells people
   to retry, and the studio shows usage in the nav. Fine if the launch is
   small.
3. **Lower per-key limits** (e.g. 5,000 words/day) so no single visitor can
   eat a fifth of the global budget.

Nothing here needs a code change to launch — it's a config decision.
