"use strict";

// Boot-time ephemeral guarantees: no audio survives a restart, stale jobs are
// pruned, and jobs that were mid-flight are marked failed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { startStudio } = require("./helpers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-ephemeral-test-"));
const OUTPUT_DIR = path.join(TMP, "output");
const AUDIO_DIR = path.join(OUTPUT_DIR, "audio");
const JOBS_FILE = path.join(OUTPUT_DIR, "jobs.json");
const ADMIN_KEY = "ephemeral-admin-key";

const DONE_ID = "1700000000000-aaaaa";
const EXPIRED_ID = "1600000000000-bbbbb";
const RUNNING_ID = "1799999999999-ccccc";

let studio;
let base;

async function json(method, pathname, { key, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test.before(async () => {
  const now = Date.now();
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIO_DIR, `${DONE_ID}.zip`), "PK\u0003\u0004fake zip");
  fs.writeFileSync(
    JOBS_FILE,
    JSON.stringify([
      {
        id: DONE_ID, status: "done", voice: "en-US-GuyNeural", engine: "edge",
        rate: 1, pitch: 0, parts: 1, wordCount: 3, words: 3, tenant: null,
        createdAt: new Date(now - 60_000).toISOString(),
        completedAt: new Date(now - 30_000).toISOString(),
        file: `${DONE_ID}.zip`, error: null, progress: 100,
      },
      {
        id: EXPIRED_ID, status: "done", voice: "en-US-GuyNeural", engine: "edge",
        rate: 1, pitch: 0, parts: 1, wordCount: 3, words: 3, tenant: null,
        createdAt: new Date(now - 2 * 3600 * 1000).toISOString(),
        completedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
        file: `${EXPIRED_ID}.zip`, error: null, progress: 100,
      },
      {
        id: RUNNING_ID, status: "generating (1/2)", voice: "en-US-GuyNeural", engine: "edge",
        rate: 1, pitch: 0, parts: 2, wordCount: 9, words: 9, tenant: null,
        createdAt: new Date(now - 5_000).toISOString(),
        completedAt: null, file: null, error: null, progress: 50,
      },
    ], null, 2)
  );

  studio = await startStudio({
    readyPath: "/health",
    env: {
      KOE_SECRET: "ephemeral-test-secret",
      API_KEY: ADMIN_KEY,
      KOE_REQUIRE_KEY: "false",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_DB_PATH: path.join(TMP, "koe.db"),
      KOE_OUTPUT_DIR: OUTPUT_DIR,
      KOE_JOBS_FILE: JOBS_FILE,
    },
  });
  base = studio.base;
});

test.after(async () => {
  if (studio) await studio.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("boot deletes all stored audio", async () => {
  assert.deepEqual(fs.readdirSync(AUDIO_DIR), [], "audio dir must be empty after boot");

  const dl = await json("GET", `/download/${DONE_ID}`, { key: ADMIN_KEY });
  assert.equal(dl.status, 410);

  const job = await json("GET", `/job/${DONE_ID}`, { key: ADMIN_KEY });
  assert.equal(job.status, 200);
  assert.equal(job.data.file, null);
  assert.ok(job.data.audioDeletedAt, "expired audio should be marked deleted");
  assert.equal(job.data.tenant, undefined, "tenant must not be exposed");
});

test("jobs older than the job TTL are pruned", async () => {
  const jobs = await json("GET", "/jobs", { key: ADMIN_KEY });
  const ids = jobs.data.map((j) => j.id);
  assert.ok(!ids.includes(EXPIRED_ID), "expired job must be pruned");
  assert.ok(ids.includes(DONE_ID));
});

test("in-flight jobs from before the restart are marked failed", async () => {
  const job = await json("GET", `/job/${RUNNING_ID}`, { key: ADMIN_KEY });
  assert.equal(job.status, 200);
  assert.equal(job.data.status, "failed");
  assert.match(job.data.error, /restarted/i);
});
