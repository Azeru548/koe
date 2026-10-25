const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const guard = require("./guard");
const stats = require("./stats");
const { mergeAudioParts } = require("./audio");
const { createHostedMcp } = require("./hosted-mcp");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const engines = require("./engines");
const { TTS_BACKEND } = require("./engines/backend");

// ─────────────────────────────────────────────
//  ENGINES
//  edge | piper | kokoro all live behind engines/index.js — one registry,
//  one interface. Backend detection (docker vs native CLI) is engines/backend.js.
//  edge remains the default; the sidecar for kokoro is optional, and when it
//  is down only engine:"kokoro" requests are rejected.
// ─────────────────────────────────────────────

// Live availability, refreshed on every request: edge/piper are their boot
// probes, kokoro is a cached health call to the sidecar (never throws).
async function engineAvailable(name) {
  const engine = engines.getEngine(name);
  if (!engine) return false;
  try {
    return Boolean(await engine.healthy());
  } catch {
    return false;
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Caddy/reverse proxy - req.ip comes from X-Forwarded-For
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); next(); });

// ─────────────────────────────────────────────
//  AUTH (optional) — set API_KEY to require it
// ─────────────────────────────────────────────

const API_KEY = process.env.API_KEY || ""; // optional ADMIN key: bypasses all limits, sees all jobs

function keyMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Free public product: every request is one of
//   admin  → matches API_KEY            (unlimited)
//   tenant → a valid signed key         (per-key limits; free keys via POST /api/register)
//   anon   → no key                     (smaller per-IP limits; powers the UI demo)
const OPEN_PATHS = new Set([
  "/health", "/healthz", "/api/register", "/api/limits", "/",
  "/keys", "/keys/challenge", // public: key issuance + anti-abuse challenge
  "/voices", // public voice catalog — already public in the studio UI
  "/studio", "/logo-mark.png", "/favicon-32.png", "/apple-touch-icon.png",
  "/stats.html", // the dashboard SHELL is public; its data comes from admin-only /stats.json
]);

// POST /mcp is the only API surface that ALWAYS needs a live keys-row key.
const isMcpPost = (req) => req.method === "POST" && req.path === "/mcp";

// GET /mcp serves the human setup page when a browser asks for HTML; MCP
// clients hit POST /mcp instead and must authenticate.
const wantsHtml = (req) => String(req.headers.accept || "").includes("text/html");

// ── request context (auth, logging, stats all read this) ──
app.use((req, res, next) => {
  req.ctx = { ip: String(req.ip || (req.connection && req.connection.remoteAddress) || "unknown"), tid: null, admin: false, rawKey: "" };
  next();
});

// ── KILL SWITCH ── KOE_KILL_SWITCH=true answers every generation entry
// point 503 before auth, quota, queue or upstream work is considered.
const GENERATION_PATHS = new Set(["/tts", "/tts-preview", "/tts-preview-piper", "/mcp"]);
app.use((req, res, next) => {
  if (req.method === "POST" && GENERATION_PATHS.has(req.path) && guard.cfg.killSwitch) {
    guard.logReject("kill_switch", req.ctx.rawKey, req.ctx.ip);
    return res.status(503).json({ error: "temporarily_disabled" });
  }
  next();
});

// ── AUTH ── admin key, or a live key row from the keys table ──
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.method === "GET" && req.path === "/mcp") return next();

  // Public voice samples used by the /mcp setup page.
  if (req.method === "GET" && req.path.startsWith("/mcp-sample-") && req.path.endsWith(".mp3")) return next();

  // Short-lived signed audio links (issued by the hosted MCP) skip the key.
  if (req.path.startsWith("/audio/")) {
    const id = req.path.slice("/audio/".length);
    if (id && typeof req.query.dl === "string" && guard.verifyDownload(id, req.query.dl)) return next();
  }

  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.headers["x-api-key"] || bearer || req.query.key || "";
  if (provided) {
    if (API_KEY && keyMatches(provided)) { req.ctx.admin = true; req.ctx.rawKey = provided; return next(); }
    const tid = guard.verifyKey(provided); // indexed PK lookup in the keys table
    if (tid) { req.ctx.tid = tid; req.ctx.rawKey = provided; return next(); }
    guard.logReject("invalid_key", provided, req.ctx.ip);
    return res.status(401).json({
      error: "invalid_key",
      hint: "POST /keys to get a new key",
    });
  }

  // The MCP endpoint never falls back to anonymous traffic.
  if (isMcpPost(req)) {
    guard.logReject("missing_key", "", req.ctx.ip, "path=/mcp");
    return res.status(401).json({ error: "invalid_key", hint: "POST /keys to get a new key" });
  }

  if (guard.cfg.requireKey && !OPEN_PATHS.has(req.path)) {
    guard.logReject("missing_key", "", req.ctx.ip, `path=${req.path}`);
    return res.status(401).json({ error: "invalid_key", hint: "POST /keys to get a new key" });
  }
  next();
});

// Global traffic counter — every request is observed (after req.ctx exists).
app.use((req, res, next) => { stats.observe(req); next(); });

// Which limits apply to this caller (null = admin, unlimited)
function callerSubject(req) {
  if (req.ctx.admin) return null;
  if (req.ctx.tid) return { id: `key:${req.ctx.tid}`, kind: "key" };
  return { id: guard.anonSubject(req.ctx.ip), kind: "anon" };
}

