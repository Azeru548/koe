"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — guard.js
//
//  Free multi-tenant access control:
//    • stateless HMAC-signed tenant keys (valid as long as KOE_SECRET stays set)
//    • per-key and per-IP anonymous windows (requests + words, hour + day)
//    • global word budget + concurrency semaphore with a bounded FIFO queue
//      (edge-tts has no documented quota — we serialize upstream work)
//    • circuit breaker: repeated upstream synthesis failures open a cool-down
//    • best-effort JSON state snapshot (secret + registrations + counters)
//      - on the AWS instance this file lives on the EBS volume, but the app
//        must still boot correctly if it is missing or corrupt. KOE_SECRET is
//        always an env var, never state.
//
//  All limits are env-tunable (see CONFIG below).
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function boolEnv(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

const cfg = {
  // Free-key minting
  registerIpDay: intEnv("KOE_REGISTER_IP_DAY", 3),

  // Limits for a registered free key
  keyReqHour: intEnv("KOE_KEY_REQ_HOUR", 60),
  keyWordsHour: intEnv("KOE_KEY_WORDS_HOUR", 2000),
  keyWordsDay: intEnv("KOE_KEY_WORDS_DAY", 20000),

  // Limits for callers who have not registered (browser demo / curl)
  anonReqHour: intEnv("KOE_ANON_REQ_HOUR", 20),
  anonWordsHour: intEnv("KOE_ANON_WORDS_HOUR", 500),
  anonWordsDay: intEnv("KOE_ANON_WORDS_DAY", 3000),

  // Per-request caps (protect one tenant from monopolising the queue)
  maxWordsPerJob: intEnv("KOE_MAX_WORDS_PER_JOB", 6000),
  maxCharsPerJob: intEnv("KOE_MAX_CHARS_PER_JOB", 40000),
  maxCharsPerPreview: intEnv("KOE_MAX_CHARS_PER_PREVIEW", 600),

  // Global safety rail (shared by every tenant)
  globalConcurrency: Math.max(1, intEnv("KOE_GLOBAL_CONCURRENCY", 2)),
  globalQueue: intEnv("KOE_GLOBAL_QUEUE", 20),
  globalWordsDay: intEnv("KOE_GLOBAL_WORDS_DAY", 30000),

  // Ephemeral audio: generated files are deleted after this TTL.
  audioTtlSec: intEnv("KOE_AUDIO_TTL_SEC", 900),
  jobTtlSec: intEnv("KOE_JOB_TTL_SEC", 3600),
  previewTtlSec: intEnv("KOE_PREVIEW_TTL_SEC", 600),
  sweepIntervalSec: Math.max(15, intEnv("KOE_SWEEP_INTERVAL_SEC", 60)),

  // Upstream failure cool-down
  cooldownSec: intEnv("KOE_COOLDOWN_SEC", 60),

  // Require a free key for everything except health/register/limits/UI.
  requireKey: boolEnv("KOE_REQUIRE_KEY", false),
  stateFile: process.env.KOE_STATE_FILE || path.join(__dirname, ".koe-state.json"),
};

const keyLimits = () => ({ requestsPerHour: cfg.keyReqHour, wordsPerHour: cfg.keyWordsHour, wordsPerDay: cfg.keyWordsDay });
const anonLimits = () => ({ requestsPerHour: cfg.anonReqHour, wordsPerHour: cfg.anonWordsHour, wordsPerDay: cfg.anonWordsDay });

function publicLimits() {
  return {
    register: { keysPerIpPerDay: cfg.registerIpDay },
    key: keyLimits(),
    anon: anonLimits(),
    perJob: { maxWords: cfg.maxWordsPerJob, maxChars: cfg.maxCharsPerJob, maxPreviewChars: cfg.maxCharsPerPreview },
    global: { concurrency: cfg.globalConcurrency, queueMax: cfg.globalQueue, wordsPerDay: cfg.globalWordsDay },
    audio: {
      ttlSeconds: cfg.audioTtlSec,
      jobTtlSeconds: cfg.jobTtlSec,
      note: "Generated audio is ephemeral: it is deleted automatically. Download promptly.",
    },
    keyRequired: cfg.requireKey,
  };
}

// ── state file (best effort) ────────────────────────────────

let state = { secret: null, registrations: [], usage: [] };
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")));
} catch { /* first boot or wiped disk */ }

// Declared before saveState() can be called (the secret bootstrap below).
const regIps = new Map(Array.isArray(state.registrations) ? state.registrations : []);
const usage = new Map(Array.isArray(state.usage) ? state.usage : []);

