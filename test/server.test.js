"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-server-test-"));
const JOBS_FILE = path.join(TMP, "output", "jobs.json");
const ADMIN_KEY = "admin-test-key";

let child;
let base;
let logs = "";
let keys = [];
let tenants = [];

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

async function json(method, pathname, { key, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TTS_BACKEND: "native",
      KOE_SECRET: "server-test-secret",
      API_KEY: ADMIN_KEY,
      KOE_REQUIRE_KEY: "true",
      KOE_REGISTER_IP_DAY: "2",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_OUTPUT_DIR: path.join(TMP, "output"),
      KOE_JOBS_FILE: JOBS_FILE,
      KOE_SWEEP_INTERVAL_SEC: "15",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  child.on("exit", (code) => { logs += `\n[server exited ${code}]`; });
  await waitFor(`${base}/health`);
});

test.after(() => {
  if (child && !child.killed) child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("health is public and advertises the free-tier policy", async () => {
  const { status, data } = await json("GET", "/health");
  assert.equal(status, 200);
  assert.equal(data.status, "ok");
  assert.equal(data.keyRequired, true);
  assert.equal(data.freeKeys, true);
  assert.equal(data.authRequired, true);
  assert.equal(data.ephemeral.audioTtlSeconds, 900);
  assert.equal(data.limits.key.wordsPerHour, 2000);
});

test("public policy endpoints do not require a key", async () => {
  const limits = await json("GET", "/api/limits");
  assert.equal(limits.status, 200);
  assert.ok(limits.data.key);
  assert.ok(limits.data.anon);

  // A stale/invalid key must not break public endpoints.
  const stickyHealth = await json("GET", "/health", { key: "koe_sk_deadbeefdeadbeef_aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(stickyHealth.status, 200);

  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /Koe/);
});

test("free keys can be minted and are capped per IP per day", async () => {
  const first = await json("POST", "/api/register", { body: {} });
  assert.equal(first.status, 200);
  assert.match(first.data.key, /^koe_sk_/);
  assert.ok(first.data.tenant);

  const second = await json("POST", "/api/register", { body: {} });
  assert.equal(second.status, 200);
  assert.notEqual(second.data.key, first.data.key);

  keys = [first.data.key, second.data.key];
  tenants = [first.data.tenant, second.data.tenant];

  const third = await json("POST", "/api/register", { body: {} });
  assert.equal(third.status, 429);
  assert.ok(third.data.retryAfterSeconds > 0);
});

test("protected routes reject missing and invalid keys", async () => {
  const noKey = await json("POST", "/tts", { body: { text: "hello" } });
  assert.equal(noKey.status, 401);

  const noKeyUsage = await json("GET", "/usage");
  assert.equal(noKeyUsage.status, 401);

  const badKey = await json("GET", "/usage", { key: "koe_sk_deadbeefdeadbeef_aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(badKey.status, 401);
});

test("each tenant key sees its own usage", async () => {
  const a = await json("GET", "/usage", { key: keys[0] });
  assert.equal(a.status, 200);
  assert.equal(a.data.subject, "key");
  assert.ok(a.data.usage.hour.wordsLimit > 0);

  const b = await json("GET", "/usage", { key: keys[1] });
  assert.equal(b.status, 200);
  assert.equal(b.data.subject, "key");

  const admin = await json("GET", "/usage", { key: ADMIN_KEY });
  assert.equal(admin.status, 200);
  assert.equal(admin.data.subject, "admin");
  assert.equal(admin.data.unlimited, true);
});

test("jobs are isolated between tenants", async () => {
  const now = new Date().toISOString();
  const seed = [
    {
      id: "1700000000000-aaaaa", status: "done", voice: "en-US-GuyNeural", engine: "edge",
      rate: 1, pitch: 0, parts: 1, wordCount: 3, words: 3, tenant: `key:${tenants[0]}`,
      createdAt: now, completedAt: now, audioExpiresAt: null, audioDeletedAt: now,
      file: null, error: null, progress: 100,
    },
    {
      id: "1700000000001-bbbbb", status: "done", voice: "en-US-GuyNeural", engine: "edge",
      rate: 1, pitch: 0, parts: 1, wordCount: 3, words: 3, tenant: `key:${tenants[1]}`,
      createdAt: now, completedAt: now, audioExpiresAt: null, audioDeletedAt: now,
      file: null, error: null, progress: 100,
    },
  ];
  fs.writeFileSync(JOBS_FILE, JSON.stringify(seed, null, 2));

  const a = await json("GET", "/jobs", { key: keys[0] });
  assert.equal(a.status, 200);
  assert.deepEqual(a.data.map((j) => j.id), [seed[0].id]);
  assert.equal(a.data[0].tenant, undefined, "tenant id must not leak in responses");

  const b = await json("GET", "/jobs", { key: keys[1] });
  assert.deepEqual(b.data.map((j) => j.id), [seed[1].id]);

  const admin = await json("GET", "/jobs", { key: ADMIN_KEY });
  assert.equal(admin.data.length, 2);

  const own = await json("GET", `/job/${seed[0].id}`, { key: keys[0] });
  assert.equal(own.status, 200);
  const foreign = await json("GET", `/job/${seed[0].id}`, { key: keys[1] });
  assert.equal(foreign.status, 403);
  const foreignDownload = await json("GET", `/download/${seed[0].id}`, { key: keys[1] });
  assert.equal(foreignDownload.status, 403);
  const ownDownload = await json("GET", `/download/${seed[0].id}`, { key: keys[0] });
  assert.equal(ownDownload.status, 410, "audio is ephemeral / already gone");
});

test("request validation happens after auth", async () => {
  const empty = await json("POST", "/tts", { key: keys[0], body: { text: "" } });
  assert.equal(empty.status, 400);

  const badEngine = await json("POST", "/tts", { key: keys[0], body: { text: "hello", engine: "nope" } });
  assert.equal(badEngine.status, 400);

  const badVoice = await json("POST", "/tts", { key: keys[0], body: { text: "hello", voice: "bad voice; rm -rf /" } });
  assert.equal(badVoice.status, 400);

  const badRate = await json("POST", "/tts", { key: keys[0], body: { text: "hello", rate: 9 } });
  assert.equal(badRate.status, 400);

  const missing = await json("GET", "/job/does-not-exist", { key: keys[0] });
  assert.equal(missing.status, 404);
});
