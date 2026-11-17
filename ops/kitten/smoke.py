#!/usr/bin/env python3
"""Kitten sidecar smoke check.

Why this exists: the image installs `kittenml` with `--no-deps` plus a
hand-picked list of modules (torch and the CUDA tree are deliberately absent —
see the Dockerfile). A version bump can start needing something that list does
not have, and the failure would only show up as a 500 on a real request. This
script proves three things:

  1. the package imports and a model loads with ONLY that dependency list,
  2. generate() still exists with the arguments the sidecar passes,
  3. the audio it returns is real (non-empty, non-silent) and the WAV we build
     from it parses with a sane frame rate.

    python smoke.py                  # in-process, what CI runs in the image
    python smoke.py --url http://127.0.0.1:8881   # against a running sidecar

Exits non-zero and prints one line per failed expectation.
"""

import argparse
import io
import json
import os
import sys
import urllib.request
import wave

MODEL = os.environ.get("KITTEN_SMOKE_MODEL", os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.8-int8"))
TEXT = "Sidecar smoke check. If you can hear this, the hand picked dependencies still work."
VOICE = "Bella"
SAMPLE_RATE = int(os.environ.get("KITTEN_SAMPLE_RATE", "24000"))

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"FAIL  {message}")
    return condition


def wav_bytes(samples, sample_rate):
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0) * 32767).astype("int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def check_wav(data, where):
    try:
        with wave.open(io.BytesIO(data)) as w:
            frames, rate, channels = w.getnframes(), w.getframerate(), w.getnchannels()
    except Exception as exc:  # noqa: BLE001
        return check(False, f"{where}: audio is not a parseable WAV ({type(exc).__name__}: {exc})")
    check(frames > 0, f"{where}: WAV has no frames")
    check(rate == SAMPLE_RATE, f"{where}: WAV frame rate is {rate}, expected {SAMPLE_RATE}")
    check(channels == 1, f"{where}: WAV has {channels} channels, expected mono")
    # A silent render is the failure mode a header check alone would miss.
    peak = max(abs(int.from_bytes(data[i:i + 2], "little", signed=True)) for i in range(44, min(len(data), 44 + 40000), 2))
    check(peak > 200, f"{where}: audio is silent (peak {peak})")
    return True


def in_process():
    try:
        from kittenml import KittenTTS
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  importing kittenml failed: {type(exc).__name__}: {exc}")
        print("      The --no-deps list in ops/kitten/Dockerfile is probably missing a module.")
        return 1

    try:
        model = KittenTTS(MODEL)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  loading {MODEL} failed: {type(exc).__name__}: {exc}")
        return 1

    check(hasattr(model, "generate"), "model has no generate()")
    if failures:
        return 1

    import inspect

    params = inspect.signature(model.generate).parameters
    check("voice" in params, "generate() lost its voice argument")
    check("speed" in params, "generate() lost its speed argument (rate would be dropped silently)")

    audio = model.generate(TEXT, voice=VOICE, speed=1.0)
    import numpy as np

    arr = np.asarray(audio)
    check(arr.size > SAMPLE_RATE // 4, f"generated only {arr.size} samples")
    check(float(np.abs(arr).max()) > 0.01, "generated audio is silent")
    check_wav(wav_bytes(arr, SAMPLE_RATE), "in-process")
    check("torch" not in sys.modules, "torch got imported — the dependency list is wrong")

    if failures:
        return 1
    print(f"ok    {MODEL}: {arr.size} samples at {SAMPLE_RATE} Hz, stereo-free and audible")
    return 0


def http_check(base):
    base = base.rstrip("/")

    def get(path):
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return r.read()

    def post(path, payload):
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.read()

    try:
        health = json.loads(get("/health"))
        check(health.get("status") == "healthy", f"health said {health}")
        voices = json.loads(get("/voices")).get("voices") or []
        check(len(voices) >= 1, "sidecar reported no voices")
        data = post("/synthesize", {"text": TEXT, "voice": VOICE, "speed": 1.0})
        check_wav(data, "http")
    except Exception as exc:  # noqa: BLE001
        check(False, f"HTTP check failed: {type(exc).__name__}: {exc}")

    if failures:
        return 1
    print(f"ok    {base}: health, voices and a real WAV")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Smoke-check the Kitten sidecar")
    parser.add_argument("--url", help="check a running sidecar over HTTP instead of in-process")
    args = parser.parse_args()
    return http_check(args.url) if args.url else in_process()


if __name__ == "__main__":
    sys.exit(main())
