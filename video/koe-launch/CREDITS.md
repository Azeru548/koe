# Credits — Koe launch film (v3, 29.00 s)

## Voice

All nine lines were generated with **Koe** itself (`en-US-EmmaNeural`, rate 1.12),
through the local Koe studio's `/tts-preview` endpoint. No paid TTS service, no actor.

- Voice: Emma — Microsoft Edge neural voice, `en-US-EmmaNeural`
- Speed: 1.12×
- Render: 9 MP3s in `assets/audio/01–09.mp3`, one per line, timings in `vo.json`

## Music

**“Path To Victory (Upbeat, Energetic, Optimistic)” by UNIVERSFIELD.**

- Source: Freesound — https://freesound.org/people/UNIVERSFIELD/sounds/704530
- License: **Creative Commons Attribution 4.0** (CC BY 4.0) —
  https://creativecommons.org/licenses/by/4.0/
- **Attribution is required.** It is shown on the film's end card
  (“music: “Path To Victory” — UNIVERSFIELD, CC BY 4.0”) and in this file. Keep that
  line with the video anywhere it is published, embedded or cut down.
- Commercial use and modification are allowed under CC BY 4.0, attribution aside.
- Used as `assets/audio/bed_source.mp3` (98.8 s), trimmed to the film's 29.00 s.

Measured before choosing: 117.5 BPM, roughly −10 dBFS RMS, spectral centroid ~2.8 kHz
— the brightest and most energetic of the five shortlisted tracks, and the opposite of
the slow-cinematic bed used in v1.

## The mix

`assets/audio/bed.wav` is generated, not tracked. Rebuild it with:

```
python3 tools/mix_bed.py
```

It trims and fades the track, ducks it 7 dB under every voice line, and synthesizes a
whoosh on each of the eight cuts. Current numbers: peak −8.2 dBFS, bed −29.5 dBFS RMS
under the voice, −23.4 in the gaps (6.1 dB lift), eight whooshes.

## Fonts

- Shippori Mincho (OFL) — wordmark and display
- IBM Plex Sans (OFL) — headlines and interface text
- DM Mono (OFL) — labels, timecodes, code

All three are self-hosted in `fonts/`.
