"use strict";
// Failure-path cleanup, end to end against a real server:
//   • a successful job deletes its parts.json
//   • a failed job deletes its parts.json
//   • a reaped job (worker died) deletes its parts.json and is refunded
//   • the periodic sweep — not just the write-time prune — holds the cache budget

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { seedJob, readJob } = require("./dbseed");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-sweep-test-"));
const OUTPUT = path.join(TMP, "output");
const WORK = path.join(OUTPUT, "work");
const CACHE = path.join(OUTPUT, "cache");
const DB_PATH = path.join(TMP, "koe.db");
const ADMIN_KEY = "sweep-test-admin";
const SWEEP_SEC = 2;

let child;
let base;
let logs = "";

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out waiting for ${url}\n${logs}`);
}

async function json(method, p, body, key = ADMIN_KEY) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitJob(id, ms = 60000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await json("GET", `/job/${id}`);
    if (last.data && ["done", "failed"].includes(last.data.status)) return last.data;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} did not finish: ${JSON.stringify(last && last.data)}\n${logs}`);
}

const scriptPath = (id) => path.join(WORK, `${id}.parts.json`);
const exists = (p) => fs.existsSync(p);

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TTS_BACKEND: "native",
      KOE_SECRET: "sweep-test-secret",
      API_KEY: ADMIN_KEY,
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_DB_PATH: DB_PATH,
      KOE_OUTPUT_DIR: OUTPUT,
      KOE_SWEEP_INTERVAL_SEC: String(SWEEP_SEC),
      KOE_JOB_DEADLINE_SEC: "5",
      KOE_CACHE_MAX_MB: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  await waitFor(`${base}/healthz`);
});

test.after(() => {
  if (child && !child.killed) child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("a successful job deletes its script once the audio is ready", async () => {
  const submitted = await json("POST", "/tts", { text: "A short line for cleanup.", voice: "en-US-EmmaNeural" });
  assert.equal(submitted.status, 200);
  const id = submitted.data.jobId;
  assert.ok(exists(scriptPath(id)), "the script exists while the job is in flight");

  const job = await waitJob(id);
  assert.equal(job.status, "done");
  assert.equal(exists(scriptPath(id)), false, "nothing keeps the script after success");
  // The deliverable survived the cleanup.
  const dl = await fetch(`${base}/download/${id}`, { headers: { "x-api-key": ADMIN_KEY } });
  assert.equal(dl.status, 200);
});

test("a failed job deletes its script too", async () => {
  const submitted = await json("POST", "/tts", { text: "This one cannot be spoken.", voice: "xx-XX-BogusNeural" });
  assert.equal(submitted.status, 200);
  const id = submitted.data.jobId;
  assert.ok(exists(scriptPath(id)));

  const job = await waitJob(id);
  assert.equal(job.status, "failed");
  assert.equal(exists(scriptPath(id)), false, "a terminal failure leaves no script behind");
});

test("a job reaped after its worker died is failed and its script cleaned up", async () => {
  const id = `${Date.now()}-reaped`;
  // A row a dead worker left claimed, older than the 5s deadline, with its
  // script still on disk: the sweep must give up on it, not leave it forever.
  seedJob(DB_PATH, {
    id, status: "generating (1/2)", voice: "en-US-EmmaNeural", engine: "edge",
    rate: 1, pitch: 0, parts: 1, wordCount: 3, words: 3, tenant: null, progress: 50,
    createdAt: new Date(Date.now() - 60_000).toISOString(), partsText: [],
  });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(scriptPath(id), JSON.stringify(["orphaned script"]));

  const until = Date.now() + 20000;
  let job = null;
  while (Date.now() < until) {
    job = readJob(DB_PATH, id);
    if (job && job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(job.status, "failed", "the sweep reaps a job nobody is running");
  assert.match(job.error, /deadline|stopped without finishing/i);
  assert.equal(exists(scriptPath(id)), false, "the reaped job's script is removed");
});

test("the periodic sweep enforces the cache budget, not just writes", async () => {
  const oversize = path.join(CACHE, "left-over-session.mp3");
  fs.mkdirSync(CACHE, { recursive: true });
  // 2 MB against a 1 MB budget, dropped in after boot and outside any write.
  fs.writeFileSync(oversize, Buffer.alloc(2 * 1024 * 1024, 7));
  assert.ok(exists(oversize));

  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (!exists(oversize)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(exists(oversize), false, "the sweep prunes the cache back under its budget");
  const remaining = fs.readdirSync(CACHE).reduce((sum, n) => sum + fs.statSync(path.join(CACHE, n)).size, 0);
  assert.ok(remaining <= 1024 * 1024, `cache is still ${remaining} bytes`);
});
