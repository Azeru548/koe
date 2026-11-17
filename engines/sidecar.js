"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/sidecar.js
//
//  The one HTTP client behind every engine that lives in its own container
//  (kokoro, kitten). An engine module supplies a config; this module owns the
//  parts that were copy-pasted twice: env-tunable timeouts, the connect probe,
//  the cached health/voice lookups, the retry loop, abort handling and the
//  error shape.
//
//  Contract an adapter must satisfy (see config below):
//    { name, defaultBaseUrl, baseUrlEnv, contentType, ext,
//      speechPath, voicesPath, healthPath,
//      buildBody({text, voice, rate, pitch}) -> object,
//      describeVoice(id) -> voice, fallbackVoices(),
//      label, errorName, maxAttempts, connectTimeoutEnv, readTimeoutEnv,
//      retryEnv, connectTimeoutMs, readTimeoutMs, retryBaseMs }
// ─────────────────────────────────────────────────────────────

const net = require("net");

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Connect errors mean "the socket never came up" — always worth one retry.
function isConnectError(err) {
  if (!err) return false;
  if (err.connectTimeout) return true;
  const code = String(err.code || "");
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
}

// Node's fetch has no connect deadline, and sidecars only send headers after
// they have synthesised — so a plain "no headers in 5s" abort would kill slow
// requests. Instead the socket is opened here under a real connect deadline,
// then fetch does the work under a read deadline.
function makeConnectProbe({ label, timeoutMs, code }) {
  return function connectProbe(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      let timer;

      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) socket.destroy();
        if (err) reject(err);
        else resolve();
      };

      try {
        const u = new URL(url);
        socket = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) });
      } catch {
        return reject(new Error(`Invalid ${label} URL: ${url}`));
      }

      timer = setTimeout(() => {
        const err = new Error(`${label} connect timeout after ${timeoutMs}ms (${url})`);
        err.code = code;
        err.connectTimeout = true;
        done(err);
      }, timeoutMs);

      socket.once("connect", () => done());
      socket.once("error", (err) => done(err));
    });
  };
}