let stateDirty = false;
function saveState() {
  try {
    state.registrations = Array.from(regIps.entries());
    state.usage = Array.from(usage.entries()).filter(([, u]) => u.dayWords || u.hourWords || u.hourReq || u.dayReq);
    const tmp = `${cfg.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(tmp, cfg.stateFile);
    } catch {
      fs.copyFileSync(tmp, cfg.stateFile);
      fs.rmSync(tmp, { force: true });
    }
    stateDirty = false;
  } catch { /* disk unavailable — in-memory limits still work this uptime */ }
}
setInterval(() => { if (stateDirty) saveState(); }, 30 * 1000).unref?.();

process.on("SIGTERM", () => saveState());
process.on("SIGINT", () => saveState());

// ── secret & signed tenant keys ─────────────────────────────

const SECRET = (() => {
  if (process.env.KOE_SECRET) return process.env.KOE_SECRET;
  if (state.secret) return state.secret;
  const gen = crypto.randomBytes(32).toString("hex");
  state.secret = gen;
  stateDirty = true;
  saveState();
  console.warn("[guard] KOE_SECRET not set — generated an ephemeral one; tenant keys will NOT survive a server restart. Set KOE_SECRET in production.");
  return gen;
})();

const KEY_RE = /^koe_sk_([0-9a-f]{12})_([A-Za-z0-9_-]{22,64})$/;

function signTid(tid) {
  return crypto.createHmac("sha256", `${SECRET}:koe.v1`).update(tid).digest("base64url").slice(0, 32);
}

function mintKey() {
  const tid = crypto.randomBytes(6).toString("hex");
  return { tid, key: `koe_sk_${tid}_${signTid(tid)}` };
}

function verifyKey(raw) {
  const m = KEY_RE.exec(String(raw || ""));
  if (!m) return null;
  const tid = m[1];
  const a = Buffer.from(m[2]);
  const b = Buffer.from(signTid(tid));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return tid;
}

// Stable, non-reversible subject id for anonymous (no-key) callers.
function anonSubject(ip) {
  const h = crypto.createHmac("sha256", `${SECRET}:anon`).update(String(ip || "unknown")).digest("base64url").slice(0, 12);
  return `anon:${h}`;
}

// Short-lived, key-less links to a finished job's audio. The hosted MCP hands
// these to agents so they can fetch the file without embedding an API key.
// Signed with the same secret; still bounded by the job's audio TTL.
function signDownload(jobId) {
  return crypto.createHmac("sha256", `${SECRET}:koe.dl.v1`).update(String(jobId)).digest("base64url").slice(0, 32);
}

function verifyDownload(jobId, token) {
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(signDownload(jobId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── registration (per-IP cap) ───────────────────────────────

function registerFromIp(ip, now = Date.now()) {
  const dw = Math.floor(now / DAY);
  // Store a keyed hash, never the raw IP.
  const ipKey = anonSubject(ip);
  let r = regIps.get(ipKey);
  if (!r || r.dayWin !== dw) r = { dayWin: dw, n: 0 };
  if (r.n >= cfg.registerIpDay) {
    regIps.set(ipKey, r);
    const err = new Error(`Registration limit reached: ${cfg.registerIpDay} free keys per IP per day. Try again after UTC midnight.`);
    err.status = 429;
    err.retryAfterSec = Math.ceil(((dw + 1) * DAY - now) / 1000);
    throw err;
  }
  r.n += 1;
  regIps.set(ipKey, r);
  stateDirty = true;
  saveState(); // registrations are the most valuable thing to persist
  return mintKey();
}

// ── usage windows ───────────────────────────────────────────

function windows(id, now = Date.now()) {
  const hw = Math.floor(now / HOUR);
  const dw = Math.floor(now / DAY);
  let u = usage.get(id);
  if (!u) {
    u = { hw, dw, hourReq: 0, hourWords: 0, dayReq: 0, dayWords: 0 };
    usage.set(id, u);
  }
  if (u.hw !== hw) { u.hw = hw; u.hourReq = 0; u.hourWords = 0; }
  if (u.dw !== dw) { u.dw = dw; u.dayReq = 0; u.dayWords = 0; }
  return u;
}

function retryAfterHours(now) { return Math.ceil(((Math.floor(now / HOUR) + 1) * HOUR - now) / 1000); }
function retryAfterDays(now) { return Math.ceil(((Math.floor(now / DAY) + 1) * DAY - now) / 1000); }

// Atomically check + consume quota for one submission.
// kind: "key" | "anon". Returns { ok: true } or { ok: false, status, error, retryAfterSeconds }.
function charge({ subjectId, kind, words, now = Date.now() }) {
  const lim = kind === "key" ? keyLimits() : anonLimits();
  const u = windows(subjectId, now);

  if (u.hourReq >= lim.requestsPerHour) {
    return { ok: false, status: 429, error: `Hourly request limit reached (${lim.requestsPerHour}/h).`, retryAfterSeconds: retryAfterHours(now) };
  }
  if (u.hourWords + words > lim.wordsPerHour) {
    return { ok: false, status: 429, error: `Hourly word limit reached (${lim.wordsPerHour} words/h) — this request is ${words} words.`, retryAfterSeconds: retryAfterHours(now) };
  }
  if (u.dayWords + words > lim.wordsPerDay) {
    return { ok: false, status: 429, error: `Daily word limit reached (${lim.wordsPerDay} words/day).`, retryAfterSeconds: retryAfterDays(now) };
  }
  const g = windows("__global__", now);
  if (g.dayWords + words > cfg.globalWordsDay) {
    return { ok: false, status: 429, error: `The service is at its global daily capacity (${cfg.globalWordsDay} words/day) to stay under Microsoft's radar.`, retryAfterSeconds: retryAfterDays(now) };
  }

  u.hourReq += 1; u.hourWords += words; u.dayReq += 1; u.dayWords += words;
  g.dayWords += words;
  stateDirty = true;
  return { ok: true };
}

