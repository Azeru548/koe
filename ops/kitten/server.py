#!/usr/bin/env python3
"""Koe — Kitten TTS sidecar.

A deliberately small HTTP wrapper around kittens, so the Node app never
imports Python, onnxruntime or a model. Stdlib `http.server` only (no FastAPI,
no uvicorn, no extra ~80 MB of dependencies).

    GET  /health      -> {"status":"healthy","engine":"kitten"}
    GET  /voices      -> {"voices":["bella","jasper",...]}
    POST /synthesize  -> audio/wav        {"text","voice","speed"}

One synthesis at a time (`_lock`). The models are tiny and fast, but a second
concurrent call only doubles the peak RSS for no throughput on a 2 vCPU box —
serialising keeps the whole sidecar inside its mem_limit.
"""

import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.8-int8")
PORT = int(os.environ.get("KITTEN_PORT", "8881"))
BIND = os.environ.get("KITTEN_BIND", "0.0.0.0")
MAX_TEXT = int(os.environ.get("KITTEN_MAX_TEXT", "6000"))

# The eight speakers every Kitten checkpoint ships. The model reports its own
# list; this is the fallback and the order the studio renders.
DEFAULT_VOICES = ["bella", "jasper", "luna", "bruno", "rosie", "hugo", "kiki", "leo"]

_model = None
_model_lock = threading.Lock()
_synth_lock = threading.Lock()
_supports_speed = True


def get_model():
    global _model
    if _model is None:
        from kittenml import KittenTTS  # imported lazily: /health answers before the weights load

        _model = KittenTTS(MODEL_ID)
        print(f"[kitten] loaded {MODEL_ID}", flush=True)
    return _model


def voices():
    try:
        names = list(get_model().available_voices)
        if names:
            return [str(v) for v in names]
    except Exception as exc:  # noqa: BLE001 — a missing list must not break the API
        print(f"[kitten] available_voices unavailable: {exc}", flush=True)
    return DEFAULT_VOICES


def wav_bytes(samples, sample_rate):
    """float32 [-1,1] numpy array -> 16-bit mono WAV bytes."""
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0) * 32767).astype("int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def synthesize(text, voice, speed):
    global _supports_speed
    model = get_model()
    # Kitten takes title-case names ("Bella"); our ids are lowercase.
    name = str(voice or "bella").strip().title()

    with _synth_lock:
        if _supports_speed:
            try:
                samples = model.generate(text, voice=name, speed=float(speed))
            except TypeError:
                # Some builds take no speed argument at all — drop it once
                # instead of failing every request after the first.
                print("[kitten] this build has no speed argument; rate is ignored", flush=True)
                _supports_speed = False
                samples = model.generate(text, voice=name)
        else:
            samples = model.generate(text, voice=name)

    return wav_bytes(samples, getattr(model, "sample_rate", 24000))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the container log readable
        print("[kitten] " + (fmt % args), flush=True)

    def _send(self, code, body=b"", content_type="application/json"):
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, json.dumps(payload).encode(), "application/json")

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "healthy", "engine": "kitten", "model": MODEL_ID})
        if self.path == "/voices":
            try:
                return self._json(200, {"voices": voices()})
            except Exception as exc:  # noqa: BLE001
                return self._json(500, {"error": str(exc)[:200]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self._json(404, {"error": "not found"})

        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            return self._json(400, {"error": "invalid JSON body"})

        text = str(payload.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "no text provided"})
        if len(text) > MAX_TEXT:
            return self._json(413, {"error": f"text too long ({len(text)} chars, max {MAX_TEXT})"})

        voice = str(payload.get("voice") or "bella")
        speed = payload.get("speed", 1.0)

        try:
            audio = synthesize(text, voice, speed)
        except Exception as exc:  # noqa: BLE001 — surface one readable line, not a traceback
            print(f"[kitten] synthesis failed: {exc!r}", flush=True)
            return self._json(500, {"error": f"{type(exc).__name__}: {exc}"[:300]})

        self._send(200, audio, "audio/wav")


def main():
    print(f"[kitten] serving {MODEL_ID} on {BIND}:{PORT}", flush=True)
    # Warm the model so the first real request is not the one paying for it.
    # Failure here is not fatal: /health still answers and the error is logged.
    try:
        get_model()
        voices()
    except Exception as exc:  # noqa: BLE001
        print(f"[kitten] warmup failed: {exc!r}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
