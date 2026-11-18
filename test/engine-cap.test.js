"use strict";
// Per-engine admission: a saturated sidecar engine must be skipped, not allowed
// to occupy the global pool while edge callers wait behind it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "koe-cap-"));
const DB = path.join(DIR, "cap.db");
process.env.KOE_DB_PATH = DB;

const { seedJob } = require("./dbseed");
const jobs = require("../jobs");

let seq = 0;
function job(status, engine) {
  seq += 1;
  return {
    id: `cap${seq}`,
    status,
    engine,
    voice: "bella",
    parts: 1,
    wordCount: 10,
    createdAt: new Date(Date.now() + seq).toISOString(),
  };
}

function reset() {
  for (const id of jobs.ids()) jobs.remove(id);
}

test.beforeEach(() => reset());
test.after(() => reset());

test("an engine at its cap is skipped so other engines get the slot", () => {
  seedJob(DB, job("generating (0/1)", "kitten"));
  const queuedKitten = seedJob(DB, job("queued", "kitten"));
  const queuedEdge = seedJob(DB, job("queued", "edge"));

  const claimed = jobs.claimNext(10, { kitten: 1 });
  assert.equal(claimed.id, queuedEdge.id, "edge should be claimed while kitten is saturated");

  // The kitten job is still waiting, untouched.
  assert.equal(jobs.get(queuedKitten.id).status, "queued");
});

test("the capped engine is claimable again below its cap", () => {
  seedJob(DB, job("generating (0/1)", "kitten"));
  const queuedKitten = seedJob(DB, job("queued", "kitten"));

  const claimed = jobs.claimNext(10, { kitten: 2 });
  assert.equal(claimed.id, queuedKitten.id);
  assert.equal(jobs.get(queuedKitten.id).status, "starting");
});

test("an engine with no configured cap is never skipped", () => {
  const queuedKitten = seedJob(DB, job("queued", "kitten"));
  const claimed = jobs.claimNext(10, { kokoro: 1 });
  assert.equal(claimed.id, queuedKitten.id);
});

test("null or empty caps behave exactly like the old global-only admission", () => {
  seedJob(DB, job("generating (0/1)", "kitten"));
  seedJob(DB, job("generating (0/1)", "kitten"));
  const queuedKitten = seedJob(DB, job("queued", "kitten"));

  assert.equal(jobs.claimNext(10, null).id, queuedKitten.id);

  reset();
  seedJob(DB, job("generating (0/1)", "kitten"));
  const again = seedJob(DB, job("queued", "kitten"));
  assert.equal(jobs.claimNext(10, {}).id, again.id);
});

test("the global limit still applies when every engine is under its cap", () => {
  seedJob(DB, job("starting", "edge"));
  seedJob(DB, job("generating (1/2)", "piper"));
  seedJob(DB, job("queued", "edge"));

  assert.equal(jobs.claimNext(2, { kitten: 1, kokoro: 1 }), null);
  assert.equal(jobs.claimNext(3, { kitten: 1, kokoro: 1 }).engine, "edge");
});

test("jobs with no engine recorded are not mistaken for a capped engine", () => {
  seedJob(DB, job("generating (0/1)", "kitten"));
  const legacy = job("queued", null);
  seedJob(DB, legacy);

  const claimed = jobs.claimNext(10, { kitten: 1 });
  assert.equal(claimed.id, legacy.id);
});

test("countRunningByEngine reports the live pool per engine", () => {
  seedJob(DB, job("starting", "edge"));
  seedJob(DB, job("generating (1/2)", "edge"));
  seedJob(DB, job("generating (0/1)", "kitten"));
  seedJob(DB, job("queued", "kitten"));

  assert.deepEqual(jobs.countRunningByEngine(), { edge: 2, kitten: 1 });
});

test("KOE_ENGINE_CONCURRENCY is parsed, with sidecars capped by default", () => {
  const guard = require("../guard");
  // Unset means the sidecar default: one in flight each, edge uncapped.
  assert.deepEqual(guard.cfg.engineConcurrency, { kokoro: 1, kitten: 1 });
  assert.equal(guard.publicLimits().global.engines.kitten, 1);
});

test("KOE_ENGINE_MAX_WORDS caps kitten below the global job cap", () => {
  const guard = require("../guard");
  // Kitten is too slow to finish more than ~900 words inside the 300 s
  // deadline, so it is rejected up front instead of failing later.
  assert.deepEqual(guard.cfg.engineMaxWords, { kitten: 900 });
  assert.equal(guard.maxWordsFor("kitten"), 900);
  assert.equal(guard.maxWordsFor("Kitten"), 900, "engine names are case-insensitive");
  assert.equal(guard.maxWordsFor("edge"), guard.cfg.maxWordsPerJob, "uncapped engines keep the global cap");
  assert.equal(guard.publicLimits().perJob.engineMaxWords.kitten, 900);
});

test("the per-engine word cap is env-tunable and never exceeds the global cap", () => {
  const read = (value) =>
    execFileSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify({caps: require('./guard').cfg.engineMaxWords, kitten: require('./guard').maxWordsFor('kitten')}))"],
      {
        cwd: ROOT,
        env: { ...process.env, KOE_DB_PATH: path.join(DIR, "probe.db"), KOE_ENGINE_MAX_WORDS: value },
      }
    ).toString().trim();

  assert.deepEqual(JSON.parse(read("kitten=1200")), { caps: { kitten: 1200 }, kitten: 1200 });
  // A per-engine cap above the global job cap is clamped, never raised.
  assert.deepEqual(JSON.parse(read("kitten=9000")), { caps: { kitten: 9000 }, kitten: 2000 });
  // Empty disables the ceiling: kitten falls back to the global cap.
  assert.deepEqual(JSON.parse(read("")), { caps: {}, kitten: 2000 });
});

test("the env override is honoured, including turning the ceiling off", () => {
  const read = (value) =>
    execFileSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify(require('./guard').cfg.engineConcurrency))"],
      {
        cwd: ROOT,
        env: { ...process.env, KOE_DB_PATH: path.join(DIR, "probe.db"), KOE_ENGINE_CONCURRENCY: value },
      }
    ).toString().trim();

  assert.deepEqual(JSON.parse(read("kokoro=2,kitten=1")), { kokoro: 2, kitten: 1 });
  assert.deepEqual(JSON.parse(read("")), {});
  assert.deepEqual(JSON.parse(read("Kitten=3, nonsense")), { kitten: 3 });
});
