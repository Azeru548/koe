# Koe — launch film, storyboard v3

**39.15 seconds**, 1920×1080, 30 fps. Eleven beats, hard cuts carried by colour wipes.
Every cut is timed to the measured length of one Koe-generated voice line
(`vo.json`, `assets/audio/NN.mp3`): each wipe lands **0.60–0.95 s after that line's
last syllable**, never on it. The arc: **a loop that only writes → the silence that
follows → Koe hears it → what it gives you → what it costs (nothing) → where it lands.**

| # | Time | Voice line (starts) | Picture (shapes / objects) | Type |
|---|------|--------------------|----------------------------|------|
| 1 | 0.00–3.90 | Every agent, everywhere, ends the same way. (0.30) | Hairline grid; floating terminal card with three dots, mono log lines stamped one by one, blinking cursor | 112px sans, three stacked lines rising out of masks |
| 2 | 3.90–7.45 | Done. Finished. All tests passing. (4.15) | Three status pills with check marks landing like stamps over a 300px outline `DONE` | Pills 60px; ghost display word |
| 3 | 7.45–9.90 | And nobody hears a word of it. (7.65) | Muted speaker glyph with a vermilion slash drawn across it; a waveform that collapses flat; `no audio` | Icon carries the beat, 92px aside |
| 4 | 9.90–13.25 | Koe reads that text, and speaks it. (10.10) | Vermilion field; wordmark slams in; a text card flips into a waveform card under a slow ring | 430px Shippori `Koe` |
| 5 | 13.25–17.05 | One URL. No setup, no SDK. (13.45) | URL bar presses play, fills a progress bar, counts a timecode; `npm install` / `SDK` / `API key` tags float off | 104px sans over a 146px bar |
| 6 | 17.05–21.30 | Twenty-nine neural voices, in twenty-nine languages. (17.25) | 29 voice chips flick on; a big `29` counts up; a language band scrolls along the bottom | Display `29` 400px, kin |
| 7 | 21.30–24.00 | Pick the one that sounds like your product. (21.50) | Five voice rows scroll to a stop; one highlights in kin with a live equalizer, the rest dim | Rows 30px mono |
| 8 | 24.00–28.00 | No account. No card. No API bill. (24.20) | Three stamps land over crossed-out objects: login form, credit card, invoice for $41.00 — vermilion slash through each | 130px sans stamps |
| 9 | 28.00–31.90 | Paste a script, get a finished voiceover in seconds. (28.20) | Script card → travelling arrow → MP3 card: waveform fills, duration `0:14`, status flips to `done — 0.9s` | Card 28px mono, payoff 74px |
| 10 | 31.90–35.85 | Drop it in your demo, your video, your podcast. (32.10) | Three destination frames drop in and float: demo window, video timeline with a highlighted clip, podcast mic | Frame labels 26px mono |
| 11 | 35.85–39.15 | Koe. Free. (36.05) | End card: portrait panel, wordmark, claim, URL, red `FREE` chip; slow drift, fade to black from 38.70 | 320px Shippori, 58px claim |

**Cuts** (wipe starts): 3.68 · 7.23 · 9.68 · 13.03 · 16.83 · 21.08 · 23.78 · 27.78 · 31.68 · 35.63.
Gaps between voice lines run 0.68–1.02 s, so the piece breathes at one rhythm.

Colour rhythm: washi · washi · sumi · shu · washi · sumi · washi · washi · ai · ai · washi.

## Audio

- **Voice**: one MP3 per line, all synthesised by Koe itself (`en-US-AndrewNeural`,
  rate 1.05), 29.45 s of speech placed at the start times above.
- **Music bed**: “Slow Cinematic Music.wav” by DeVern — Freesound sound 384202,
  **CC0 1.0**, no attribution required. Trimmed to 39.15 s, faded in 0.6 s and out 1.6 s.
  Ducking is driven by the real voice envelope (45 ms attack, 0.55 s release) so the
  bed **lifts in every gap between lines** and settles again as the next line lands.
- **Whooshes**: synthesised from seeded noise with a filter sweep, ~0.5 s, one per cut.
- The bed, the ducking and the whooshes are pre-mixed into `assets/audio/bed.wav` so
  the render stays frame-exact.