// The public entry point is the MCP setup page; the studio lives at /studio.
app.get("/", (req, res) => res.redirect(302, "/mcp"));
app.get("/studio", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Brand assets are public and cacheable — no key needed.
const PUBLIC_ASSETS = {
  "/logo-mark.png": "logo-mark.png",
  "/favicon-32.png": "favicon-32.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
};
for (const [route, file] of Object.entries(PUBLIC_ASSETS)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, "assets", file), { maxAge: "7d" }));
}

// ─────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────

const OUTPUT_DIR  = process.env.KOE_OUTPUT_DIR || path.join(__dirname, "output");
const WORK_DIR    = path.join(OUTPUT_DIR, "work");
const AUDIO_DIR   = path.join(OUTPUT_DIR, "audio");
const PREVIEW_DIR = path.join(OUTPUT_DIR, "previews");
const JOBS_FILE   = process.env.KOE_JOBS_FILE || path.join(OUTPUT_DIR, "jobs.json");

const LEGACY_JOB_ZIP_RE = /^\d{13}-[a-z0-9]{5}\.zip$/i;
const PREVIEW_FILE_RE   = /^preview(?:-piper)?-\d+[-a-z0-9]*\.(?:mp3|wav)$/i;

for (const dir of [OUTPUT_DIR, WORK_DIR, AUDIO_DIR, PREVIEW_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, "[]");

// ─────────────────────────────────────────────
//  JOB STORE HELPERS
// ─────────────────────────────────────────────

const activeJobs = new Set();
const deletedJobs = new Set();

function loadJobs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  const tmp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  try {
    fs.renameSync(tmp, JOBS_FILE);
  } catch {
    fs.copyFileSync(tmp, JOBS_FILE);
    fs.rmSync(tmp, { force: true });
  }
}

function saveJob(updatedJob) {
  if (deletedJobs.has(updatedJob.id)) return; // deleted while it was still generating
  const jobs = loadJobs();
  const idx  = jobs.findIndex(j => j.id === updatedJob.id);
  if (idx !== -1) jobs[idx] = updatedJob;
  else jobs.push(updatedJob);
  saveJobs(jobs);
}

function getJob(id) {
  return loadJobs().find(j => j.id === id) || null;
}

function deleteJobArtifacts(jobId) {
  fs.rmSync(path.join(AUDIO_DIR, `${jobId}.zip`), { force: true });
  fs.rmSync(path.join(WORK_DIR, jobId), { recursive: true, force: true });
}

// Generated audio is ephemeral: clear every audio artifact at boot. Job
// metadata may survive a restart, but never claims to be downloadable.
function bootCleanup() {
  for (const dir of [WORK_DIR, AUDIO_DIR, PREVIEW_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  // Pre-ephemeral versions also left per-job folders inside output/.
  try {
    const reserved = new Set(["work", "audio", "previews", path.basename(JOBS_FILE)]);
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      if (reserved.has(name)) continue;
      const full = path.join(OUTPUT_DIR, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else if (/\.zip$/i.test(name)) fs.rmSync(full, { force: true });
    }
  } catch { /* read-only or already clean */ }

  // Pre-ephemeral versions wrote zips/previews next to server.js.
  try {
    for (const name of fs.readdirSync(__dirname)) {
      if (LEGACY_JOB_ZIP_RE.test(name) || PREVIEW_FILE_RE.test(name)) {
        fs.rmSync(path.join(__dirname, name), { force: true });
      }
    }
  } catch { /* read-only or already clean */ }

  const now = Date.now();
  const kept = [];
  for (const job of loadJobs()) {
    const created = Date.parse(job.createdAt || 0);
    if (!Number.isFinite(created) || now - created > guard.cfg.jobTtlSec * 1000) continue;
    if (job.status === "done") {
      job.file = null;
      job.audioDeletedAt = new Date().toISOString();
    } else if (job.status !== "failed") {
      job.status = "failed";
      job.error = "Server restarted before this job finished";
    }
    kept.push(job);
  }
  saveJobs(kept);
}

// Periodic TTL sweep: delete expired audio, prune old jobs, and remove
// orphaned work dirs/zips/previews left behind by crashes.
function sweep() {
  const now = Date.now();
  const jobs = loadJobs();
  const kept = [];
  const keptIds = new Set();
  let changed = false;

  for (const job of jobs) {
    if (activeJobs.has(job.id)) {
      kept.push(job);
      keptIds.add(job.id);
      continue;
    }
    const created = Date.parse(job.createdAt || 0);
    if (!Number.isFinite(created) || now - created > guard.cfg.jobTtlSec * 1000) {
      deleteJobArtifacts(job.id);
      changed = true;
      continue;
    }

    if (job.status === "done" && job.file && !activeJobs.has(job.id)) {
      const doneAt = Date.parse(job.completedAt || job.createdAt || 0);
      if (Number.isFinite(doneAt) && now - doneAt > guard.cfg.audioTtlSec * 1000) {
        deleteJobArtifacts(job.id);
        job.file = null;
        job.audioDeletedAt = new Date().toISOString();
        changed = true;
      }
    }

    kept.push(job);
    keptIds.add(job.id);
  }

  if (changed) saveJobs(kept);

  try {
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (!activeJobs.has(name) && !keptIds.has(name)) {
        fs.rmSync(path.join(WORK_DIR, name), { recursive: true, force: true });
      }
    }
  } catch { /* dir vanished */ }

  try {
    for (const name of fs.readdirSync(AUDIO_DIR)) {
      const id = name.replace(/\.zip$/i, "");
      if (!keptIds.has(id)) fs.rmSync(path.join(AUDIO_DIR, name), { force: true });
    }
  } catch { /* dir vanished */ }

  try {
    for (const name of fs.readdirSync(PREVIEW_DIR)) {
      const file = path.join(PREVIEW_DIR, name);
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > guard.cfg.previewTtlSec * 1000) fs.rmSync(file, { force: true });
    }
  } catch { /* dir vanished */ }
}

