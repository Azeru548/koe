"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/kokoro.js
//
//  Kokoro (82M, ONNX) reached over HTTP through the fastkokoro sidecar —
//  a SEPARATE container. This module never imports a model, torch,
//  onnxruntime or Python; it is a plain HTTP client.
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

const net = require("net");
const { KOKORO_FALLBACK_VOICES, describeKokoroVoice } = require("../voices");

const DEFAULT_BASE_URL = "http://127.0.0.1:8880";

// Defaults are the spec's: 5s connect, 180s read. Both are env-tunable so
// the test suite can exercise a real timeout in milliseconds instead of
// waiting three minutes; production never sets them.
function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const CONNECT_TIMEOUT_MS = intEnv("KOKORO_CONNECT_TIMEOUT_MS", 5 * 1000);
const READ_TIMEOUT_MS = intEnv("KOKORO_READ_TIMEOUT_MS", 180 * 1000);
const RETRY_BASE_MS = intEnv("KOKORO_RETRY_BASE_MS", 250);
const HEALTH_TTL_MS = 5 * 1000;
const VOICES_TTL_MS = 60 * 1000;
const MAX_ATTEMPTS = 3; // the initial try plus two retries

const CONTENT_TYPE = "audio/mpeg";
const EXT = "mp3";

function baseUrl() {
  const raw = process.env.KOKORO_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

// ── one-shot warnings (log once per process, never spam) ──────────────

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[kokoro] ${message}`);
}
// Exported for tests so a fresh process can be simulated.
function resetWarnings() { warned.clear(); }

// ── error classification ─────────────────────────────────────────────

class KokoroError extends Error {
  constructor(message, { status = null, retryable = false, reason = "error" } = {}) {
    super(message);
    this.name = "KokoroError";
    this.status = status;
    this.retryable = retryable;
    this.reason = reason;
  }
}

// True for "the socket never came up" — refused, reset, DNS, or our own
// 5-second connect deadline. All retryable.
function isConnectError(err) {
  if (!err) return false;
  if (err.code === "KOKORO_CONNECT_TIMEOUT") return true;
  const code = String(err.code || "");
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
}

// Node's fetch has no separate connect deadline, and fastkokoro only sends
// response headers *after* synthesising — so a plain "no headers in 5s"
// abort would kill every legitimately slow request. Instead we open the TCP
// connection ourselves with a real 5s deadline, then hand the request to
// fetch under a 180s read deadline. This gives genuine connect/read
// semantics without ever aborting audio that is merely slow to render.
function connectProbe(url, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    let socket;
    try {
      const u = new URL(url);
      socket = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) });
    } catch (err) {
      return reject(new KokoroError(`Invalid KOKORO_BASE_URL: ${url}`, { reason: "bad_base_url" }));
    }

    const timer = setTimeout(() => {
      const err = new KokoroError(`Kokoro sidecar connect timeout after ${timeoutMs}ms (${url})`, { reason: "connect_timeout" });
      err.code = "KOKORO_CONNECT_TIMEOUT";
      done(err);
    }, timeoutMs);

    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
  });
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

// ── voices (fetched once, cached, hard fallback) ─────────────────────

let voicesCache = { list: null, at: 0 };

async function fetchVoiceIds() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/v1/audio/voices`, {
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

function fallbackVoices(reason) {
  warnOnce("voices", `could not fetch the voice list from the sidecar (${reason}) — using the built-in Kokoro voice catalog`);
  return KOKORO_FALLBACK_VOICES;
}

async function loadVoices({ force = false } = {}) {
  const now = Date.now();
  if (!force && voicesCache.list && now - voicesCache.at < VOICES_TTL_MS) return voicesCache.list;
  try {
    const ids = await fetchVoiceIds();
    voicesCache = { list: ids.map((id) => describeKokoroVoice(id)), at: now };
    return voicesCache.list;
  } catch (err) {
    if (voicesCache.list) return voicesCache.list; // stale beats unavailable
    return fallbackVoices(String((err && err.message) || err));
  }
}

// Warm the cache at load so the first list_voices call is already populated
// ("fetch at startup"). Fire-and-forget: a missing sidecar is not an error.
loadVoices().catch(() => {});

// ── synthesis ─────────────────────────────────────────────────────────

function buildRequestBody({ text, voice, rate, pitch }) {
  const body = {
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
      warnOnce("rate_low", `kokoro ignores rates below 1.0 (the sidecar accepts 1.0–2.0); requested ${rateNum} was clamped to 1.0`);
      body.speed = 1.0;
    } else {
      body.speed = Math.min(2, rateNum);
    }
  }

  if (pitch !== undefined && pitch !== null && Number(pitch) !== 0) {
    warnOnce("pitch", "kokoro has no pitch control — the requested pitch was ignored");
  }

  return body;
}

async function attempt({ body, signal }) {
  await connectProbe(baseUrl());

  const ctrl = new AbortController();
  let timedOut = false;
  const readTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, READ_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(`${baseUrl()}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new KokoroError(
        `Kokoro sidecar returned ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
        { status: res.status, retryable: res.status >= 500, reason: `http_${res.status}` }
      );
      throw err;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      throw new KokoroError("Kokoro sidecar returned an empty audio body", { status: res.status, retryable: true, reason: "empty_body" });
    }
    return { bytes: buf, contentType: CONTENT_TYPE };
  } catch (err) {
    // Our own read deadline: retryable, and distinguishable from a caller
    // cancelling the job (which must never be retried).
    if (timedOut) {
      throw new KokoroError(`Kokoro sidecar read timeout after ${READ_TIMEOUT_MS}ms`, { retryable: true, reason: "read_timeout" });
    }
    if (signal && signal.aborted) {
      throw new KokoroError("Kokoro synthesis aborted by caller", { retryable: false, reason: "aborted" });
    }
    throw err;
  } finally {
    clearTimeout(readTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

module.exports = {
  name: "kokoro",
  ext: EXT,
  contentType: CONTENT_TYPE,
  baseUrl,
  CONNECT_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  resetWarnings,
  buildRequestBody,
  loadVoices,

  /**
   * @param {{text:string, voice:string, rate?:number, pitch?:number, signal?:AbortSignal}} p
   * @returns {Promise<{bytes: Buffer, contentType: string}>}
   */
  async synthesize({ text, voice, rate = 1, pitch = 0, signal }) {
    const body = buildRequestBody({ text, voice, rate, pitch });
    let lastErr = null;

    for (let attemptNo = 0; attemptNo < MAX_ATTEMPTS; attemptNo++) {
      if (signal && signal.aborted) {
        throw new KokoroError("Kokoro synthesis aborted by caller", { reason: "aborted" });
      }
      try {
        return await attempt({ body, signal });
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof KokoroError ? err.retryable : isConnectError(err);
        // 4xx is never retried: the request itself is wrong.
        if (!retryable || attemptNo === MAX_ATTEMPTS - 1) break;
        const delay = RETRY_BASE_MS * 2 ** attemptNo;
        console.warn(`[kokoro] attempt ${attemptNo + 1}/${MAX_ATTEMPTS} failed (${(err && err.reason) || "connect"}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastErr instanceof KokoroError) throw lastErr;
    throw new KokoroError(`Kokoro synthesis failed: ${String((lastErr && lastErr.message) || lastErr)}`, {
      retryable: isConnectError(lastErr),
      reason: isConnectError(lastErr) ? "connect" : "error",
    });
  },

  async listVoices({ lang } = {}) {
    const voices = await loadVoices();
    if (!lang) return voices;
    const needle = String(lang).toLowerCase();
    const filtered = voices.filter((v) => String(v.lang).toLowerCase().startsWith(needle));
    if (filtered.length) return filtered;
    // A locale prefix that matches nothing falls back to the whole catalog
    // only when it is a known Kokoro locale; otherwise report empty so the
    // caller can answer "no voices match" like the other engines do.
    return filtered;
  },

  // Cached so a dead sidecar costs at most one 5s probe per TTL window and
  // can never slow the request path down repeatedly.
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
  _internals: { connectProbe, probeHealth, isConnectError },
};
