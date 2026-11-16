#!/usr/bin/env python3
"""Write captions/koe-launch.srt and .vtt from the measured voice timings.

Timing comes from vo.json (one entry per line, measured off the actual MP3) plus the
start times copied from index.html, so captions cannot drift from the audio.

Cues are padded slightly — a hair before the voice starts, a beat after it ends — and
are never allowed to overlap the next cue.

Run from video/koe-launch:  python3 tools/make_captions.py
"""
import json
import os

VO = "vo.json"
OUT_DIR = "captions"
STARTS = [0.25, 2.55, 4.08, 7.89, 11.43, 14.95, 19.17, 22.91, 25.18]
LEAD = 0.06      # show a moment before the voice
TAIL = 0.18      # hold a moment after it
FILM_END = 29.00


def stamp(t, sep):
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:           # rounding can push to the next second
        s, ms = s + 1, 0
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def cues():
    lines = json.load(open(VO))
    out = []
    for i, line in enumerate(lines):
        start = max(0.0, STARTS[i] - LEAD)
        end = min(FILM_END, STARTS[i] + line["seconds"] + TAIL)
        if i + 1 < len(lines):                 # no overlapping cues
            end = min(end, STARTS[i + 1] - LEAD)
        out.append((start, end, line["text"]))
    return out


def write(path, sep, header):
    rows = [header]
    for n, (a, b, text) in enumerate(cues(), 1):
        if sep == ",":
            rows.append(f"{n}\n{stamp(a, sep)} --> {stamp(b, sep)}\n{text}\n")
        else:
            rows.append(f"{stamp(a, sep)} --> {stamp(b, sep)}\n{text}\n")
    open(path, "w").write("\n".join(rows))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    write(f"{OUT_DIR}/koe-launch.srt", ",", "")
    write(f"{OUT_DIR}/koe-launch.vtt", ".", "WEBVTT\n")
    for a, b, text in cues():
        print(f"{stamp(a, ',')} --> {stamp(b, ',')}  {b - a:4.2f}s  {text}")


if __name__ == "__main__":
    main()