bootCleanup();
setInterval(sweep, guard.cfg.sweepIntervalSec * 1000).unref?.();

// ─────────────────────────────────────────────
//  TEXT SPLITTING
// ─────────────────────────────────────────────

function splitText(text) {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const parts = [];
  for (const para of paragraphs) {
    if (para.length <= 3000) {
      parts.push(para);
    } else {
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let chunk = "";
      for (const s of sentences) {
        if ((chunk + s).length > 3000) {
          if (chunk) parts.push(chunk.trim());
          chunk = s;
        } else {
          chunk += s;
        }
      }
      if (chunk.trim()) parts.push(chunk.trim());
    }
  }
  return parts;
}

// ─────────────────────────────────────────────
//  TTS ENGINES
//  Moved into engines/ — edge.js, piper.js and kokoro.js each expose
//  synthesize() -> { bytes, contentType }, listVoices() and healthy().
//  server.js no longer knows how any particular engine produces audio.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  ZIP HELPER
// ─────────────────────────────────────────────

function createZip(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// ── FREE PRODUCT ROUTES ──────────────────────────────────

// ── KEY ISSUANCE ────────────────────────────────────────────
// Keys are minted here, server-side, and recorded in the keys table so they
// can be validated, counted and revoked. Two anti-abuse gates:
//   • Cloudflare Turnstile — when TURNSTILE_SITEKEY + TURNSTILE_SECRET are set
//   • proof-of-work otherwise — sha256(challenge + nonce) must start with
//     POW_ZEROS zero hex chars; challenges come from GET /keys/challenge and
//     are single-use with a 5 minute TTL.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX = 5000;
const powChallenges = new Map(); // challenge -> expiry (ms)

function issueChallenge() {
  const now = Date.now();
  if (powChallenges.size >= CHALLENGE_MAX) {
    for (const [c, exp] of powChallenges) if (exp <= now) powChallenges.delete(c);
    if (powChallenges.size >= CHALLENGE_MAX) powChallenges.clear();
  }
  const challenge = guard.newChallenge();
  powChallenges.set(challenge, now + CHALLENGE_TTL_MS);
  return challenge;
}

// Consumes the challenge whether or not it verifies: single-use means single-use.
function takeChallenge(challenge) {
  const key = String(challenge || "");
  const exp = powChallenges.get(key);
  if (exp === undefined) return false;
  powChallenges.delete(key);
  return exp > Date.now();
}

async function turnstileOk(token) {
  if (!token) return false;
  try {
    const form = new FormData();
    form.set("secret", guard.cfg.turnstileSecret);
    form.set("response", String(token));
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    return data && data.success === true;
  } catch (err) {
    // Never fail open: an unreachable verifier means no minting this second.
    console.error("[keys] turnstile verify failed:", String((err && err.message) || err).slice(0, 200));
    return false;
  }
}

function usingTurnstile() {
  return Boolean(guard.cfg.turnstileSecret);
}

// GET /keys/challenge — tells the client which gate to solve.
app.get("/keys/challenge", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (usingTurnstile()) {
    return res.json({ mode: "turnstile", sitekey: guard.cfg.turnstileSiteKey, expiresInSeconds: 300 });
  }
  const challenge = issueChallenge();
  res.json({
    mode: "pow",
    challenge,
    expiresInSeconds: Math.round(CHALLENGE_TTL_MS / 1000),
    pow: { algorithm: "sha256(challenge + nonce)", leadingZeroHexChars: guard.POW_ZEROS },
  });
});

// POST /keys — the canonical mint endpoint. Shared by /api/register.
async function handleMint(req, res) {
  const body = req.body || {};

  if (usingTurnstile()) {
    const ok = await turnstileOk(body.turnstileToken || body.token);
    if (!ok) {
      guard.logReject("turnstile_failed", "", req.ctx.ip);
      return res.status(403).json({ error: "turnstile_failed", hint: "Complete the Turnstile challenge and retry." });
    }
  } else {
    const challenge = String(body.challenge || "");
    if (!takeChallenge(challenge)) {
      guard.logReject("pow_challenge_invalid", "", req.ctx.ip);
      return res.status(403).json({ error: "pow_challenge_invalid", hint: "GET /keys/challenge for a fresh challenge." });
    }
    if (!guard.verifyPow(challenge, String(body.nonce || ""))) {
      guard.logReject("pow_failed", "", req.ctx.ip);
      return res.status(403).json({ error: "pow_failed", hint: "sha256(challenge + nonce) must start with the required zeros." });
    }
  }

  try {
    const minted = guard.registerFromIp(req.ctx.ip);
    console.log(`[keys] minted key=${guard.keyPrefix(minted.key)} ip=${req.ctx.ip}`);
    res.status(201).json({ key: minted.key, tenant: minted.tid, limits: guard.publicLimits() });
  } catch (err) {
    guard.logReject("mint_cap", "", req.ctx.ip);
    res.status(err.status || 500).json({ error: err.message, retryAfterSeconds: err.retryAfterSec });
  }
}

