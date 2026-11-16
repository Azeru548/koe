"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/kitten.js
//
//  Kitten TTS (15M–80M ONNX, Apache-2.0 code) reached over HTTP through
//  the local `kitten` sidecar in ops/kitten/. Like engines/kokoro.js this
//  module never imports a model, onnxruntime or Python — it is a plain
//  HTTP client, so the app container stays small.
//
//    Base URL   KITTEN_BASE_URL, default http://127.0.0.1:8881
//    Health     GET  /health            -> {"status":"healthy"}
//    Voices     GET  /voices            -> {"voices":["bella", …]}
//    Speech     POST /synthesize        -> audio/wav
//               { text, voice, speed }
//
//  Contract notes:
//    • Output is 24 kHz mono WAV, so `ext`/`contentType` are wav — the job
//      pipeline already handles per-engine extension and merging for piper.
//    • Kitten has no pitch control: a non-zero pitch is warned once and
//      ignored, exactly like kokoro.
//    • `speed` is honoured by the sidecar (clamped 0.5–2.0 here); the caller's
//      `rate` never reaches the model outside that range.
//    • If the sidecar is not running the engine is simply unavailable:
//      healthy() is false, edge/piper/kokoro are untouched, and
//      engine:"kitten" answers 503 {"error":"tts_unavailable"}.
// ─────────────────────────────────────────────────────────────

const { KITTEN_VOICES, isKittenVoice } = require("../voices");

const DEFAULT_BASE_URL = "http://127.0.0.1:8881";
const EXT = "wav";
const CONTENT_TYPE = "audio/wav";

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Kitten is fast on CPU, but a cold sidecar can still be loading the model,
// so the read deadline is generous while the health probe stays short.
const CONNECT_TIMEOUT_MS = intEnv("KITTEN_CONNECT_TIMEOUT_MS", 5 * 1000);
const READ_TIMEOUT_MS = intEnv("KITTEN_READ_TIMEOUT_MS", 120 * 1000);
const RETRY_BASE_MS = intEnv("KITTEN_RETRY_BASE_MS", 250);
const HEALTH_TTL_MS = 5 * 1000;
const VOICES_TTL_MS = 60 * 1000;
const MAX_ATTEMPTS = 2; // one retry: the sidecar serialises work, so long retry chains only queue deeper

function baseUrl() {
  const raw = process.env.KITTEN_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

// ── one-shot warnings ────────────────────────────────────────────────

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[kitten] ${message}`);
}
function resetWarnings() { warned.clear(); }

// ── errors ───────────────────────────────────────────────────────────

class KittenError extends Error {
  constructor(message, { status = null, retryable = false, reason = "error" } = {}) {
    super(message);
    this.name = "KittenError";
    this.status = status;
    this.retryable = retryable;
    this.reason = reason;
  }
}

function isConnectError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
}

// ── health (cached, single-flight, never throws) ─────────────────────

let healthCache = { ok: false, at: 0 };
let healthInflight = null;

async function probeHealth() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resetHealth() {
  healthCache = { ok: false, at: 0 };
  healthInflight = null;
}

// ── voices (fetched once, cached, hard fallback) ─────────────────────

let voicesCache = { list: null, at: 0 };

async function fetchVoiceIds() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/voices`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`voices endpoint returned ${res.status}`);
    const data = await res.json();
    const ids = Array.isArray(data) ? data : data && Array.isArray(data.voices) ? data.voices : null;
    if (!ids || !ids.length) throw new Error("voices endpoint returned no voices");
    return ids.filter((v) => typeof v === "string" && v);
  } finally {
    clearTimeout(timer);
  }
}

// The sidecar may run any Kitten checkpoint; the eight 0.8 speakers are the
// floor every checkpoint shares, so that is the fallback.
function fallbackVoices(reason) {
  warnOnce("voices", `could not fetch the voice list from the sidecar (${reason}) — using the built-in Kitten catalog`);
  return KITTEN_VOICES;
}

function describeVoice(id) {
  const known = KITTEN_VOICES.find((v) => v.id === String(id).toLowerCase());
  if (known) return known;
  return { id: String(id), name: String(id), lang: "und", style: "Kitten" };
}

