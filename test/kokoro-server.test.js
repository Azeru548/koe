"use strict";
// ─────────────────────────────────────────────────────────────
//  Kokoro integration tests — the sidecar is NOT running.
//
//  Spawns the real server.js with KOKORO_BASE_URL pointed at a closed port
//  and asserts the acceptance criteria:
//    • engine:"kokoro" → 503 {"error":"tts_unavailable"} inside 10s
//    • the failure consumes no quota (the check sits BEFORE guard.charge)
//    • GET /healthz stays 200 — a missing sidecar is never a liveness failure
//    • edge and piper route exactly as before
//  No external network, no Docker daemon.
// ─────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-kokoro-test-"));
const JOBS_FILE = path.join(TMP, "output", "jobs.json");
const ADMIN_KEY = "admin-kokoro-test";
const { mintKey } = require("./helpers");

let child;
let base;
let logs = "";
let key = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become healthy.\n${logs}`);
}

async function json(method, pathname, { key: k, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(k ? { "x-api-key": k } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, ms: Number(res.headers.get("x-elapsed")) || null };
}

test.before(async () => {
  const port = await freePort();
  const deadPort = await freePort(); // reserved then released = guaranteed closed
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // "docker" reports both CLI engines as available without probing for a
      // binary or needing a daemon, so this file proves that a DEAD SIDECAR
      // is what blocks kokoro — not the host's toolchain. (On a host with the
      // CLIs installed, TTS_BACKEND=native behaves identically for these tests.)
      TTS_BACKEND: "docker",
      KOE_SECRET: "kokoro-test-secret",
      API_KEY: ADMIN_KEY,
      KOE_REQUIRE_KEY: "true",
      KOE_REGISTER_IP_DAY: "10",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_DB_PATH: path.join(TMP, "koe.db"),
      KOE_OUTPUT_DIR: path.join(TMP, "output"),
      KOE_JOBS_FILE: JOBS_FILE,
      KOE_STATS_FILE: path.join(TMP, "stats.json"),
      KOE_SWEEP_INTERVAL_SEC: "15",
      // The sidecar is deliberately absent.
      KOKORO_BASE_URL: `http://127.0.0.1:${deadPort}`,
      KOKORO_CONNECT_TIMEOUT_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });

  await waitFor(`${base}/healthz`);
  const minted = await mintKey(base);
  key = minted.data.key;
  assert.ok(key, `key mint failed: ${JSON.stringify(minted.data)}`);
});

test.after(() => {
  if (child) child.kill();
});

test("healthz stays 200 and reports kokoro as unavailable", async () => {
  const res = await fetch(`${base}/healthz`);
  const data = await res.json();

  assert.equal(res.status, 200, "a missing sidecar must never fail liveness");
  assert.equal(data.db.ok, true);
  assert.equal(typeof data.engines, "object");
  assert.equal(data.engines.kokoro, false, "kokoro is reported down");
  assert.equal(data.engines.edge, true, "edge is unaffected");
});

test("engine:\"kokoro\" answers 503 within 10s and charges nothing", async () => {
  const before = await json("GET", "/usage", { key });
  assert.equal(before.status, 200);

  const started = Date.now();
  const res = await json("POST", "/tts", {
    key,
    body: { text: "a short sentence that should never be synthesised", engine: "kokoro", voice: "af_heart" },
  });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.data)}`);
  assert.equal(res.data.error, "tts_unavailable");
  assert.equal(res.data.engine, "kokoro");
  assert.ok(elapsed < 10_000, `503 must arrive within 10s, took ${elapsed}ms`);

  // The availability check runs before guard.charge(), so no words are ever
  // counted — the counters must be byte-identical to the baseline.
  const after = await json("GET", "/usage", { key });
  assert.equal(after.status, 200);
  assert.equal(after.data.usage.hour.words, before.data.usage.hour.words, "hour words unchanged");
  assert.equal(after.data.usage.hour.requests, before.data.usage.hour.requests, "hour requests unchanged");
  assert.equal(after.data.usage.day.words, before.data.usage.day.words, "day words unchanged");
  assert.equal(after.data.usage.day.requests, before.data.usage.day.requests, "day requests unchanged");
});

test("an edge voice passed with engine:\"kokoro\" still 503s while the sidecar is down", async () => {
  // Ordering matters: availability is checked before voice validation, so a
  // dead sidecar reports itself rather than arguing about voice ids.
  const res = await json("POST", "/tts", { key, body: { text: "hello", engine: "kokoro", voice: "en-US-GuyNeural" } });
  assert.equal(res.status, 503);
  assert.equal(res.data.error, "tts_unavailable");
});

test("edge still routes normally with the sidecar down", async () => {
  const res = await json("POST", "/tts", {
    key,
    body: { text: "edge must be untouched by the sidecar being absent", engine: "edge", voice: "en-US-GuyNeural" },
  });

  assert.equal(res.status, 200, `edge must not be 503: ${JSON.stringify(res.data)}`);
  assert.ok(res.data.jobId, "a job id is returned exactly as before");
  assert.ok(res.data.parts >= 1);
  assert.ok(res.data.wordCount > 0);
});

test("piper still routes normally with the sidecar down", async () => {
  const res = await json("POST", "/tts", {
    key,
    body: { text: "piper must be untouched too", engine: "piper", voice: "en_US-lessac-medium" },
  });

  assert.equal(res.status, 200, `piper must not be 503: ${JSON.stringify(res.data)}`);
  assert.ok(res.data.jobId);
});

test("an unknown engine is still a 400", async () => {
  const res = await json("POST", "/tts", { key, body: { text: "hello", engine: "nope" } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Invalid engine/);
  assert.match(res.data.error, /kokoro/, "the message lists every registered engine");
});

test("google is registered nowhere", async () => {
  const res = await json("POST", "/tts", { key, body: { text: "hello", engine: "google" } });
  assert.equal(res.status, 400, "the stub must not be selectable");
});

test("GET /voices serves each engine's own catalog", async () => {
  const edge = await json("GET", "/voices?engine=edge");
  assert.equal(edge.status, 200);
  assert.equal(edge.data.engine, "edge");
  assert.ok(edge.data.count >= 29, "the edge catalog is unchanged");
  assert.ok(edge.data.voices.some((v) => v.id === "en-US-GuyNeural"));

  const piper = await json("GET", "/voices?engine=piper");
  assert.equal(piper.status, 200);
  assert.equal(piper.data.voices[0].id, "en_US-lessac-medium");

  // Sidecar down → the built-in fallback, not an error.
  const kokoro = await json("GET", "/voices?engine=kokoro");
  assert.equal(kokoro.status, 200, "a dead sidecar still yields a catalog");
  assert.ok(kokoro.data.count >= 50, `expected the fallback catalog, got ${kokoro.data.count}`);
  assert.ok(kokoro.data.voices.some((v) => v.id === "af_heart"));

  const bad = await json("GET", "/voices?engine=nope");
  assert.equal(bad.status, 400);
});

test("the server process is still healthy after every kokoro failure", async () => {
  const res = await fetch(`${base}/healthz`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, "ok");
  assert.equal(data.db.ok, true);
  assert.match(logs, /engine=kokoro/, "failures are logged with their engine");
});
