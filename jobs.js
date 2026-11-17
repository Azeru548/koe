"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — jobs.js  (SQLite job store)
//
//  Replaces output/jobs.json. The JSON file was rewritten in full on every
//  status update and re-parsed on every poll, and two processes would have
//  clobbered each other. Jobs are rows now:
//
//    • reads are indexed (id is the PK, tenant/status/created_at have indexes)
//    • claimNext() takes a queued job atomically, so any number of worker
//      processes behind the same database can share one queue
//    • the public job shape is unchanged: the whole object lives in `data`
//
//  Every multi-statement operation runs inside BEGIN IMMEDIATE (db.transaction),
//  so claiming, counting and sweeping cannot interleave across processes.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const db = require("./db");

const RUNNING_SQL = "(status = 'starting' OR status LIKE 'generating%')";

function parse(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function put(job) {
  const conn = db.conn();
  conn.run(
    "INSERT INTO jobs (id, status, tenant, engine, voice, data, created_at, completed_at, audio_expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO UPDATE SET status = excluded.status, tenant = excluded.tenant, " +
      "engine = excluded.engine, voice = excluded.voice, data = excluded.data, " +
      "completed_at = excluded.completed_at, audio_expires_at = excluded.audio_expires_at",
    [
      job.id,
      job.status,
      job.tenant || null,
      job.engine || null,
      job.voice || null,
      JSON.stringify(job),
      Date.parse(job.createdAt || 0) || Date.now(),
      job.completedAt ? Date.parse(job.completedAt) : null,
      job.audioExpiresAt ? Date.parse(job.audioExpiresAt) : null,
    ]
  );
}

function create(job) {
  put(job);
  return job;
}

function get(id) {
  return parse(db.conn().get("SELECT data FROM jobs WHERE id = ?", [id]));
}

// Update only: a job deleted mid-flight (DELETE /job/:id) must not be
// resurrected by the worker's next status write.
function update(job) {
  db.conn().run(
    "UPDATE jobs SET status = ?, tenant = ?, engine = ?, voice = ?, data = ?, completed_at = ?, audio_expires_at = ? WHERE id = ?",
    [
      job.status,
      job.tenant || null,
      job.engine || null,
      job.voice || null,
      JSON.stringify(job),
      job.completedAt ? Date.parse(job.completedAt) : null,
      job.audioExpiresAt ? Date.parse(job.audioExpiresAt) : null,
      job.id,
    ]
  );
  return job;
}

// Newest first, optionally scoped to one tenant (tenant-isolation lives here so
// every caller — REST, MCP, stats — filters the same way).
function list({ tenant = null, limit = 100 } = {}) {
  const conn = db.conn();
  const rows = tenant
    ? conn.all("SELECT data FROM jobs WHERE tenant = ? ORDER BY created_at DESC LIMIT ?", [tenant, limit])
    : conn.all("SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(parse).filter(Boolean);
}

function remove(id) {
  db.conn().run("DELETE FROM jobs WHERE id = ?", [id]);
}

function countRunning() {
  return Number(db.conn().get(`SELECT COUNT(*) AS n FROM jobs WHERE ${RUNNING_SQL}`).n) || 0;
}

// Running jobs per engine. Used by the per-engine admission ceiling (and
// available for operator visibility): one engine must not be able to occupy
// every global slot and starve the others.
function countRunningByEngine() {
  const rows = db.conn().all(`SELECT COALESCE(engine, '') AS engine, COUNT(*) AS n FROM jobs WHERE ${RUNNING_SQL} GROUP BY engine`);
  const out = {};
  for (const row of rows) out[row.engine] = Number(row.n) || 0;
  return out;
}

function countQueued() {
  return Number(db.conn().get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").n) || 0;
}

// Every job id. The sweep uses this to decide which artifacts still have an
// owner; a paged list() would make anything older than the page look orphaned.
function ids() {
  return db.conn().all("SELECT id FROM jobs").map((row) => row.id);
}

function countAll() {
  return Number(db.conn().get("SELECT COUNT(*) AS n FROM jobs").n) || 0;
}

// Atomically take the oldest queued job. Two workers racing get different rows
// (or one gets null), because the SELECT and the UPDATE happen in one
// transaction and the UPDATE re-checks `status = 'queued'`.
function claimNext(limit = Infinity, engineCaps = null) {
  return db.transaction(() => {
    const conn = db.conn();
    // Admission: the global concurrency limit is checked in the same
    // transaction as the claim, so N processes cannot each admit a job and
    // overrun it. A busy pool means "nothing to claim right now", not an error.
    const running = Number(conn.get(`SELECT COUNT(*) AS n FROM jobs WHERE ${RUNNING_SQL}`).n) || 0;
    if (running >= limit) return null;

    // Per-engine ceiling, inside the same transaction as the claim: an engine
    // that is at its cap is skipped rather than blocking the queue, so a
    // saturated Kokoro/Kitten sidecar cannot starve the edge jobs behind it.
    const saturated = [];
    if (engineCaps && typeof engineCaps === "object") {
      const byEngine = conn.all(`SELECT COALESCE(engine, '') AS engine, COUNT(*) AS n FROM jobs WHERE ${RUNNING_SQL} GROUP BY engine`);
      for (const row of byEngine) {
        const cap = Number(engineCaps[row.engine]);
        if (Number.isFinite(cap) && Number(row.n) >= cap) saturated.push(row.engine);
      }
    }

    const row = saturated.length
      ? conn.get(
          `SELECT id FROM jobs WHERE status = 'queued' AND COALESCE(engine, '') NOT IN (${saturated.map(() => "?").join(",")}) ` +
            "ORDER BY created_at ASC LIMIT 1",
          saturated
        )
      : conn.get("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1");
    if (!row) return null;
    conn.run("UPDATE jobs SET status = 'starting' WHERE id = ? AND status = 'queued'", [row.id]);
    const after = conn.get("SELECT status, data FROM jobs WHERE id = ?", [row.id]);
    if (!after || after.status !== "starting") return null;   // lost the race
    const job = parse({ data: after.data });
    if (!job) return null;
    // Keep the JSON copy in step with the status column: everything that reads
    // a job (the API, the worker) goes through `data`.
    job.status = "starting";
    put(job);
    return job;
  });
}

// A job claimed by a worker that then died: if its script is still beside the
// work directory there is nothing lost, so put it back in the queue instead of
// failing it. Only rows whose script is gone are failed.
function requeueClaimed({ workDir, deadlineSec = 300 }, now = Date.now()) {
  return db.transaction(() => {
    const conn = db.conn();
    const rows = conn.all(`SELECT id, data FROM jobs WHERE ${RUNNING_SQL}`);
    const requeued = [];
    const failed = [];
    for (const row of rows) {
      const job = parse(row);
      if (!job) { conn.run("DELETE FROM jobs WHERE id = ?", [row.id]); continue; }
      const script = path.join(workDir, `${job.id}.parts.json`);
      if (fs.existsSync(script)) {
        job.status = "queued";
        job.progress = 0;
        job.error = null;
        // The original deadline died with the process; the work starts over.
        job.deadlineAt = new Date(now + deadlineSec * 1000).toISOString();
        put(job);
        requeued.push(job);
      } else {
        job.status = "failed";
        job.error = "Server restarted before this job finished — nothing was generated.";
        put(job);
        failed.push(job);
      }
    }
    return { requeued, failed };
  });
}

// At boot nothing is running yet, so any row still marked starting/generating
// belongs to a previous incarnation of the service and will never finish.
function failRunning(reason) {
  const conn = db.conn();
  const rows = conn.all(`SELECT id, data FROM jobs WHERE ${RUNNING_SQL}`);
  const out = [];
  for (const row of rows) {
    const job = parse(row);
    if (!job) { conn.run("DELETE FROM jobs WHERE id = ?", [row.id]); continue; }
    job.status = "failed";
    job.error = reason;
    put(job);
    out.push(job);
  }
  return out;
}

// A worker that died mid-job leaves a row in `starting`/`generating` forever,
// and that row also holds an admission slot. Fail them once they are past the
// deadline. Returns the jobs it gave up on, so the caller can refund and clean.
function reapStale(deadlineSec, now = Date.now()) {
  const cutoff = now - deadlineSec * 1000;
  return db.transaction(() => {
    const conn = db.conn();
    const rows = conn.all(
      `SELECT id, data FROM jobs WHERE ${RUNNING_SQL} AND created_at < ?`,
      [cutoff]
    );
    const out = [];
    for (const row of rows) {
      const job = parse(row);
      if (!job) { conn.run("DELETE FROM jobs WHERE id = ?", [row.id]); continue; }
      job.status = "failed";
      job.error = `Job stopped without finishing (worker gone or past its ${deadlineSec}s deadline) — nothing was generated.`;
      put(job);
      out.push(job);
    }
    return out;
  });
}

// TTL housekeeping: expire audio, drop old rows, and report which artifacts to
// delete. Returns { removed: [ids], expired: [ids] }.
function sweep({ jobTtlSec, audioTtlSec }, now = Date.now()) {
  return db.transaction(() => {
    const conn = db.conn();
    const removed = [];
    const expired = [];

    for (const row of conn.all("SELECT id, data, created_at FROM jobs")) {
      const job = parse(row);
      if (!job) { conn.run("DELETE FROM jobs WHERE id = ?", [row.id]); removed.push(row.id); continue; }
      if (now - Number(row.created_at) > jobTtlSec * 1000) {
        conn.run("DELETE FROM jobs WHERE id = ?", [row.id]);
        removed.push(row.id);
        continue;
      }
      const doneAt = job.completedAt ? Date.parse(job.completedAt) : 0;
      if (job.status === "done" && job.file && doneAt && now - doneAt > audioTtlSec * 1000) {
        job.file = null;
        job.audioDeletedAt = new Date(now).toISOString();
        put(job);
        expired.push(job.id);
      }
    }
    return { removed, expired };
  });
}

// Import a legacy output/jobs.json once, then leave it alone. Ids are preserved,
// so jobs a previous build issued keep resolving (and keep their audio links).
function importLegacy(file) {
  if (!file || !fs.existsSync(file)) return 0;
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(rows) || !rows.length) return 0;
  return db.transaction(() => {
    let imported = 0;
    for (const job of rows) {
      if (!job || !job.id) continue;
      const existing = db.conn().get("SELECT id FROM jobs WHERE id = ?", [job.id]);
      if (existing) continue;
      put(job);
      imported += 1;
    }
    return imported;
  });
}

module.exports = {
  create,
  get,
  update,
  list,
  remove,
  claimNext,
  countRunning,
  countRunningByEngine,
  countQueued,
  countAll,
  ids,
  reapStale,
  failRunning,
  requeueClaimed,
  sweep,
  importLegacy,
};
