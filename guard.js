"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — guard.js
//
//  Free multi-tenant access control:
//    • server-side keys: random `koe_sk_<32 hex>` records in SQLite (db.js).
//      Keys are issued by POST /keys, validated by PK lookup, and revocable
//      by deleting the row. Pre-v3 HMAC keys are no longer recognised.
//    • per-key and per-IP anonymous windows (requests + words, hour + day),
//      held in SQLite so counters survive restarts and deploys
//    • hard global daily word ceiling (global_usage) bounding worst-case cost
//    • kill switch (KOE_KILL_SWITCH) short-circuits every generation with 503
//    • global word budget + concurrency semaphore with a bounded FIFO queue
//      (edge-tts has no documented quota — we serialize upstream work)
//    • circuit breaker: repeated upstream synthesis failures open a cool-down
//    • the JSON state file now carries ONLY the KOE_SECRET fallback; it is
//      never load-bearing for counters or keys. KOE_SECRET is an env var.
//
//  All limits are env-tunable (see CONFIG below). Full keys are never
//  logged — use keyPrefix() for anything that hits stdout.
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");

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

// Counts are read from the job store; required lazily so a test that only uses
// guard does not need a database.
let jobsStore = null;
function jobCounts(kind) {
  try {
    if (!jobsStore) jobsStore = require("./jobs");
    return kind === "queued" ? jobsStore.countQueued() : jobsStore.countRunning();
  } catch {
    return 0;
  }
}

const cfg = {
  // Free-key minting (POST /keys): how many keys one IP may mint per UTC day.
  registerIpDay: intEnv("KOE_REGISTER_IP_DAY", 3),

  // Limits for a registered free key.
  // Spec names first; the pre-v3 names are still read so an existing
  // deployment keeps its tuning without edits.
  keyReqHour: intEnv("KOE_HOURLY_REQUESTS", intEnv("KOE_KEY_REQ_HOUR", 60)),
  keyWordsHour: intEnv("KOE_HOURLY_WORDS", intEnv("KOE_KEY_WORDS_HOUR", 2000)),
  keyWordsDay: intEnv("KOE_DAILY_WORDS", intEnv("KOE_KEY_WORDS_DAY", 20000)),

  // Limits for callers who have not registered (browser demo / curl)
  anonReqHour: intEnv("KOE_ANON_REQ_HOUR", 20),
  anonWordsHour: intEnv("KOE_ANON_WORDS_HOUR", 500),
  anonWordsDay: intEnv("KOE_ANON_WORDS_DAY", 3000),

  // Per-request caps (protect one tenant from monopolising the queue)
  // Measured throughput is ~8 words/s per worker, so 2,000 words is the most
  // that can finish inside the 300s job deadline. A 6,000-word cap could never
  // complete and would only ever produce a guaranteed failure.
  maxWordsPerJob: intEnv("KOE_MAX_JOB_WORDS", intEnv("KOE_MAX_WORDS_PER_JOB", 2000)),
  maxCharsPerJob: intEnv("KOE_MAX_CHARS_PER_JOB", 40000),
  maxCharsPerPreview: intEnv("KOE_MAX_CHARS_PER_PREVIEW", 600),

  // Global safety rail (shared by every tenant): hard daily word ceiling.
  // Each worker is an edge-tts subprocess waiting on the network, so this is
  // mostly a politeness limit towards the upstream endpoint, not a CPU one.
  globalConcurrency: Math.max(1, intEnv("KOE_GLOBAL_CONCURRENCY", 6)),
  globalQueue: intEnv("KOE_GLOBAL_QUEUE", 20),
  globalWordsDay: intEnv("KOE_GLOBAL_DAILY_WORDS", intEnv("KOE_GLOBAL_WORDS_DAY", 30000)),

  // Instant kill switch: every generation answers 503 {"error":"temporarily_disabled"}.
  killSwitch: boolEnv("KOE_KILL_SWITCH", false),

  // Key issuance anti-abuse. Turnstile is only in play when BOTH are set;
  // otherwise the proof-of-work challenge is used.
  turnstileSiteKey: process.env.TURNSTILE_SITEKEY || "",
  turnstileSecret: process.env.TURNSTILE_SECRET || "",

  // Ephemeral audio: generated files are deleted after this TTL.
  audioTtlSec: intEnv("KOE_AUDIO_TTL_SEC", 900),
  jobTtlSec: intEnv("KOE_JOB_TTL_SEC", 3600),
  previewTtlSec: intEnv("KOE_PREVIEW_TTL_SEC", 600),
  sweepIntervalSec: Math.max(15, intEnv("KOE_SWEEP_INTERVAL_SEC", 60)),

  // Upstream failure cool-down
  cooldownSec: intEnv("KOE_COOLDOWN_SEC", 60),

  // Wall-clock ceiling for one job, measured from submission (queue wait
  // included) to finished audio. Without it a single long script can hold one
  // of the few workers for tens of minutes while everyone else queues behind
  // it, and the caller has no way to tell waiting from working.
  jobDeadlineSec: Math.max(10, intEnv("KOE_JOB_DEADLINE_SEC", 300)),
  // How long a synchronous preview will wait for a worker before answering
  // 429 instead of holding the HTTP request open.
  previewWaitSec: Math.max(1, intEnv("KOE_PREVIEW_WAIT_SEC", 30)),

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
    perJob: { maxWords: cfg.maxWordsPerJob, maxChars: cfg.maxCharsPerJob, maxPreviewChars: cfg.maxCharsPerPreview, maxSeconds: cfg.jobDeadlineSec },
    global: { concurrency: cfg.globalConcurrency, queueMax: cfg.globalQueue, wordsPerDay: cfg.globalWordsDay },
    queue: { waitSeconds: cfg.jobDeadlineSec, previewWaitSeconds: cfg.previewWaitSec },
    audio: {
      ttlSeconds: cfg.audioTtlSec,
      jobTtlSeconds: cfg.jobTtlSec,
      note: "Generated audio is ephemeral: it is deleted automatically. Download promptly.",
    },
    keyRequired: cfg.requireKey,
  };
}