app.post("/keys", handleMint);

// POST /api/register — thin alias of POST /keys (same gate, same body, same
// 201 {key} payload) so pre-existing callers keep working instead of 404ing.
app.post("/api/register", handleMint);

// GET /api/limits — public policy (no secrets)
app.get("/api/limits", (req, res) => res.json(guard.publicLimits()));

// GET /mcp-sample-<voice>.mp3 — public preview clips for the setup page.
app.get("/mcp-sample-:file", (req, res) => {
  const match = /^(andrew|jenny|sonia)\.mp3$/.exec(String(req.params.file || ""));
  if (!match) return res.status(404).json({ error: "Not found" });
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__dirname, `mcp-sample-${match[1]}.mp3`));
});

// GET /voices?engine=<name>&lang=<prefix> — the per-engine voice catalog.
// edge/piper come from the static catalog in voices.js (unchanged); kokoro is
// fetched from the sidecar and cached, falling back to the built-in list when
// the sidecar is down. Never aliases a voice id across engines.
app.get("/voices", async (req, res) => {
  const engine = String(req.query.engine || engines.DEFAULT_ENGINE);
  if (!engines.isRegistered(engine)) {
    return res.status(400).json({ error: `Invalid engine — use one of: ${engines.ENGINE_NAMES.join(", ")}` });
  }
  const lang = req.query.lang ? String(req.query.lang) : undefined;
  try {
    const voices = await engines.getEngine(engine).listVoices({ lang });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ engine, count: voices.length, voices });
  } catch (err) {
    return res.status(500).json({ error: "Could not list voices", detail: String((err && err.message) || err).slice(0, 200) });
  }
});

// GET /usage — this caller's usage vs limits
app.get("/usage", (req, res) => {
  const subject = callerSubject(req);
  if (!subject) return res.json({ subject: "admin", unlimited: true });
  res.json({ subject: subject.kind, usage: guard.usageSnapshot(subject.id, subject.kind) });
});

// GET /stats — operator-only live dashboard (HTML), admins authenticate with
// the API key (?key=... or x-api-key). TTS cost accounting happens through
// stats.markWords from /tts and /tts-preview.
app.get("/stats", (req, res) => {
  if (!req.ctx.admin) {
    return res.status(403).json({ error: "Operator stats require the admin API key (x-api-key or ?key=)" });
  }
  const now = Date.now();
  const jobs = loadJobs();
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  const today = new Date(now).toISOString().slice(0, 10);
  const jobsToday = jobs.filter((j) => String(j.createdAt || "").startsWith(today));
  const jobs24h = jobs.filter((j) => Date.parse(j.createdAt || "0") > now - 864e5);
  const wordsToday = jobsToday.reduce((sum, j) => sum + (j.wordCount || 0), 0);
  res.set("Cache-Control", "no-store");
  res.send(stats.renderPage({
    jobsTotal: jobs.length,
    jobsToday: jobsToday.length,
    jobs24h: jobs24h.length,
    wordsToday,
    byStatus,
    slots: guard.slotStats(),
    uptimeSec: Math.floor(process.uptime()),
  }));
});

// The standalone dashboard page — loads without a key (the HTML itself is not
// secret); the numbers it renders come from /stats.json, which IS admin-only.
app.get("/stats.html", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "stats.html"));
});

// GET /stats.json — the same numbers as /stats, machine-friendly (admin-only)
app.get("/stats.json", (req, res) => {
  if (!req.ctx.admin) {
    return res.status(403).json({ error: "Operator stats require the admin API key (x-api-key)" });
  }
  const now = Date.now();
  const q = stats.query();
  const jobs = loadJobs();
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  const today = new Date(now).toISOString().slice(0, 10);
  const jobsToday = jobs.filter((j) => String(j.createdAt || "").startsWith(today));
  const wordsToday = jobsToday.reduce((sum, j) => sum + (j.wordCount || 0), 0);
  res.set("Cache-Control", "no-store");
  res.json({
    now: new Date(now).toISOString(),
    allTime: q.allTime,
    today: q.today,
    windows: q.windows,
    days: stats.recentDays(14),
    top: stats.topSubjects(10, "words").map((s) => ({ id: s.id, requests: s.requests, words: s.words, last: s.last, actions: s.actions || 0 })),
    topRequests: stats.topSubjects(10, "requests").map((s) => ({ id: s.id, requests: s.requests, words: s.words, last: s.last, actions: s.actions || 0 })),
    jobs: { total: jobs.length, today: jobsToday.length, wordsToday, byStatus },
    slots: guard.slotStats(),
    uptimeSec: Math.floor(process.uptime()),
  });
});

