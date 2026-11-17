"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/kokoro.js
//
//  Kokoro (82M, ONNX) reached over HTTP through the fastkokoro sidecar — a
//  SEPARATE container. This module never imports a model, torch, onnxruntime
//  or Python; it is a configuration of engines/sidecar.js, which owns the
//  shared HTTP work (connect probe, cached health/voices, retries, aborts).
//
//    Base URL   KOKORO_BASE_URL, default http://127.0.0.1:8880
//    Health     GET  /health            -> {"status":"healthy"}
//    Voices     GET  /v1/audio/voices   -> {"voices":["af_heart", …]}
//    Speech     POST /v1/audio/speech   -> audio bytes
//               { model, input, voice, response_format, speed, lang }
//
//  fastkokoro contract notes (verified against msgflux/fastkokoro 0.7):
//    • `speed` is pydantic-validated to 1.0..2.0 — below 1.0 the sidecar
//      answers 422, so we CLAMP and warn once rather than fail the job.
//    • there is no pitch parameter at all → warned once, then ignored.
//    • response_format accepts pcm|wav|mp3|opus|flac; we ask for mp3 so the
//      job pipeline, /audio/:id and the MCP inline-audio path behave
//      exactly as they do for edge.
//
//  If the sidecar is not running the engine is simply unavailable: healthy()
//  is false, edge and piper are untouched, and engine:"kokoro" answers 503.
// ─────────────────────────────────────────────────────────────

const { createSidecar } = require("./sidecar");
const { KOKORO_FALLBACK_VOICES, describeKokoroVoice } = require("../voices");

let engine; // assigned below; buildBody() only runs after that

const body = ({ text, voice, rate, pitch }) => {
  const out = {
    model: "kokoro",
    input: text,
    voice,
    response_format: "mp3",
    lang: null,
  };

  // rate → speed. The sidecar rejects anything outside 1.0..2.0 with a 422,
  // so clamp instead of failing; warn once so the operator can see it.
  const rateNum = Number(rate);
  if (Number.isFinite(rateNum) && rateNum !== 1) {
    if (rateNum < 1) {
      engine.warnOnce("rate_low", `kokoro ignores rates below 1.0 (the sidecar accepts 1.0–2.0); requested ${rateNum} was clamped to 1.0`);
      out.speed = 1.0;
    } else {
      out.speed = Math.min(2, rateNum);
    }
  }

  if (pitch !== undefined && pitch !== null && Number(pitch) !== 0) {
    engine.warnOnce("pitch", "kokoro has no pitch control — the requested pitch was ignored");
  }

  return out;
};

engine = createSidecar({
  name: "kokoro",
  label: "Kokoro",
  errorName: "KokoroError",
  defaultBaseUrl: "http://127.0.0.1:8880",
  baseUrlEnv: "KOKORO_BASE_URL",
  contentType: "audio/mpeg",
  ext: "mp3",
  speechPath: "/v1/audio/speech",
  voicesPath: "/v1/audio/voices",
  healthPath: "/health",
  buildBody: body,
  describeVoice: describeKokoroVoice,
  fallbackVoices: () => KOKORO_FALLBACK_VOICES,
  // Three attempts: this sidecar is the slow one, and a cold start can drop
  // the first connection.
  maxAttempts: 3,
  connectTimeoutEnv: "KOKORO_CONNECT_TIMEOUT_MS",
  readTimeoutEnv: "KOKORO_READ_TIMEOUT_MS",
  retryEnv: "KOKORO_RETRY_BASE_MS",
  connectTimeoutMs: 5 * 1000,
  readTimeoutMs: 180 * 1000,
  retryBaseMs: 250,
});

module.exports = engine;