// ── state file (secret bootstrap only) ──────────────────────
// Keys, mint caps and counters live in SQLite (db.js). This JSON file keeps
// only the generated KOE_SECRET fallback for pre-env installs, so a wiped or
// missing file costs at most a fresh signing secret — never usage history.

let state = { secret: null };
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")));
} catch { /* first boot or wiped disk */ }

let stateDirty = false;
function saveState() {
  try {
    const tmp = `${cfg.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ secret: state.secret }, null, 2));
    try {
      fs.renameSync(tmp, cfg.stateFile);
    } catch {
      fs.copyFileSync(tmp, cfg.stateFile);
      fs.rmSync(tmp, { force: true });
    }
    stateDirty = false;
  } catch { /* disk unavailable — keys and counters still live in SQLite */ }
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

// ── keys (server-issued, SQLite-backed, per-key revocable) ─

// v3 keys are opaque random records: 32 hex chars (128 bits) after the
// `koe_sk_` prefix. They exist only as rows in the keys table, so revoking
// one is a row delete and every pre-v3 HMAC key is simply absent -> 401.
const KEY_RE = /^koe_sk_[0-9a-f]{32}$/;

// Stable, non-reversible id for tenant isolation and dashboard subjects.
// Derived from the raw key with KOE_SECRET, so nothing that stores
// `key:<id>` (jobs, stats exports) can be turned back into a usable key.
function keyId(raw) {
  return crypto.createHmac("sha256", `${SECRET}:koe.kid.v1`).update(String(raw || "")).digest("base64url").slice(0, 16);
}

// Logs only: enough to tell tenants apart, never enough to reconstruct one.
function keyPrefix(raw) {
  const s = String(raw || "");
  return s ? s.slice(0, 11) : "-";
}

function mintKey(ipHash = null, now = Date.now()) {
  const raw = `koe_sk_${crypto.randomBytes(16).toString("hex")}`;
  db.insertKey({ key: raw, ip: ipHash, createdAt: new Date(now).toISOString() });
  return { key: raw, tid: keyId(raw) };
}

// Fast PK lookup — one indexed read per request.
function verifyKey(raw) {
  const s = String(raw || "");
  if (!KEY_RE.test(s)) return null;
  if (!db.findKey(s)) return null;
  return keyId(s);
}

// True when the raw string is a live key row (no id derivation).
function isValidKey(raw) {
  const s = String(raw || "");
  return KEY_RE.test(s) && !!db.findKey(s);
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

// ── key issuance (per-IP, per-UTC-day cap) ───────────────────

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function registerFromIp(ip, now = Date.now()) {
  const day = utcDay(now);
  // mint_ips counts the raw IP, but it stores the keyed hash — a leaked or
  // dumped DB must not become a list of client addresses.
  const ipHash = anonSubject(ip);
  const count = db.bumpMint(ipHash, day, cfg.registerIpDay);
  if (count === null) {
    const err = new Error(`Registration limit reached: ${cfg.registerIpDay} free keys per IP per day. Try again after UTC midnight.`);
    err.status = 429;
    err.retryAfterSec = Math.ceil(((Math.floor(now / DAY) + 1) * DAY - now) / 1000);
    throw err;
  }
  return mintKey(ipHash, now);
}

// ── proof-of-work challenge (Turnstile fallback) ────────────

const POW_ZEROS = 4; // 4 leading zero hex chars == 2^16 sha256 tries

function newChallenge() {
  return crypto.randomBytes(16).toString("hex");
}

function verifyPow(challenge, nonce) {
  const c = String(challenge || "");
  const n = String(nonce || "");
  if (!/^[0-9a-f]{32,128}$/.test(c) || !/^[0-9a-f]{1,128}$/.test(n)) return false;
  const hash = crypto.createHash("sha256").update(`${c}${n}`).digest("hex");
  return hash.startsWith("0".repeat(POW_ZEROS));
}

// ── usage windows (UTC, persisted in SQLite) ────────────────

// 'hour:YYYY-MM-DDTHH' / 'day:YYYY-MM-DD', both UTC (see db.js).
function hourWindow(now = Date.now()) {
  return `hour:${new Date(now).toISOString().slice(0, 13)}`;
}
function dayWindow(now = Date.now()) {
  return `day:${new Date(now).toISOString().slice(0, 10)}`;
}

function retryAfterHours(now) { return Math.ceil(((Math.floor(now / HOUR) + 1) * HOUR - now) / 1000); }
function retryAfterDays(now) { return Math.ceil(((Math.floor(now / DAY) + 1) * DAY - now) / 1000); }

// Atomically check + consume quota for one submission.
// kind: "key" | "anon". Returns { ok: true } or
// { ok: false, status, reason, error, retryAfterSeconds }.
// The read-check-write happens inside one SQLite transaction, so two
// concurrent submissions can never both slip under the limit.
function charge({ subjectId, kind, words, now = Date.now() }) {
  if (cfg.killSwitch) {
    return { ok: false, status: 503, reason: "kill_switch", error: "temporarily_disabled" };
  }
  const w = Math.max(0, Math.floor(Number(words) || 0));
  if (w > cfg.maxWordsPerJob) {
    return {
      ok: false,
      status: 400,
      reason: "job_too_long",
      error: `Job too long (${w} words) — max ${cfg.maxWordsPerJob} words per job.`,
      retryAfterSeconds: 0,
    };
  }

  const lim = kind === "key" ? keyLimits() : anonLimits();
  const h = hourWindow(now);
  const d = dayWindow(now);

  const verdict = db.transaction(() => {
    const u = db.readUsage(subjectId, h, d);

    if (u.hour.requests >= lim.requestsPerHour) {
      return { reason: "hourly_requests", error: `Hourly request limit reached (${lim.requestsPerHour}/h).`, retryAfterSeconds: retryAfterHours(now) };
    }
    if (u.hour.words + w > lim.wordsPerHour) {
      return { reason: "hourly_words", error: `Hourly word limit reached (${lim.wordsPerHour} words/h) — this request is ${w} words.`, retryAfterSeconds: retryAfterHours(now) };
    }
    if (u.day.words + w > lim.wordsPerDay) {
      return { reason: "daily_words", error: `Daily word limit reached (${lim.wordsPerDay} words/day).`, retryAfterSeconds: retryAfterDays(now) };
    }

    const g = db.readGlobal(d);
    if (g.words + w > cfg.globalWordsDay) {
      return { reason: "global_daily_words", error: `The service is at its global daily capacity (${cfg.globalWordsDay} words/day) to stay under Microsoft's radar.`, retryAfterSeconds: retryAfterDays(now) };
    }

    db.addUsage(subjectId, h, d, w, 1);
    db.addGlobal(d, w);
    // Hand the exact windows back so a later refund lands where the charge did.
    return { ok: true, windows: { hour: h, day: d } };
  });

  return verdict.ok ? verdict : Object.assign({ ok: false, status: 429 }, verdict);
}

