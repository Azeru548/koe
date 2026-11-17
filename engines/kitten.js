"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/kitten.js
//
//  Kitten TTS (15M–80M ONNX) reached over HTTP through the local `kitten`
//  sidecar in ops/kitten/. Like kokoro.js this is a configuration of
//  engines/sidecar.js — it never imports a model, onnxruntime or Python, so
//  the app container stays small.
//
//    Base URL   KITTEN_BASE_URL, default http://127.0.0.1:8881
//    Health     GET  /health            -> {"status":"healthy"}
//    Voices     GET  /voices            -> {"voices":["Bella", …]}
//    Speech     POST /synthesize        -> audio/wav
//               { text, voice, speed }
//
//  Contract notes (verified against kittenml 0.9.8 + the int8 nano weights):
//    • Output is 24 kHz mono WAV, so `ext`/`contentType` are wav — the job
//      pipeline already handles per-engine extension and merging for piper.
//    • `generate(text, voice, speed)` exists, so rate is forwarded as speed
//      (clamped 0.5–2.0). There is no pitch control: warned once, ignored.
//    • The sidecar reports the eight 0.8 speakers in Title case; ids are
//      lowercase here so they can never collide with another engine's.
//    • If the sidecar is not running the engine is simply unavailable:
//      healthy() is false and engine:"kitten" answers 503.
// ─────────────────────────────────────────────────────────────

const { createSidecar } = require("./sidecar");
const { KITTEN_VOICES, isKittenVoice } = require("../voices");

let engine; // assigned below; buildBody() only runs after that

const body = ({ text, voice, rate, pitch }) => {
  const out = { text, voice: String(voice || "").toLowerCase() };

  const rateNum = Number(rate);
  if (Number.isFinite(rateNum) && rateNum !== 1) {
    // Clamp rather than fail a job the caller can fix by re-reading the docs.
    out.speed = Math.min(2, Math.max(0.5, rateNum));
  }

  if (pitch !== undefined && pitch !== null && Number(pitch) !== 0) {
    engine.warnOnce("pitch", "kitten has no pitch control — the requested pitch was ignored");
  }

  return out;
};

// The sidecar may run any Kitten checkpoint; the eight 0.8 speakers are the
// floor every checkpoint shares, so that is the fallback.
function describeVoice(id) {
  const known = KITTEN_VOICES.find((v) => v.id === String(id).toLowerCase());
  if (known) return known;
  return { id: String(id), name: String(id), lang: "und", style: "Kitten" };
}

engine = createSidecar({
  name: "kitten",
  label: "Kitten",
  errorName: "KittenError",
  defaultBaseUrl: "http://127.0.0.1:8881",
  baseUrlEnv: "KITTEN_BASE_URL",
  contentType: "audio/wav",
  ext: "wav",
  speechPath: "/synthesize",
  voicesPath: "/voices",
  healthPath: "/health",
  buildBody: body,
  describeVoice,
  fallbackVoices: () => KITTEN_VOICES,
  // One retry: the sidecar serialises work, so long retry chains only queue
  // deeper behind the request that is already running.
  maxAttempts: 2,
  connectTimeoutEnv: "KITTEN_CONNECT_TIMEOUT_MS",
  readTimeoutEnv: "KITTEN_READ_TIMEOUT_MS",
  retryEnv: "KITTEN_RETRY_BASE_MS",
  connectTimeoutMs: 5 * 1000,
  readTimeoutMs: 120 * 1000,
  retryBaseMs: 250,
});

engine.isVoice = isKittenVoice;

module.exports = engine;
