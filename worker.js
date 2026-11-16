"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — worker.js
//
//  The synthesis worker. It claims queued jobs from the SQLite store, so any
//  number of these can run against the same database — the server embeds one
//  by default (KOE_EMBED_WORKER=false to turn it off and run `node worker.js`
//  processes instead).
//
//  Three things here exist purely for throughput:
//    • parts of one job synth in parallel (bounded), instead of one at a time
//    • identical (text, voice, rate, pitch, engine) requests are cached on disk,
//      so a repeated line costs a file copy instead of an upstream round-trip
//    • the per-part CLI start-up (~5 s) is amortised by packing paragraphs up to
//      the split threshold rather than one part per paragraph
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");

const guard = require("./guard");
const jobs = require("./jobs");
const engines = require("./engines");

const POLL_MS = Math.max(200, parseInt(process.env.KOE_WORKER_POLL_MS, 10) || 500);
const PART_CONCURRENCY = Math.max(1, parseInt(process.env.KOE_PART_CONCURRENCY, 10) || 2);
const EMBEDDED = String(process.env.KOE_EMBED_WORKER || "true").toLowerCase() !== "false";

function makePaths(outputDir) {
  const audio = path.join(outputDir, "audio");
  const work = path.join(outputDir, "work");
  const cache = path.join(outputDir, "cache");
  for (const dir of [audio, work, cache]) fs.mkdirSync(dir, { recursive: true });
  return { outputDir, audio, work, cache };
}

const PATHS = makePaths(process.env.KOE_OUTPUT_DIR || path.join(__dirname, "output"));

// ── the synthesis cache ─────────────────────────────────────
// Content-addressed by the exact request, so two users asking for the same line
// (the studio demo's default text, a marketing script, a re-run) pay once.
function cachePath({ engine, voice, rate, pitch, text }) {
  const key = crypto
    .createHash("sha256")
    .update([engine, voice, rate, pitch, text].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return path.join(PATHS.cache, `${key}.${engines.extFor(engine)}`);
}

async function synthesizeCached(engine, params) {
  const file = cachePath({ engine, ...params });
  try {
    const bytes = await fs.promises.readFile(file);
    if (bytes.length) return { bytes, cached: true };
  } catch { /* miss */ }
  const { bytes } = await engines.getEngine(engine).synthesize({ ...params, scratchDir: PATHS.work });
  try {
    await fs.promises.writeFile(file, bytes);
  } catch { /* cache is best-effort */ }
  return { bytes, cached: false };
}

// ── artifacts ───────────────────────────────────────────────
function createZip(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function deleteArtifacts(jobId) {
  fs.rmSync(path.join(PATHS.audio, `${jobId}.zip`), { force: true });
  fs.rmSync(path.join(PATHS.work, jobId), { recursive: true, force: true });
}

// ── one job ─────────────────────────────────────────────────
async function runJob(job, parts) {
  const jobDir = path.join(PATHS.work, job.id);
  const zipPath = path.join(PATHS.audio, `${job.id}.zip`);
  const ext = engines.extFor(job.engine);
  const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Date.now() + guard.cfg.jobDeadlineSec * 1000;
  const subject = job.tenant ? { id: job.tenant } : null;

  try {
    fs.mkdirSync(jobDir, { recursive: true });

    const writePart = async (i) => {
      if (Date.now() > deadlineAt) {
        const err = new Error(`Job exceeded its ${guard.cfg.jobDeadlineSec}s limit at part ${i + 1}/${parts.length} — partial audio was discarded.`);
        err.timedOut = true;
        throw err;
      }
      const { bytes } = await synthesizeCached(job.engine, {
        text: parts[i],
        voice: job.voice,
        rate: job.rate,
        pitch: job.pitch,
      });
      await fs.promises.writeFile(path.join(jobDir, `part_${String(i + 1).padStart(3, "0")}.${ext}`), bytes);
      job.status = `generating (${i + 1}/${parts.length})`;
      job.progress = Math.round(((i + 1) / parts.length) * 100);
      jobs.update(job);
    };

    job.status = `generating (0/${parts.length})`;
    job.progress = 0;
    jobs.update(job);

    // Bounded parallelism: a 3-part job no longer waits three round-trips in a row.
    let next = 0;
    const runners = Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= parts.length) return;
        await writePart(i);
      }
    });
    await Promise.all(runners);

    await createZip(jobDir, zipPath);
    fs.rmSync(jobDir, { recursive: true, force: true });

    job.status = "done";
    job.file = `${job.id}.zip`;
    job.completedAt = new Date().toISOString();
    job.audioExpiresAt = new Date(Date.now() + guard.cfg.audioTtlSec * 1000).toISOString();
    job.progress = 100;
    jobs.update(job);
    // Kokoro has its own failure domain: a dead sidecar must not cool down edge.
    if (job.engine !== "kokoro") guard.recordUpstreamSuccess();
    guard.logGeneration({
      rawKey: job.logKey || "", subject: subject ? subject.id : "admin", engine: job.engine, voice: job.voice,
      words: job.words, durationMs: Date.now() - Date.parse(job.createdAt || Date.now()), jobId: job.id,
    });
    return job;
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 300);
    console.error(`[JOB ${job.id}] engine=${job.engine} voice=${job.voice} failed:`, message);
    job.status = "failed";
    job.error = message;
    jobs.update(job);
    // Nothing was delivered, so the words and the request go back — booked into
    // the windows this job was charged in.
    if (subject) guard.refund({ subjectId: subject.id, words: job.words || 0, requests: true, windows: job.usage });
    if (job.engine !== "kokoro" && !(err && err.timedOut)) guard.recordUpstreamFailure(err);
    deleteArtifacts(job.id);
    return job;
  }
}

// ── the loop ────────────────────────────────────────────────
let stopping = false;

async function runOnce() {
  const job = jobs.claimNext(guard.cfg.globalConcurrency);
  if (!job) return false;
  const parts = Array.isArray(job.partsText) && job.partsText.length ? job.partsText : [job.text || ""];
  await runJob(job, parts);
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function start({ workers = guard.cfg.globalConcurrency, label = "worker" } = {}) {
  if (!EMBEDDED && label === "embedded") return;
  for (let i = 0; i < workers; i += 1) {
    (async () => {
      while (!stopping) {
        let ran = false;
        try {
          ran = await runOnce();
        } catch (err) {
          console.error(`[${label} ${i}] claim failed:`, String((err && err.message) || err).slice(0, 200));
        }
        if (!ran) await sleep(POLL_MS);
      }
    })();
  }
  console.log(`[${label}] ${workers} worker loop(s) started (part concurrency ${PART_CONCURRENCY})`);
}

function stop() {
  stopping = true;
}

module.exports = {
  start,
  stop,
  runJob,
  runOnce,
  synthesizeCached,
  cachePath,
  deleteArtifacts,
  PATHS,
  PART_CONCURRENCY,
  EMBEDDED,
};

// `node worker.js` runs worker loops only (no HTTP), for scaling out.
if (require.main === module) {
  const workers = Math.max(1, parseInt(process.env.KOE_WORKERS, 10) || guard.cfg.globalConcurrency);
  start({ workers, label: "worker" });
  process.on("SIGTERM", () => { stop(); setTimeout(() => process.exit(0), 200); });
  process.on("SIGINT", () => { stop(); setTimeout(() => process.exit(0), 200); });
}