// Refund words for a job that failed server-side. Requests are not refunded
// unless `requests` is explicitly set (e.g. the queue rejected it after charge).
// Clamped at zero in SQL, so a double refund can never go negative.
function refund({ subjectId, words = 0, requests = false, windows = null, now = Date.now() }) {
  if (!subjectId) return;
  const w = Math.max(0, Math.floor(Number(words) || 0));
  const r = requests ? 1 : 0;
  if (!w && !r) return;
  // Refund into the window the charge was booked against, not into "now": a
  // job submitted at 10:59 that fails at 11:01 used to leave the 10:00 hour
  // charged and credit the 11:00 hour with usage the caller never spent.
  const h = (windows && windows.hour) || hourWindow(now);
  const d = (windows && windows.day) || dayWindow(now);
  db.transaction(() => {
    db.subUsage(subjectId, h, d, w, r);
    if (w) db.subGlobal(d, w);
  });
}

function usageSnapshot(subjectId, kind, now = Date.now()) {
  const lim = kind === "key" ? keyLimits() : anonLimits();
  const u = db.readUsage(subjectId, hourWindow(now), dayWindow(now));
  return {
    hour: { requests: u.hour.requests, words: u.hour.words, requestsLimit: lim.requestsPerHour, wordsLimit: lim.wordsPerHour, resetsInSeconds: retryAfterHours(now) },
    day: { requests: u.day.requests, words: u.day.words, wordsLimit: lim.wordsPerDay, resetsInSeconds: retryAfterDays(now) },
  };
}