function createSidecar(config) {
  const {
    name,
    label,
    errorName,
    defaultBaseUrl,
    baseUrlEnv,
    contentType,
    ext,
    speechPath,
    voicesPath = "/voices",
    healthPath = "/health",
    voiceListKey = "voices",
    buildBody,
    describeVoice,
    fallbackVoices,
    maxAttempts = 2,
    connectTimeoutEnv,
    readTimeoutEnv,
    retryEnv,
    connectTimeoutMs = 5000,
    readTimeoutMs = 120000,
    retryBaseMs = 250,
  } = config;

  const CONNECT_TIMEOUT_MS = connectTimeoutEnv ? intEnv(connectTimeoutEnv, connectTimeoutMs) : connectTimeoutMs;
  const READ_TIMEOUT_MS = readTimeoutEnv ? intEnv(readTimeoutEnv, readTimeoutMs) : readTimeoutMs;
  const RETRY_BASE_MS = retryEnv ? intEnv(retryEnv, retryBaseMs) : retryBaseMs;
  const HEALTH_TTL_MS = 5 * 1000;
  const VOICES_TTL_MS = 60 * 1000;

  class SidecarError extends Error {
    constructor(message, { status = null, retryable = false, reason = "error" } = {}) {
      super(message);
      this.name = errorName;
      this.status = status;
      this.retryable = retryable;
      this.reason = reason;
    }
  }

  const connectProbe = makeConnectProbe({ label, timeoutMs: CONNECT_TIMEOUT_MS, code: `${name.toUpperCase()}_CONNECT_TIMEOUT` });

  function baseUrl() {
    const raw = process.env[baseUrlEnv] || defaultBaseUrl;
    return String(raw).replace(/\/+$/, "");
  }

  // ── one-shot warnings (log once per process, never spam) ──────────
  const warned = new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[${name}] ${message}`);
  }
  function resetWarnings() { warned.clear(); }

  // ── health (cached, single-flight, never throws) ──────────────────
  let healthCache = { ok: false, at: 0 };
  let healthInflight = null;

  async function probeHealth() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl()}${healthPath}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
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

  async function healthy() {
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
  }

  // ── voices (fetched once, cached, hard fallback) ──────────────────
  let voicesCache = { list: null, at: 0 };

  async function fetchVoiceIds() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl()}${voicesPath}`, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`voices endpoint returned ${res.status}`);
      const data = await res.json();
      const ids = Array.isArray(data) ? data : data && Array.isArray(data[voiceListKey]) ? data[voiceListKey] : null;
      if (!ids || !ids.length) throw new Error("voices endpoint returned no voices");
      return ids.filter((v) => typeof v === "string" && v);
    } finally {
      clearTimeout(timer);
    }
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
      warnOnce("voices", `could not fetch the voice list from the sidecar (${(err && err.message) || err}) — using the built-in ${label} voice catalog`);
      return fallbackVoices();
    }
  }

  function resetVoices() {
    voicesCache = { list: null, at: 0 };
  }

  // Warm the cache at load so the first listVoices call is already populated.
  // Fire-and-forget: a missing sidecar is not an error.
  loadVoices().catch(() => {});

  // ── synthesis ─────────────────────────────────────────────────────
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
      const res = await fetch(`${baseUrl()}${speechPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: contentType },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new SidecarError(
          `${label} sidecar returned ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
          { status: res.status, retryable: res.status >= 500, reason: `http_${res.status}` }
        );
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        throw new SidecarError(`${label} sidecar returned an empty audio body`, { retryable: true, reason: "empty_body" });
      }
      return { bytes: buf, contentType };
    } catch (err) {
      if (timedOut) {
        throw new SidecarError(`${label} sidecar read timeout after ${READ_TIMEOUT_MS}ms`, { retryable: true, reason: "read_timeout" });
      }
      if (signal && signal.aborted) {
        throw new SidecarError(`${label} synthesis aborted by caller`, { retryable: false, reason: "aborted" });
      }
      throw err;
    } finally {
      clearTimeout(readTimer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  async function synthesize({ text, voice, rate = 1, pitch = 0, signal }) {
    const body = buildBody({ text, voice, rate, pitch });
    let lastErr = null;

    for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo++) {
      if (signal && signal.aborted) {
        throw new SidecarError(`${label} synthesis aborted by caller`, { reason: "aborted" });
      }
      try {
        return await attempt({ body, signal });
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof SidecarError ? err.retryable : isConnectError(err);
        if (!retryable || attemptNo === maxAttempts - 1) break;
        const delay = RETRY_BASE_MS * 2 ** attemptNo;
        console.warn(`[${name}] attempt ${attemptNo + 1}/${maxAttempts} failed (${(err && err.reason) || "connect"}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastErr instanceof SidecarError) throw lastErr;
    throw new SidecarError(`${label} synthesis failed: ${String((lastErr && lastErr.message) || lastErr)}`, {
      retryable: isConnectError(lastErr),
      reason: isConnectError(lastErr) ? "connect" : "error",
    });
  }

  async function listVoices({ lang } = {}) {
    const voices = await loadVoices();
    if (!lang) return voices;
    const needle = String(lang).toLowerCase();
    return voices.filter((v) => String(v.lang).toLowerCase().startsWith(needle));
  }

  return {
    name,
    ext,
    contentType,
    baseUrl,
    CONNECT_TIMEOUT_MS,
    READ_TIMEOUT_MS,
    buildRequestBody: buildBody,
    loadVoices,
    warnOnce,
    resetWarnings,
    resetHealth,
    resetVoices,
    synthesize,
    listVoices,
    healthy,
    SidecarError,
    // Test hooks only — never called by the application.
    _internals: { connectProbe, probeHealth, isConnectError },
  };
}

module.exports = { createSidecar, intEnv, isConnectError };
