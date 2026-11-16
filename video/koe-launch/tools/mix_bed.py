#!/usr/bin/env python3
"""Build assets/audio/bed.wav — the music bed for the Koe launch film.

Deterministic on purpose: the same inputs always produce the same samples, so a
re-render matches the last one frame for frame. Does three jobs:

  1. trims the licensed track to the film and fades the ends;
  2. ducks it under every voice line so the track lifts in the gaps;
  3. adds a synthesized whoosh on each cut.

Run from video/koe-launch:  python3 tools/mix_bed.py
Inputs:  assets/audio/bed_source_v2.mp3 (track) + assets/audio/v2/vo.json (timing)
Output:  assets/audio/bed.wav
"""
import json
import subprocess
import wave

import numpy as np

SR = 48000
DUR = 29.00               # film length in seconds
FADE_IN = 0.25
FADE_OUT = 1.40
BASE_GAIN = -8.5         # dB applied to the raw track before ducking
DUCK_DB = 7.0             # how far the bed drops under a voice line
DIP_AT = 0.10             # duck ramp length (s)
WHOOSH_AT = (-0.22, 0.30) # whoosh window relative to each cut (s)
WHOOSH_PEAK = -19.0       # dBFS peak of a whoosh

SOURCE = "assets/audio/bed_source.mp3"
VO = "vo.json"
OUT = "assets/audio/bed.wav"

# Cut times must match T in index.html.
CUTS = [2.40, 3.93, 7.74, 11.28, 14.80, 19.02, 22.76, 25.03]


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def voice_windows():
    lines = json.load(open(VO))
    # Audio starts are copied from index.html so voice and bed cannot drift apart.
    starts = [0.25, 2.55, 4.08, 7.89, 11.43, 14.95, 19.17, 22.91, 25.18]
    return [(s, s + l["seconds"]) for s, l in zip(starts, lines)]


def whoosh(length, rng):
    """A noise sweep: rises in pitch, peaks fast, decays. Reads as air moving."""
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # one-pole lowpass whose cutoff climbs, then a fast exponential envelope
    cutoff = 0.02 + 0.5 * (t / t[-1]) ** 2
    y = np.empty(n)
    acc = 0.0
    for i in range(n):
        acc += cutoff[i] * (noise[i] - acc)
        y[i] = acc
    env = np.exp(-((t - 0.10) ** 2) / (2 * 0.055 ** 2)) * (1 - t / t[-1]) ** 0.6
    y = y * env
    y /= np.max(np.abs(y)) + 1e-9
    return y.astype(np.float32)


def main():
    src = decode(SOURCE)[: int(DUR * SR)]
    if len(src) < int(DUR * SR):
        raise SystemExit(f"source is only {len(src) / SR:.2f}s, need {DUR}s")

    x = src * (10 ** (BASE_GAIN / 20))

    # fade the ends
    fi, fo = int(FADE_IN * SR), int(FADE_OUT * SR)
    x[:fi] *= np.linspace(0, 1, fi)[:, None]
    x[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.4

    # duck under each voice line, with short ramps so it breathes instead of pumping
    ramp = int(DIP_AT * SR)
    gain = np.ones(len(x), dtype=np.float32)
    for a, b in voice_windows():
        i, j = int(a * SR), int(b * SR)
        gain[i:j] = 10 ** (-DUCK_DB / 20)
        gain[max(0, i - ramp):i] = np.linspace(1, 10 ** (-DUCK_DB / 20), ramp)[: min(ramp, i)]
        gain[j:j + ramp] = np.linspace(10 ** (-DUCK_DB / 20), 1, ramp)[: max(0, len(gain) - j)]
    x *= gain[:, None]

    # whooshes on the cuts
    rng = np.random.default_rng(7)
    w = whoosh(WHOOSH_AT[1] - WHOOSH_AT[0], rng) * (10 ** (WHOOSH_PEAK / 20))
    for c in CUTS:
        i = int((c + WHOOSH_AT[0]) * SR)
        j = i + len(w)
        if i < 0:
            w2, i = w[-i:], 0
            x[i:i + len(w2)] += w2[:, None]
        else:
            x[i:min(j, len(x))] += w[: min(j, len(x)) - i][:, None]

    peak = np.max(np.abs(x))
    if peak > 0.9:                      # never clip the bed
        x *= 0.9 / peak

    with wave.open(OUT, "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())

    def rms(a, b):
        s = x[int(a * SR):int(b * SR)]
        return 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-12)

    under = np.mean([rms(a + 0.15, b - 0.15) for a, b in voice_windows()])
    gaps = np.mean([rms(b + 0.25, a2 - 0.05) for (a, b), (a2, _) in zip(voice_windows(), voice_windows()[1:])])
    print(f"bed.wav  {len(x) / SR:.2f}s  peak {20 * np.log10(np.max(np.abs(x))):.1f} dBFS")
    print(f"speech {under:.1f} | gap {gaps:.1f} | lift {gaps - under:.1f} dB | whooshes {len(CUTS)}")


if __name__ == "__main__":
    main()