// POST /tts
app.post("/tts", async (req, res) => {
  const {
    text,
    voice = "en-US-GuyNeural",
    rate = 1,
    pitch = 0,
    engine = "edge"
  } = req.body || {};

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  if (!engines.isRegistered(engine)) {
    return res.status(400).json({ error: `Invalid engine — use one of: ${engines.ENGINE_NAMES.join(", ")}` });
  }

  const rateNum = Number(rate);
  const pitchNum = Number(pitch);
  if (!Number.isFinite(rateNum) || rateNum < 0.5 || rateNum > 2) {
    return res.status(400).json({ error: "Invalid rate — use a number between 0.5 and 2." });
  }
  if (!Number.isInteger(pitchNum) || Math.abs(pitchNum) > 100) {
    return res.status(400).json({ error: "Invalid pitch — use an integer between -100 and 100." });
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(voice))) {
    return res.status(400).json({ error: "Invalid voice id." });
  }

  // Availability is checked BEFORE guard.charge(), exactly where the old
  // CAPABILITIES check sat: an unavailable engine never consumes quota, so
  // there is nothing to refund. Kokoro's 503 has its own documented shape.
  if (!(await engineAvailable(engine))) {
    guard.logReject("engine_unavailable", req.ctx.rawKey, req.ctx.ip, `engine=${engine}`);
    if (engine === "kokoro") {
      return res.status(503).json({ error: "tts_unavailable", engine: "kokoro" });
    }
    return res.status(503).json({
      error: `Engine '${engine}' is not available on this server (backend: ${TTS_BACKEND})`,
    });
  }

  // Kokoro validates voice ids against its own catalog. An edge/piper id is
  // a 400 carrying the first 20 valid kokoro ids — never aliased across
  // engines. edge and piper deliberately keep accepting any well-formed id
  // (documented behaviour: any official Microsoft voice name works).
  if (engine === "kokoro") {
    const catalog = await engines.getEngine("kokoro").listVoices();
    if (!catalog.some((v) => v.id === String(voice))) {
      return res.status(400).json({
        error: `Invalid voice '${voice}' for engine 'kokoro'.`,
        engine: "kokoro",
        validVoices: catalog.slice(0, 20).map((v) => v.id),
        validVoiceCount: catalog.length,
      });
    }
  }

  const words = text.trim().split(/\s+/).length;
  if (text.length > guard.cfg.maxCharsPerJob) {
    return res.status(413).json({ error: `Script too long (${text.length} chars) — max ${guard.cfg.maxCharsPerJob} chars per job.`, maxChars: guard.cfg.maxCharsPerJob });
  }
  if (words > guard.cfg.maxWordsPerJob) {
    // Spec: a single oversized job is a 400, rejected BEFORE anything is counted.
    guard.logReject("job_too_long", req.ctx.rawKey, req.ctx.ip, `words=${words}`);
    return res.status(400).json({ error: `Job too long (${words} words) — max ${guard.cfg.maxWordsPerJob} words per job.`, maxWords: guard.cfg.maxWordsPerJob });
  }

  // ── rate limiting / queueing (free multi-tenant guards) ──
  const subject = callerSubject(req);

  const circ = guard.checkCircuit();
  if (circ.open) {
    guard.logReject("upstream_cooldown", req.ctx.rawKey, req.ctx.ip);
    return res.status(503).json({ error: "Synthesis is cooling down after upstream errors", retryAfterSeconds: circ.retryAfterSec });
  }
  if (guard.queueFull()) {
    guard.logReject("queue_full", req.ctx.rawKey, req.ctx.ip);
    return res.status(429).json({ error: "The synthesis queue is full — try again shortly", retryAfterSeconds: 30 });
  }
  if (subject) {
    const verdict = guard.charge({ subjectId: subject.id, kind: subject.kind, words });
    if (!verdict.ok) {
      guard.logReject(verdict.reason || "limit", req.ctx.rawKey, req.ctx.ip, `words=${words}`);
      return res.status(verdict.status).json({ error: verdict.error, retryAfterSeconds: verdict.retryAfterSeconds, reason: verdict.reason });
    }
  }
  const slot = guard.tryAcquireSlot();
  if (!slot) {
    // Lost a race for the last queue place: return the charge.
    if (subject) guard.refund({ subjectId: subject.id, words, requests: true });
    guard.logReject("queue_full", req.ctx.rawKey, req.ctx.ip, `words=${words}`);
    return res.status(429).json({ error: "The synthesis queue is full — try again shortly", retryAfterSeconds: 30 });
  }
  const submittedAt = Date.now();
  // Count the words against the same subject that observe() counted the request
  // for — including the admin caller, whose charge is skipped but whose work
  // still belongs on the dashboard.
  stats.markWords({ subject, words });

  const jobId      = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir     = path.join(WORK_DIR, jobId);
  const zipPath    = path.join(AUDIO_DIR, `${jobId}.zip`);
  const parts      = splitText(text);
  const wordCount  = words;

  // Resolved once from the registry: one interface for every engine.
  const activeEngine = engines.getEngine(engine);
  const engineExt    = engines.extFor(engine);

  const job = {
    id:         jobId,
    status:     "queued",
    voice,
    engine,
    rate:       rateNum,
    pitch:      pitchNum,
    parts:      parts.length,
    wordCount,
    tenant:     subject ? subject.id : null,
    words,
    textChars:  text.length,
    createdAt:  new Date().toISOString(),
    completedAt: null,
    audioExpiresAt: null,
    audioDeletedAt: null,
    file:       null,
    error:      null,
  };

  try {
    fs.mkdirSync(jobDir, { recursive: true });
    saveJob(job);
  } catch (err) {
    guard.releaseSlot();
    if (subject) guard.refund({ subjectId: subject.id, words, requests: true });
    deleteJobArtifacts(jobId);
    console.error(`[JOB ${jobId}] could not be created:`, err.message);
    return res.status(500).json({ error: "Could not create the job" });
  }

  // Schedule the work first so a failed response write can never orphan the slot.
  setImmediate(async () => {
    activeJobs.add(jobId);
    try {
      await slot;
      job.status = `generating (0/${parts.length})`;
      saveJob(job);

      for (let i = 0; i < parts.length; i++) {
        const base = `part_${String(i + 1).padStart(3, "0")}`;

        const { bytes } = await activeEngine.synthesize({
          text: parts[i],
          voice,
          rate: rateNum,
          pitch: pitchNum,
          scratchDir: jobDir,
        });
        await fs.promises.writeFile(path.join(jobDir, `${base}.${engineExt}`), bytes);

        job.status = `generating (${i + 1}/${parts.length})`;
        job.progress = Math.round(((i + 1) / parts.length) * 100);
        saveJob(job);
      }

      await createZip(jobDir, zipPath);
      fs.rmSync(jobDir, { recursive: true, force: true });

      job.status         = "done";
      job.file           = `${jobId}.zip`;
      job.completedAt    = new Date().toISOString();
      job.audioExpiresAt = new Date(Date.now() + guard.cfg.audioTtlSec * 1000).toISOString();
      job.progress       = 100;
      saveJob(job);
      // Kokoro has its own failure domain: it never touches the shared
      // circuit breaker, so a dead sidecar cannot cool down edge or piper.
      if (engine !== "kokoro") guard.recordUpstreamSuccess();
      guard.logGeneration({ rawKey: req.ctx.rawKey, subject: subject ? subject.id : "admin", engine, voice, words, durationMs: Date.now() - submittedAt, jobId });

    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 500);
      // One failure line per synthesis: engine + reason, key never included.
      console.error(`[JOB ${jobId}] engine=${engine} voice=${voice} failed:`, message);
      job.status = "failed";
      job.error  = message;
      saveJob(job);
      if (subject) guard.refund({ subjectId: subject.id, words });
      if (engine !== "kokoro") guard.recordUpstreamFailure(err);
      deleteJobArtifacts(jobId);
    } finally {
      if (deletedJobs.delete(jobId)) deleteJobArtifacts(jobId);
      guard.releaseSlot();
      activeJobs.delete(jobId);
    }
  });

  res.json({ jobId, parts: parts.length, wordCount });
});


