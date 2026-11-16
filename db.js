"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — db.js  (persistent counters + keys)
//
//  SQLite via node-sqlite3-wasm: a pure-JS/WASM build of SQLite with real
//  file access, so the Docker image stays a plain `npm ci` with no native
//  addon to compile for arm/x64. It speaks real SQLite, so the upserts below
//  are genuine `INSERT ... ON CONFLICT DO UPDATE` statements.
//
//  Tables (created on open):
//    keys         issued API keys, stored as SHA-256 hashes — server-side,
//                 per-key revocable, and useless in a dumped database
//    usage        one row per (subject, window); window is
//                 'hour:YYYY-MM-DDTHH' or 'day:YYYY-MM-DD', both UTC
//    mint_ips     key-minting cap, one row per (ip, UTC day)
//    global_usage one row per UTC day — the hard global word ceiling
//
//  One connection for the process, opened at module load. Every
//  multi-statement operation runs inside BEGIN IMMEDIATE ... COMMIT, so a
//  check-then-increment charge is atomic even if two requests interleave.
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Database } = require("node-sqlite3-wasm");

const DB_PATH = process.env.KOE_DB_PATH || path.join(__dirname, "koe.db");

// Keys are persisted as SHA-256 hashes, never in plaintext: a dumped or
// backed-up database cannot be replayed as live API keys. The raw key exists
// only in the POST /keys response and on the client that stored it.
// The `key` column name is kept so existing databases keep their schema; it
// holds the digest, and `open()` drops any pre-hash plaintext row.
function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  key        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ip         TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  key      TEXT    NOT NULL,
  window   TEXT    NOT NULL,
  words    INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window)
);
CREATE TABLE IF NOT EXISTS mint_ips (
  ip    TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
CREATE TABLE IF NOT EXISTS global_usage (
  day   TEXT PRIMARY KEY,
  words INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_window ON usage (window);

-- Jobs live here instead of a rewritten JSON file: indexed reads, an atomic
-- claim for worker processes, and no whole-file rewrite per status update.
-- The full job object is kept in the data column so the public shape stays unchanged;
-- the columns beside it exist to be queried.
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  status           TEXT    NOT NULL,
  tenant           TEXT,
  engine           TEXT,
  voice            TEXT,
  data             TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  audio_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant  ON jobs (tenant);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at);
`;

let db = null;
let journalMode = "unknown";

function open() {
  if (db) return db;
  const dir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // WAL is what we want. The wasm VFS does not implement the shared-memory
  // file WAL needs, so SQLite silently falls back to 'delete' here; we still
  // ask for it (harmless) and record what actually happened so /healthz can
  // report it. Durability comes from synchronous=FULL + BEGIN IMMEDIATE.
  try {
    const row = db.get("PRAGMA journal_mode = WAL");
    journalMode = String((row && row.journal_mode) || "unknown");
  } catch { journalMode = "unknown"; }
  retryBusy(() => db.exec("PRAGMA synchronous = FULL"));
  // Several processes share this file (the server, worker processes). SQLite's
  // own busy handler is not reliable in the wasm VFS, so ask for one AND retry
  // in-process below; without this a second worker sees "database is locked".
  try { retryBusy(() => db.exec("PRAGMA busy_timeout = 5000")); } catch { /* older VFS */ }
  // Another process may be creating the same schema at this instant; retry, then
  // verify the tables are actually there before handing the handle out.
  retryBusy(() => db.exec(SCHEMA));
  const present = () => {
    try {
      return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'"));
    } catch (err) {
      if (BUSY_RE.test(String((err && err.message) || err))) return false;
      throw err;
    }
  };
  if (!present()) retryBusy(() => db.exec(SCHEMA));
  migratePlaintextKeys(db);
  return db;
}

// Upgrade from builds that stored raw `koe_sk_…` values. Each row is rewritten
// as its SHA-256 digest in one transaction, so issued keys keep resolving (no
// forced re-mint, no mint-cap cliff) and no plaintext secret survives on disk.
// A digest is 64 hex chars, which is how a non-migrated row is recognised.
function migratePlaintextKeys(d) {
  let rows;
  try { rows = d.all("SELECT key, created_at, ip FROM keys WHERE length(key) != 64"); } catch { return; }
  if (!rows || !rows.length) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      d.run("INSERT OR IGNORE INTO keys (key, created_at, ip) VALUES (?, ?, ?)", [hashKey(row.key), row.created_at, row.ip]);
      d.run("DELETE FROM keys WHERE key = ?", [row.key]);
    }
    d.exec("COMMIT");
  } catch {
    try { d.exec("ROLLBACK"); } catch { /* already rolled back */ }
  }
}

// Retry SQLITE_BUSY synchronously: the driver is synchronous, so an async
// sleep would mean yielding in the middle of a transaction.
const BUSY_RE = /database is locked|database table is locked|SQLITE_BUSY/i;
function retryBusy(fn, attempts = 120) {
  for (let i = 0; ; i += 1) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts || !BUSY_RE.test(String((err && err.message) || err))) throw err;
      const until = Date.now() + 5 + Math.min(50, i * 2);
      while (Date.now() < until) { /* spin briefly, then retry */ }
    }
  }
}

// Every statement goes through the retry: with two worker processes and a
// server on one database, a busy handle is normal, not an error.
function conn() {
  const d = open();
  return {
    run: (...args) => retryBusy(() => d.run(...args)),
    get: (...args) => retryBusy(() => d.get(...args)),
    all: (...args) => retryBusy(() => d.all(...args)),
    exec: (...args) => retryBusy(() => d.exec(...args)),
  };
}

// Run `fn` inside an immediate transaction: readers are locked out until the
// COMMIT, so check-then-increment can never interleave with another charge.
function transaction(fn) {
  open();
  return retryBusy(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  });
}

// ── keys ────────────────────────────────────────────────────

function insertKey({ key, ip = null, createdAt }) {
  open();
  db.run("INSERT OR IGNORE INTO keys (key, created_at, ip) VALUES (?, ?, ?)", [hashKey(key), createdAt, ip]);
}

// Looks a key up by digest, so the stored row never contains the secret.
function findKey(key) {
  open();
  return db.get("SELECT key, created_at FROM keys WHERE key = ?", [hashKey(key)]);
}

function countKeys() {
  open();
  const row = db.get("SELECT COUNT(*) AS n FROM keys");
  return Number(row ? row.n : 0);
}

// ── mint cap ────────────────────────────────────────────────
// Returns the number of mints for (ip, day) after this attempt, or null when
// the attempt would exceed `max` (nothing is written in that case).
function bumpMint(ip, day, max) {
  return transaction(() => {
    const row = db.get("SELECT count FROM mint_ips WHERE ip = ? AND day = ?", [ip, day]);
    const current = row ? Number(row.count) : 0;
    if (current >= max) return null;
    db.run(
      "INSERT INTO mint_ips (ip, day, count) VALUES (?, ?, 1) " +
      "ON CONFLICT (ip, day) DO UPDATE SET count = count + 1",
      [ip, day]
    );
    return current + 1;
  });
}

// ── usage ───────────────────────────────────────────────────

function readUsage(key, hourWindow, dayWindow) {
  open();
  const rows = db.all(
    "SELECT window, words, requests FROM usage WHERE key = ? AND window IN (?, ?)",
    [key, hourWindow, dayWindow]
  );
  const out = {
    hour: { words: 0, requests: 0 },
    day: { words: 0, requests: 0 },
  };
  for (const r of rows) {
    const slot = r.window === hourWindow ? out.hour : out.day;
    slot.words = Number(r.words) || 0;
    slot.requests = Number(r.requests) || 0;
  }
  return out;
}

function addUsage(key, hourWindow, dayWindow, words, requests) {
  open();
  const stmt =
    "INSERT INTO usage (key, window, words, requests) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (key, window) DO UPDATE SET words = words + excluded.words, " +
    "requests = requests + excluded.requests";
  db.run(stmt, [key, hourWindow, words, requests]);
  db.run(stmt, [key, dayWindow, words, requests]);
}

// Refunds: never below zero, and a row that does not exist stays at zero.
// The excluded.* values feed the INSERT branch; the SET branch subtracts the
// same literals, so a refund against a missing row is a no-op rather than a
// negative counter.
function subUsage(key, hourWindow, dayWindow, words, requests) {
  open();
  const stmt =
    "INSERT INTO usage (key, window, words, requests) VALUES (?, ?, 0, 0) " +
    "ON CONFLICT (key, window) DO UPDATE SET " +
    "words = MAX(0, words - ?), requests = MAX(0, requests - ?)";
  db.run(stmt, [key, hourWindow, words, requests]);
  db.run(stmt, [key, dayWindow, words, requests]);
}

function readGlobal(day) {
  open();
  const row = db.get("SELECT words FROM global_usage WHERE day = ?", [day]);
  return { words: row ? Number(row.words) || 0 : 0 };
}

function addGlobal(day, words) {
  open();
  db.run(
    "INSERT INTO global_usage (day, words) VALUES (?, ?) " +
    "ON CONFLICT (day) DO UPDATE SET words = words + excluded.words",
    [day, words]
  );
}

function subGlobal(day, words) {
  open();
  db.run(
    "INSERT INTO global_usage (day, words) VALUES (?, 0) " +
    "ON CONFLICT (day) DO UPDATE SET words = MAX(0, words - ?)",
    [day, words]
  );
}

// ── housekeeping ────────────────────────────────────────────

function health() {
  try {
    open();
    const row = db.get("SELECT 1 AS ok");
    return { ok: row && row.ok === 1, path: DB_PATH, journalMode };
  } catch (err) {
    return { ok: false, path: DB_PATH, journalMode, error: String(err && err.message).slice(0, 200) };
  }
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
}

// SIGTERM/SIGINT: close cleanly so the WAL/journal is checkpointed.
process.on("SIGTERM", () => close());
process.on("SIGINT", () => close());

module.exports = {
  DB_PATH,
  hashKey,
  open,
  conn,
  transaction,
  retryBusy,
  insertKey,
  findKey,
  countKeys,
  bumpMint,
  readUsage,
  addUsage,
  subUsage,
  readGlobal,
  addGlobal,
  subGlobal,
  health,
  close,
  get journalMode() { return journalMode; },
};