// Refund words for a job that failed server-side. Requests are not refunded
// unless `requests` is explicitly set (e.g. the queue rejected it after charge).
function refund({ subjectId, words = 0, requests = false, now = Date.now() }) {
  if (!subjectId) return;
  const u = windows(subjectId, now);
  u.hourWords = Math.max(0, u.hourWords - words);
  u.dayWords = Math.max(0, u.dayWords - words);
  if (requests) {
    u.hourReq = Math.max(0, u.hourReq - 1);
    u.dayReq = Math.max(0, u.dayReq - 1);
  }
  const g = windows("__global__", now);
  g.dayWords = Math.max(0, g.dayWords - words);
  stateDirty = true;
}

function usageSnapshot(subjectId, kind, now = Date.now()) {
  const lim = kind === "key" ? keyLimits() : anonLimits();
  const u = windows(subjectId, now);
  return {
    hour: { requests: u.hourReq, words: u.hourWords, requestsLimit: lim.requestsPerHour, wordsLimit: lim.wordsPerHour, resetsInSeconds: retryAfterHours(now) },
    day: { requests: u.dayReq, words: u.dayWords, wordsLimit: lim.wordsPerDay, resetsInSeconds: retryAfterDays(now) },
  };
}

// ── global concurrency semaphore + bounded FIFO queue ──────

let active = 0;
const waiters = [];

// Returns a Promise when a slot is (eventually) granted, or null when the
// queue is full. Callers MUST await the promise and then releaseSlot().
function tryAcquireSlot() {
  if (active < cfg.globalConcurrency && waiters.length === 0) {
    active += 1;
    return Promise.resolve();
  }
  if (waiters.length >= cfg.globalQueue) return null;
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();       // hand the slot straight to the next waiter
  else active = Math.max(0, active - 1);
}

function slotStats() {
  return { active, queued: waiters.length, concurrency: cfg.globalConcurrency, queueMax: cfg.globalQueue };
}

function queueFull() {
  // Full only when every worker is busy AND the waiting room is at capacity.
  return active >= cfg.globalConcurrency && waiters.length >= cfg.globalQueue;
}

// ── circuit breaker for upstream (edge-tts) failures ────────

const circuit = { fails: 0, openUntil: 0 };

const TRANSIENT_RE = /403|429|NoAudioReceived|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket|websocket|getaddrinfo|Unexpected server|network|SSL|TLS/i;

function recordUpstreamFailure(err) {
  const msg = String((err && err.message) || err || "");
  // A bad voice id / invalid input must never cool the whole service down.
  if (!TRANSIENT_RE.test(msg)) {
    return { opened: false, transient: false, fails: circuit.fails };
  }
  circuit.fails += 1;
  const cool = Math.min(cfg.cooldownSec * 2 ** (circuit.fails - 1), 600);
  circuit.openUntil = Date.now() + cool * 1000;
  return { opened: true, transient: true, cool, fails: circuit.fails };
}

function recordUpstreamSuccess() {
  circuit.fails = 0;
  circuit.openUntil = 0;
}

function checkCircuit(now = Date.now()) {
  if (circuit.openUntil > now) {
    return { open: true, retryAfterSec: Math.ceil((circuit.openUntil - now) / 1000), fails: circuit.fails };
  }
  if (circuit.openUntil) {
    circuit.openUntil = 0;
    circuit.fails = 0;
  }
  return { open: false };
}

module.exports = {
  cfg,
  publicLimits,
  mintKey,
  verifyKey,
  anonSubject,
  signDownload,
  verifyDownload,
  registerFromIp,
  charge,
  refund,
  usageSnapshot,
  tryAcquireSlot,
  releaseSlot,
  slotStats,
  queueFull,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  checkCircuit,
  saveState,
};