// Tenant isolation: a job is visible only to its creator (or the admin key)
function canAccessJob(req, job) {
  if (req.ctx.admin) return true;
  if (!job.tenant) return false; // legacy/anonymous-less jobs are never exposed
  if (req.ctx.tid) return job.tenant === `key:${req.ctx.tid}`;
  return job.tenant === guard.anonSubject(req.ctx.ip);
}

function publicJob(job) {
  const { tenant, ...rest } = job;
  if (rest.audioExpiresAt && !rest.audioDeletedAt) {
    rest.expiresInSeconds = Math.max(0, Math.round((Date.parse(rest.audioExpiresAt) - Date.now()) / 1000));
  }
  return rest;
}

// GET /job/:id
app.get("/job/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden — this job belongs to another tenant" });
  res.setHeader("Cache-Control", "no-store");
  res.json(publicJob(job));
});

// GET /jobs
app.get("/jobs", (req, res) => {
  const jobs = loadJobs().reverse().filter(j => canAccessJob(req, j)).slice(0, 100);
  res.setHeader("Cache-Control", "no-store");
  res.json(jobs.map(publicJob));
});

// GET /download/:id
app.get("/download/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden — this job belongs to another tenant" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not ready", status: job.status });
  if (!job.file) return res.status(410).json({ error: "Audio expired — generated audio is ephemeral. Generate it again." });

  const filePath = path.join(AUDIO_DIR, `${req.params.id}.zip`);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: "Audio expired — generated audio is ephemeral. Generate it again." });
  }

  res.setHeader("Cache-Control", "no-store");
  res.download(filePath, `tts-${req.params.id}.zip`);
});

// GET /audio/:id — single merged audio file (mp3/wav), no zip.
// Access: an owning key, or the short-lived signed ?dl= token the hosted MCP
// hands to agents so they can fetch the file without an API key.
app.get("/audio/:id", (req, res) => {
  const job = getJob(req.params.id);
  const token = req.query.dl;
  const viaToken = typeof token === "string" && token && guard.verifyDownload(req.params.id, token);

  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!viaToken && !canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden — this job belongs to another tenant" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not ready", status: job.status });
  if (!job.file) return res.status(410).json({ error: "Audio expired — generated audio is ephemeral. Generate it again." });

  const zipPath = path.join(AUDIO_DIR, `${req.params.id}.zip`);
  if (!fs.existsSync(zipPath)) {
    return res.status(410).json({ error: "Audio expired — generated audio is ephemeral. Generate it again." });
  }

  const ext = engines.extFor(job.engine);
  let merged;
  try {
    const entries = new AdmZip(zipPath)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .sort((a, b) => a.entryName.localeCompare(b.entryName));
    if (!entries.length) return res.status(500).json({ error: "Job contained no audio parts" });
    merged = mergeAudioParts(entries.map((e) => e.getData()), ext);
  } catch (err) {
    return res.status(500).json({ error: "Could not assemble audio", detail: String(err.message || err).slice(0, 200) });
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", ext === "wav" ? "audio/wav" : "audio/mpeg");
  res.setHeader("Content-Disposition", `inline; filename="voiceover-${req.params.id}.${ext}"`);
  res.setHeader("Content-Length", String(merged.length));
  res.end(merged);
});

