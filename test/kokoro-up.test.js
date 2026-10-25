"use strict";
// ─────────────────────────────────────────────────────────────
//  Kokoro integration tests — the sidecar IS running (a local mock).
//
//  Covers what the "sidecar down" file cannot:
//    • GET /voices?engine=kokoro returns the sidecar's own catalog
//    • an edge voice + engine:"kokoro" → 400 carrying validVoices
//    • a valid kokoro voice → job runs → GET /audio/:id serves the exact
//      bytes the sidecar produced, as audio/mpeg
//  Loopback only: no external network, no Docker daemon.
// ─────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-kokoro-up-"));
const JOBS_FILE = path.join(TMP, "output", "jobs.json");
const ADMIN_KEY = "admin-kokoro-up";
const { mintKey } = require("./helpers");

// What the mock sidecar "synthesises" — recognisable, so we can prove the
// bytes survived the job loop, the zip, and /audio/:id unchanged.
const FAKE_MP3 = Buffer.from("ID3-fake-mp3-from-the-sidecar-0123456789");
const SIDECAR_VOICES = ["af_heart", "am_adam", "bm_george", "ff_siwis"];

let sidecar;
let sidecarHits = { speech: 0 };
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
  return { status: res.status, data };
}

// The sidecar double: health, voices, and speech.
function startSidecar() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "healthy" }));
      }
      if (req.url === "/v1/audio/voices") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ voices: SIDECAR_VOICES }));
      }
      if (req.url === "/v1/audio/speech" && req.method === "POST") {
        sidecarHits.speech += 1;
        let raw = "";
        req.on("data", (d) => { raw += d; });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "audio/mpeg" });
          res.end(FAKE_MP3);
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.before(async () => {
  sidecar = await startSidecar();
  const sidecarPort = sidecar.address().port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TTS_BACKEND: "docker",
      KOE_SECRET: "kokoro-up-test-secret",
      API_KEY: ADMIN_KEY,
      KOE_REQUIRE_KEY: "true",
      KOE_REGISTER_IP_DAY: "10",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_DB_PATH: path.join(TMP, "koe.db"),
      KOE_OUTPUT_DIR: path.join(TMP, "output"),
      KOE_JOBS_FILE: JOBS_FILE,
      KOE_STATS_FILE: path.join(TMP, "stats.json"),
      KOE_SWEEP_INTERVAL_SEC: "15",
      KOKORO_BASE_URL: `http://127.0.0.1:${sidecarPort}`,
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
  if (sidecar) sidecar.close();
});

test("healthz reports kokoro as available while the sidecar is up", async () => {
  const res = await fetch(`${base}/healthz`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.engines.kokoro, true, "a live sidecar is reported as available");
});

test("GET /voices?engine=kokoro serves the sidecar's own catalog", async () => {
  const res = await json("GET", "/voices?engine=kokoro");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.voices.map((v) => v.id), SIDECAR_VOICES, "no aliasing to edge/piper ids");
  assert.equal(res.data.count, 4);

  // A lang the sidecar catalog does not match narrows to empty rather than
  // silently falling back to the wrong engine's list.
  const filtered = await json("GET", "/voices?engine=kokoro&lang=en-US");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.count, 2, "af_heart + am_adam are en-US");
});

test("an edge voice with engine:\"kokoro\" is a 400 carrying validVoices", async () => {
  const res = await json("POST", "/tts", {
    key,
    body: { text: "this must never be synthesised", engine: "kokoro", voice: "en-US-GuyNeural" },
  });

  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  assert.equal(res.data.engine, "kokoro");
  assert.match(res.data.error, /Invalid voice/);
  assert.ok(Array.isArray(res.data.validVoices), "the body lists valid kokoro ids");
  assert.equal(res.data.validVoices.length, 4);
  assert.deepEqual([...res.data.validVoices].sort(), [...SIDECAR_VOICES].sort());
  assert.equal(res.data.validVoiceCount, 4);
});

test("a valid kokoro voice produces an MP3 end to end", async () => {
  const before = sidecarHits.speech;

  const started = await json("POST", "/tts", {
    key,
    body: { text: "one short sentence for kokoro", engine: "kokoro", voice: "af_heart", rate: 1.2 },
  });
  assert.equal(started.status, 200, `expected 200, got ${started.status}: ${JSON.stringify(started.data)}`);
  const jobId = started.data.jobId;
  assert.ok(jobId);

  // Poll to completion.
  let job = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await json("GET", `/job/${jobId}`, { key });
    job = res.data;
    if (job && (job.status === "done" || job.status === "failed")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(job, "job was fetched");
  assert.equal(job.status, "done", `job should finish: ${job.error || ""}`);
  assert.equal(job.engine, "kokoro", "the job records its engine");
  assert.equal(sidecarHits.speech, before + 1, "the sidecar was actually called exactly once");

  // The audio must be the sidecar's bytes, served as audio/mpeg.
  const audio = await fetch(`${base}/audio/${jobId}`, { headers: { "x-api-key": key } });
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get("content-type") || "", /audio\/mpeg/);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.ok(bytes.equals(FAKE_MP3), "the exact sidecar bytes survive the job → zip → merge path");
  assert.match(audio.headers.get("content-disposition") || "", /\.mp3/, "kokoro serves .mp3, like edge");
});

test("the server stays healthy after the kokoro round trip", async () => {
  const res = await fetch(`${base}/healthz`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, "ok");
  assert.match(logs, /engine=kokoro/, "generation is logged with its engine");
  assert.match(logs, /\[gen\] key=koe_sk_/, "the success line exists");
  assert.ok(!logs.includes(key), "a full key must never reach stdout");
});
