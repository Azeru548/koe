#!/usr/bin/env python3
"""Build assets/audio/bed.wav: music bed, ducked against the real voice envelope,
with a soft synthesized whoosh on every cut. Deterministic — same input, same file.

Levels (dBFS RMS):
  under the voice  ~ -31.5   (11 dB under the voice, which sits near -20.5)
  in the gaps      ~ -24.9   (~6.5 dB lift between lines)
"""
import json
import subprocess
import wave

import numpy as np

SR = 48000
DUR = 39.15
BASE_GAIN = -14.3   # dB applied to the bed where no voice is present
DUCK = 8.5          # extra dB of ducking under the voice
WHOOSH = 0.105      # peak amplitude of each whoosh (~ -19.6 dBFS)
WIPES = [3.68, 7.23, 9.68, 13.03, 16.83, 21.08, 23.78, 27.78, 31.68, 35.63]
STARTS = {"01": 0.30, "02": 4.15, "03": 7.65, "04": 10.10, "05": 13.45, "06": 17.25,
          "07": 21.50, "08": 24.20, "09": 28.20, "10": 32.10, "11": 36.05}


def pcm(path, ch=2):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", str(ch), "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32)
    return a.reshape(-1, ch) if ch > 1 else a


def main():
    n = int(DUR * SR)
    bed = pcm("assets/audio/bed_source.mp3")
    if len(bed) < n:
        bed = np.tile(bed, (int(np.ceil(n / len(bed))), 1))
    bed = bed[:n].copy()

    vo = json.load(open("vo.json"))
    voice = np.zeros(n, dtype=np.float32)
    for row in vo:
        m = pcm(f"assets/audio/{row['id']}.mp3", 1)
        s = int(STARTS[row["id"]] * SR)
        e = min(n, s + len(m))
        voice[s:e] += m[:e - s]

    blk = int(0.02 * SR)
    nf = n // blk
    env = np.array([np.sqrt(np.mean(voice[i * blk:(i + 1) * blk] ** 2)) for i in range(nf)])
    active = (20 * np.log10(np.maximum(env, 1e-7)) > -45).astype(np.float32)

    attack, release = 0.045, 0.55
    smooth = np.zeros(nf, dtype=np.float32)
    cur = 0.0
    for i, a in enumerate(active):
        k = attack if a > cur else release
        cur += (a - cur) * (1 - np.exp(-2.0 / (k * 50)))
        smooth[i] = cur
    mask = np.repeat(smooth, blk)[:n]
    mask = np.pad(mask, (0, n - len(mask)), mode="edge")

    bed_gain = bed * (10 ** ((BASE_GAIN - DUCK * mask) / 20))[:, None]

    rng = np.random.default_rng(7)
    wn = int(0.5 * SR)
    t = np.arange(wn) / SR
    shape = np.minimum(t / 0.11, 1.0) ** 2 * np.exp(-np.maximum(t - 0.11, 0) * 7.0)
    whoosh = np.zeros(n, dtype=np.float32)
    for w in WIPES:
        noise = rng.standard_normal(wn).astype(np.float32)
        a = np.linspace(0.02, 0.45, wn)
        y1 = y2 = 0.0
        lp1 = np.zeros(wn, np.float32)
        lp2 = np.zeros(wn, np.float32)
        for k in range(wn):
            y1 += a[k] * (noise[k] - y1); lp1[k] = y1
            y2 += (a[k] * 0.25) * (y1 - y2); lp2[k] = y2
        band = (lp1 - lp2) * shape
        band /= (np.max(np.abs(band)) + 1e-9)
        s = int((w - 0.02) * SR)
        e = min(n, s + wn)
        if s >= 0:
            whoosh[s:e] += band[:e - s] * WHOOSH

    mix = bed_gain + whoosh[:, None]
    fi, fo = int(0.6 * SR), int(1.6 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)[:, None]
    mix[-fo:] *= (np.linspace(0, 1, fo)[::-1] ** 1.5)[:, None]

    peak = np.max(np.abs(mix))
    if peak > 10 ** (-2 / 20):
        mix *= 10 ** (-2 / 20) / peak

    with wave.open("assets/audio/bed.wav", "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())

    def lv(a, b):
        seg = mix[int(a * SR):int(b * SR)]
        return 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12)

    print(f"stem: speech {lv(10.4, 12.0):.1f} | gap {lv(12.4, 12.95):.1f} | "
          f"lift {lv(12.4, 12.95) - lv(10.4, 12.0):.1f} dB | peak {20 * np.log10(np.max(np.abs(mix))):.1f}")


if __name__ == "__main__":
    main()