// DELETE /job/:id
app.delete("/job/:id", (req, res) => {
  const jobs    = loadJobs();
  const job     = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (!canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden — this job belongs to another tenant" });

  if (activeJobs.has(req.params.id)) deletedJobs.add(req.params.id);
  deleteJobArtifacts(req.params.id);
  saveJobs(jobs.filter(j => j.id !== req.params.id));

  res.json({ deleted: req.params.id });
});

// ── shared preview handler (metered + ephemeral) ──────────

function streamPreview(res, filePath, contentType, downloadName) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.unlink(filePath, () => {});
  };

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);
  res.setHeader("Cache-Control", "no-store");

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: "Preview could not be read" });
    else res.destroy();
  });
  stream.on("close", cleanup);
  res.on("close", cleanup);
  stream.pipe(res);
}

async function handlePreview({ engine, req, res, defaultVoice, defaultText, rate = 1, pitch = 0 }) {
  const { voice = defaultVoice, text = defaultText } = req.body || {};

  if (!(await engineAvailable(engine))) {
    return res.status(503).json({ error: `Engine '${engine}' is not available on this server (backend: ${TTS_BACKEND})` });
  }
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }
  if (text.length > guard.cfg.maxCharsPerPreview) {
    return res.status(400).json({ error: `Preview text too long — max ${guard.cfg.maxCharsPerPreview} chars.` });
  }

  const rateNum = Number(rate);
  const pitchNum = Number(pitch);
  if (!Number.isFinite(rateNum) || rateNum < 0.5 || rateNum > 2) {
    return res.status(400).json({ error: "Invalid rate — use a number between 0.5 and 2." });
  }
  if (!Number.isInteger(pitchNum) || Math.abs(pitchNum) > 100) {
    return res.status(400).json({ error: "Invalid pitch — use an integer between -100 and 100." });
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(voice))) {
    return res.status(400).json({ error: "Invalid voice id." });
  }

  const circ = guard.checkCircuit();
  if (circ.open) {
    guard.logReject("upstream_cooldown", req.ctx.rawKey, req.ctx.ip);
    return res.status(503).json({ error: "Synthesis is cooling down after upstream errors", retryAfterSeconds: circ.retryAfterSec });
  }

  const words = text.trim().split(/\s+/).length;
  const subject = callerSubject(req);
  if (subject) {
    const verdict = guard.charge({ subjectId: subject.id, kind: subject.kind, words });
    if (!verdict.ok) {
      guard.logReject(verdict.reason || "limit", req.ctx.rawKey, req.ctx.ip, `words=${words}`);
      return res.status(verdict.status).json({ error: verdict.error, retryAfterSeconds: verdict.retryAfterSeconds, reason: verdict.reason });
    }
  }

  const slot = guard.tryAcquireSlot();
  if (!slot) {
    if (subject) guard.refund({ subjectId: subject.id, words, requests: true });
    guard.logReject("queue_full", req.ctx.rawKey, req.ctx.ip, `words=${words}`);
    return res.status(429).json({ error: "The synthesis queue is full — try again shortly", retryAfterSeconds: 30 });
  }
  stats.markWords({ subject, words });
  const submittedAt = Date.now();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    guard.releaseSlot();
  };

  const ext = engines.extFor(engine);
  const prefix = engine === "piper" ? "preview-piper" : "preview";
  const fileName = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  const previewPath = path.join(PREVIEW_DIR, fileName);

  try {
    await slot;
    try {
      const { bytes } = await engines.getEngine(engine).synthesize({
        text,
        voice,
        rate: rateNum,
        pitch: pitchNum,
        scratchDir: PREVIEW_DIR,
      });
      await fs.promises.writeFile(previewPath, bytes);
    } finally {
      release();
    }

    if (!fs.existsSync(previewPath)) {
      if (subject) guard.refund({ subjectId: subject.id, words });
      return res.status(500).json({ error: "Preview file not written" });
    }

    guard.recordUpstreamSuccess();
    guard.logGeneration({ rawKey: req.ctx.rawKey, subject: subject ? subject.id : "admin", engine, voice, words, durationMs: Date.now() - submittedAt, jobId: `preview:${fileName}` });
    streamPreview(res, previewPath, engines.contentTypeFor(engine), `preview.${ext}`);
  } catch (err) {
    release();
    if (subject) guard.refund({ subjectId: subject.id, words });
    guard.recordUpstreamFailure(err);
    console.error(`[PREVIEW ${engine}] failed:`, String(err.message || err).slice(0, 300));
    if (!res.headersSent) {
      res.status(500).json({ error: "Preview generation failed", detail: String(err.message || err).slice(0, 300) });
    }
  }
}

// POST /tts-preview — Edge only, streams MP3 directly
app.post("/tts-preview", (req, res) => {
  const { rate = 1, pitch = 0 } = req.body || {};
  handlePreview({
    engine: "edge",
    req, res,
    defaultVoice: "en-US-GuyNeural",
    defaultText: "This is a preview of your selected voice.",
    rate, pitch,
  });
});