// ── log lines (key prefix only — never a full key) ──────────

function logReject(reason, rawKey, ip, detail = "") {
  const extra = detail ? ` ${detail}` : "";
  console.log(`[guard] reject reason=${reason} key=${keyPrefix(rawKey)} ip=${ip || "-"}${extra}`);
}

// engine + voice are informational; the key is still only its 11-char
// prefix (the v3 logging rule — a full key never reaches stdout).
function logGeneration({ rawKey, subject, engine, voice, words, durationMs, jobId }) {
  console.log(
    `[gen] key=${keyPrefix(rawKey)} subject=${subject || "-"} engine=${engine || "-"} voice=${voice || "-"} words=${words} ` +
    `duration=${Math.round(durationMs)}ms job=${jobId || "-"}`
  );
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
  const waiter = { resolve: null };
  const promise = new Promise((resolve) => { waiter.resolve = resolve; waiters.push(waiter); });
  // A caller that stops waiting must leave the queue, or it would keep a place
  // occupied (and inflate the depth /healthz reports).
  promise.cancelWait = () => {
    const i = waiters.indexOf(waiter);
    if (i !== -1) waiters.splice(i, 1);
  };
  return promise;
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next.resolve();   // hand the slot straight to the next waiter
  else active = Math.max(0, active - 1);
}

function slotStats() {
  // Running and queued counts come from the database, not this process: with
  // several servers and worker processes the honest answer is the shared one.
  // `active` on its own is only this process's preview fan-out.
  const running = jobCounts("running");
  const queued = jobCounts("queued");
  const full = running >= cfg.globalConcurrency;
  const saturated = full && queued >= cfg.globalQueue;
  return {
    active: running,
    queued,
    concurrency: cfg.globalConcurrency,
    queueMax: cfg.globalQueue,
    // Honest state for callers and /healthz: a healthy db and "ok" do not mean
    // the service can accept work right now.
    saturated,
    load: saturated ? "saturated" : full ? "busy" : "idle",
    // Previews run inline in this process and are bounded per process, not by
    // the job queue; report them separately so neither number lies.
    previews: active,
    previewWaiters: waiters.length,
  };
}

function queueFull() {
  // Full only when every worker is busy AND the waiting room is at capacity,
  // counted across every process sharing the database.
  return jobCounts("running") >= cfg.globalConcurrency && jobCounts("queued") >= cfg.globalQueue;
}

// Bound a slot wait. `slotPromise` comes from tryAcquireSlot(); this resolves
// { granted: true } when the worker is handed over, or { granted: false } at the
// deadline so the caller can fail the job instead of hanging on it. If the slot
// is granted after we gave up, it is released immediately — a waiter that walked
// away must never swallow a worker, or the queue would starve behind it.
function waitForSlot(slotPromise, deadlineAt, now = Date.now()) {
  if (!slotPromise) return Promise.resolve({ granted: false, reason: "queue_full", waitedMs: 0 });
  const budget = Math.max(0, Number(deadlineAt) - now);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Leave the queue; if a very late hand-off still lands, pass it on.
      if (typeof slotPromise.cancelWait === "function") slotPromise.cancelWait();
      else Promise.resolve(slotPromise).then(() => releaseSlot(), () => {});
      resolve({ granted: false, reason: "wait_timeout", waitedMs: budget });
    }, budget);
    timer.unref?.();
    Promise.resolve(slotPromise).then(() => {
      if (settled) return;          // already timed out; the handler above releases it
      settled = true;
      clearTimeout(timer);
      resolve({ granted: true, waitedMs: budget - Math.max(0, deadlineAt - Date.now()) });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ granted: false, reason: "queue_full", waitedMs: 0 });
    });
  });
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
  isValidKey,
  keyId,
  keyPrefix,
  anonSubject,
  signDownload,
  verifyDownload,
  registerFromIp,
  utcDay,
  newChallenge,
  verifyPow,
  POW_ZEROS,
  hourWindow,
  dayWindow,
  charge,
  refund,
  usageSnapshot,
  tryAcquireSlot,
  waitForSlot,
  releaseSlot,
  slotStats,
  queueFull,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  checkCircuit,
  logReject,
  logGeneration,
  saveState,
  db,
};
