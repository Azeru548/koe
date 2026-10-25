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
//    keys         issued API keys — server-side, per-key revocable
//    usage        one row per (subject, window); window is
//                 'hour:YYYY-MM-DDTHH' or 'day:YYYY-MM-DD', both UTC
//    mint_ips     key-minting cap, one row per (ip, UTC day)
//    global_usage one row per UTC day — the hard global word ceiling
//
//  One connection for the process, opened at module load. Every
//  multi-statement operation runs inside BEGIN IMMEDIATE ... COMMIT, so a
//  check-then-increment charge is atomic even if two requests interleave.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { Database } = require("node-sqlite3-wasm");

const DB_PATH = process.env.KOE_DB_PATH || path.join(__dirname, "koe.db");

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
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  return db;
}

function conn() { return open(); }

// Run `fn` inside an immediate transaction: readers are locked out until the
// COMMIT, so check-then-increment can never interleave with another charge.
function transaction(fn) {
  open();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

// ── keys ────────────────────────────────────────────────────

function insertKey({ key, ip = null, createdAt }) {
  open();
  db.run("INSERT OR IGNORE INTO keys (key, created_at, ip) VALUES (?, ?, ?)", [key, createdAt, ip]);
}

function findKey(key) {
  open();
  return db.get("SELECT key, created_at FROM keys WHERE key = ?", [String(key || "")]);
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
  open,
  conn,
  transaction,
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