async function loadVoices({ force = false } = {}) {
  const now = Date.now();
  if (!force && voicesCache.list && now - voicesCache.at < VOICES_TTL_MS) return voicesCache.list;
  try {
    const ids = await fetchVoiceIds();
    voicesCache = { list: ids.map(describeVoice), at: now };
    return voicesCache.list;
  } catch (err) {
    if (voicesCache.list) return voicesCache.list; // stale beats unavailable
    return fallbackVoices(String((err && err.message) || err));
  }
}

function resetVoices() {
  voicesCache = { list: null, at: 0 };
}

loadVoices().catch(() => {});

// ── synthesis ────────────────────────────────────────────────────────

function buildRequestBody({ text, voice, rate, pitch }) {
  const body = { text, voice: String(voice || "").toLowerCase() };

  const rateNum = Number(rate);
  if (Number.isFinite(rateNum) && rateNum !== 1) {
    // Clamp rather than fail a job the caller can fix by re-reading the docs.
    body.speed = Math.min(2, Math.max(0.5, rateNum));
  }

  if (pitch !== undefined && pitch !== null && Number(pitch) !== 0) {
    warnOnce("pitch", "kitten has no pitch control — the requested pitch was ignored");
  }

  return body;
}

async function attempt({ body, signal }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const readTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, READ_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(`${baseUrl()}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: CONTENT_TYPE },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new KittenError(
        `Kitten sidecar returned ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
        { status: res.status, retryable: res.status >= 500, reason: `http_${res.status}` }
      );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      throw new KittenError("Kitten sidecar returned an empty audio body", { retryable: true, reason: "empty_body" });
    }
    return { bytes: buf, contentType: CONTENT_TYPE };
  } catch (err) {
    if (timedOut) {
      throw new KittenError(`Kitten sidecar read timeout after ${READ_TIMEOUT_MS}ms`, { retryable: true, reason: "read_timeout" });
    }
    if (signal && signal.aborted) {
      throw new KittenError("Kitten synthesis aborted by caller", { retryable: false, reason: "aborted" });
    }
    throw err;
  } finally {
    clearTimeout(readTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

module.exports = {
  name: "kitten",
  ext: EXT,
  contentType: CONTENT_TYPE,
  baseUrl,
  CONNECT_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  buildRequestBody,
  loadVoices,
  resetWarnings,
  resetHealth,
  resetVoices,
  isVoice: isKittenVoice,

  async synthesize({ text, voice, rate = 1, pitch = 0, signal }) {
    const body = buildRequestBody({ text, voice, rate, pitch });
    let lastErr = null;

    for (let attemptNo = 0; attemptNo < MAX_ATTEMPTS; attemptNo++) {
      if (signal && signal.aborted) {
        throw new KittenError("Kitten synthesis aborted by caller", { reason: "aborted" });
      }
      try {
        return await attempt({ body, signal });
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof KittenError ? err.retryable : isConnectError(err);
        if (!retryable || attemptNo === MAX_ATTEMPTS - 1) break;
        const delay = RETRY_BASE_MS * 2 ** attemptNo;
        console.warn(`[kitten] attempt ${attemptNo + 1}/${MAX_ATTEMPTS} failed (${(err && err.reason) || "connect"}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastErr instanceof KittenError) throw lastErr;
    throw new KittenError(`Kitten synthesis failed: ${String((lastErr && lastErr.message) || lastErr)}`, {
      retryable: isConnectError(lastErr),
      reason: isConnectError(lastErr) ? "connect" : "error",
    });
  },

  async listVoices({ lang } = {}) {
    const voices = await loadVoices();
    if (!lang) return voices;
    const needle = String(lang).toLowerCase();
    return voices.filter((v) => String(v.lang).toLowerCase().startsWith(needle));
  },

  async healthy() {
    const now = Date.now();
    if (now - healthCache.at < HEALTH_TTL_MS) return healthCache.ok;
    if (healthInflight) return healthInflight;

    healthInflight = (async () => {
      const ok = await probeHealth();
      healthCache = { ok, at: Date.now() };
      healthInflight = null;
      return ok;
    })();

    return healthInflight;
  },

  // Test hooks only — never called by the application.
  _internals: { probeHealth, isConnectError, describeVoice },
};