// POST /tts-preview-piper — Piper only, streams WAV directly
app.post("/tts-preview-piper", (req, res) => {
  handlePreview({
    engine: "piper",
    req, res,
    defaultVoice: "en_US-lessac-medium",
    defaultText: "This is a preview of your selected Piper voice.",
  });
});

// ── HOSTED MCP (Streamable HTTP) ──────────────────────────
// A per-request studio client that talks to our own guarded API on loopback.
// Re-passing the caller's key means every MCP tool call goes through exactly
// the same rate limits, queueing and tenant isolation as the REST API.

function makeStudioClient(req) {
  const key = req.ctx.rawKey || "";
  const loopback = `http://127.0.0.1:${PORT}`;
  const publicBase = (process.env.KOE_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

  async function call(method, pathname, body) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (key) headers["x-api-key"] = key;
    return fetch(`${loopback}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function json(method, pathname, body) {
    const res = await call(method, pathname, body);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const err = new Error(`${res.status} — ${data.error || data.detail || `${pathname} failed`}`);
      err.status = res.status;
      err.retryAfterSeconds = Number(data.retryAfterSeconds) || null;
      throw err;
    }
    return data;
  }

  return {
    studioUrl: publicBase,
    keyMode: req.ctx.admin ? "admin" : req.ctx.tid ? "key" : "anon",
    health: () => json("GET", "/health"),
    usage: () => json("GET", "/usage"),
    submit: (body) => json("POST", "/tts", body),
    job: (id) => json("GET", `/job/${encodeURIComponent(id)}`),
    listJobs: () => json("GET", "/jobs"),
    async download(id) {
      const res = await call("GET", `/download/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(`${res.status} — ${data.error || "download failed"}`);
        err.status = res.status;
        throw err;
      }
      return Buffer.from(await res.arrayBuffer());
    },
    signAudioUrl: (id) => `${publicBase}/audio/${encodeURIComponent(id)}?dl=${guard.signDownload(id)}`,
  };
}

// GET /mcp → human setup page (browsers); MCP clients use POST /mcp.
app.get("/mcp", (req, res) => {
  if (!wantsHtml(req)) {
    res.setHeader("Allow", "POST");
    return res.status(200).type("text/plain").send(
      "Koe MCP endpoint. MCP clients use POST here. Open this URL in a browser for the setup page."
    );
  }
  res.sendFile(path.join(__dirname, "mcp.html"));
});

// POST /mcp → stateless Streamable HTTP MCP. A fresh server + transport per
// request keeps it safe behind a reverse proxy and ephemeral disk.
app.post("/mcp", async (req, res) => {
  const server = createHostedMcp({ client: makeStudioClient(req) });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[MCP] request failed:", String((err && err.message) || err).slice(0, 300));
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

app.delete("/mcp", (req, res) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" }, id: null });
});

// GET /healthz — liveness + "can I actually touch the database".
// GET /health is the same handler kept as an alias (existing probes, docs,
// AGENTS.md and the watchdog all point at it).
async function healthHandler(req, res) {
  const dbInfo = guard.db.health();
  // Engine availability is informational only: a missing sidecar must never
  // turn this endpoint into a 503, or the watchdog would kill a healthy app.
  const engineState = await engines.healthSnapshot();
  res.setHeader("Cache-Control", "no-store");
  res.status(dbInfo.ok ? 200 : 503).json({
    status:       dbInfo.ok ? "ok" : "degraded",
    uptime:       Math.round(process.uptime()),
    jobs:         loadJobs().length,
    time:         new Date().toISOString(),
    backend:      TTS_BACKEND,
    engines:      engineState,
    authRequired: Boolean(API_KEY) || guard.cfg.requireKey,
    adminKeyConfigured: Boolean(API_KEY),
    keyRequired:  guard.cfg.requireKey,
    freeKeys:     true,
    killSwitch:   guard.cfg.killSwitch,
    db:           { ok: dbInfo.ok, path: dbInfo.path, journalMode: dbInfo.journalMode },
    mcp:          { endpoint: "/mcp", transport: "streamable-http", stateless: true, setup: "/mcp" },
    queue:        guard.slotStats(),
    ephemeral:    { audioTtlSeconds: guard.cfg.audioTtlSec, jobTtlSeconds: guard.cfg.jobTtlSec },
    limits:       guard.publicLimits(),
  });
}
app.get("/healthz", healthHandler);
app.get("/health", healthHandler);

// JSON error handler (bad body, too large, unexpected failures)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "Request body too large — max 10 MB." });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  console.error("[SERVER ERROR]", String((err && err.message) || err).slice(0, 300));
  res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, async () => {
  console.log(`TTS Studio server running → http://localhost:${PORT}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  const engineState = await engines.healthSnapshot();
  console.log(`TTS backend: ${TTS_BACKEND} · engines: ${Object.entries(engineState).map(([k, v]) => `${k}=${v}`).join(" ")} · default=${engines.DEFAULT_ENGINE}`);
  if (!engineState.kokoro) console.log("Kokoro sidecar is not reachable — engine \"kokoro\" will answer 503 until `docker compose up -d`.");
  console.log(`Admin API key: ${API_KEY ? "configured (unlimited)" : "not set"}`);
  console.log(`Free tier: ${guard.cfg.requireKey ? "key required" : "anonymous allowed"} · audio TTL ${guard.cfg.audioTtlSec}s · queue ${guard.cfg.globalConcurrency}`);
});

function shutdown() {
  guard.saveState();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

