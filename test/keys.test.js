"use strict";

// ─────────────────────────────────────────────────────────────
//  Acceptance suite for the hardened key/auth layer.
//
//  Every scenario boots its own server process against its own temp
//  KOE_DB_PATH, so nothing here touches the repository's koe.db:
//
//    • forged / pre-v3 key            → 401 invalid_key
//    • over the hourly word limit     → 429, and nothing is counted
//    • over the global daily ceiling  → 429, and nothing is counted
//    • single job over the word cap   → 400 before counting
//    • failed generation              → words refunded, request kept
//    • 4th mint from one IP per day   → 429
//    • KOE_KILL_SWITCH                → 503 on every generation entry point
//    • restart with the same DB       → keys and counters survive
//    • logs never contain a full key
//
//  Generation is made to fail deterministically by forcing TTS_BACKEND=docker
//  while removing docker from the child's PATH: the guard runs, the charge
//  happens, the synthesis fails fast, the refund path is exercised end to end.
// ─────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-keys-test-"));
const ADMIN_KEY = "keys-test-admin";
const SYSTEM32 = path.join(process.env.WINDIR || "C:\\Windows", "System32");

const { json, mintKey } = require("./helpers");

const children = [];

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

async function waitFor(base, logs, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become healthy.\n${logs()}`);
}

// Boots server.js with an isolated KOE_DB_PATH. `name` doubles as the DB
// directory, so restarting a server with the same name reopens the same file.
async function startServer(name, env = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "koe.db");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const childEnv = {
    ...process.env,
    PORT: String(port),
    TTS_BACKEND: "docker",
    KOE_SECRET: "keys-test-secret",
    API_KEY: ADMIN_KEY,
    KOE_REQUIRE_KEY: "false",
    KOE_STATE_FILE: path.join(dir, "state.json"),
    KOE_DB_PATH: dbPath,
    KOE_OUTPUT_DIR: path.join(dir, "output"),
    KOE_JOBS_FILE: path.join(dir, "jobs.json"),
    KOE_STATS_FILE: path.join(dir, "stats.json"),
    KOE_SWEEP_INTERVAL_SEC: "60",
    ...env,
  };
  // Strip docker (and everything else) from PATH so synthesis fails fast and
  // identically on every machine instead of reaching a real container runtime.
  for (const k of Object.keys(childEnv)) {
    if (k.toLowerCase() === "path") delete childEnv[k];
  }
  childEnv.PATH = SYSTEM32;

  let logs = "";
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  children.push(child);

  await waitFor(base, () => logs);
  return { base, dbPath, child, logs: () => logs };
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    child.kill();
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3000);
    if (t.unref) t.unref();
  });
}

test.after(async () => {
  for (const child of children) await stop(child);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── health / database reachability ───────────────────────────

test("GET /healthz answers 200 with a reachable database, /health stays as an alias", async () => {
  const s = await startServer("health");

  const primary = await json(s.base, "/healthz");
  assert.equal(primary.status, 200);
  assert.equal(primary.data.status, "ok");
  assert.equal(primary.data.db.ok, true, "health must reflect DB reachability");
  assert.ok(primary.data.db.path.endsWith("koe.db"));
  assert.equal(primary.data.killSwitch, false);

  const alias = await json(s.base, "/health");
  assert.equal(alias.status, 200);
  assert.equal(alias.data.db.ok, true);
});

// ── authentication ───────────────────────────────────────────

test("forged and pre-v3 keys are rejected with 401 invalid_key", async () => {
  const s = await startServer("forged");

  // Well-formed v3 key that was never issued.
  const forged = `koe_sk_${"ab".repeat(16)}`;
  const stale = await json(s.base, "/usage", { key: forged });
  assert.equal(stale.status, 401);
  assert.equal(stale.data.error, "invalid_key");
  assert.match(stale.data.hint, /POST \/keys/);

  // Pre-v3 HMAC key: not a record, so it is not a key any more.
  const legacy = await json(s.base, "/usage", { key: "koe_sk_deadbeefdeadbeef_aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(legacy.status, 401);
  assert.equal(legacy.data.error, "invalid_key");

  // POST /mcp never falls back to anonymous traffic.
  const mcpBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const withForged = await json(s.base, "/mcp", { method: "POST", key: forged, body: mcpBody });
  assert.equal(withForged.status, 401);
  assert.equal(withForged.data.error, "invalid_key");

  const withoutKey = await json(s.base, "/mcp", { method: "POST", body: mcpBody });
  assert.equal(withoutKey.status, 401);
  assert.equal(withoutKey.data.error, "invalid_key");

  // ...and a genuinely minted key is accepted.
  const minted = await mintKey(s.base);
  assert.equal(minted.status, 201);
  const ok = await json(s.base, "/usage", { key: minted.data.key });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.subject, "key");
  assert.equal(ok.data.usage.hour.words, 0);
});

// ── limits ───────────────────────────────────────────────────

test("a key over the hourly word limit gets 429 and nothing is counted", async () => {
  const s = await startServer("hourly", { KOE_HOURLY_WORDS: "10" });
  const key = (await mintKey(s.base)).data.key;

  const text = Array(20).fill("word").join(" "); // 20 > 10
  const over = await json(s.base, "/tts", { method: "POST", key, body: { text } });
  assert.equal(over.status, 429);
  assert.equal(over.data.reason, "hourly_words");
  assert.ok(over.data.retryAfterSeconds > 0, "429 carries a reset window");

  const usage = await json(s.base, "/usage", { key });
  assert.equal(usage.status, 200);
  assert.equal(usage.data.usage.hour.words, 0, "a rejected request must not count");
  assert.equal(usage.data.usage.hour.requests, 0);
  assert.equal(usage.data.usage.day.words, 0);
});

test("the global daily ceiling rejects with 429 before counting", async () => {
  const s = await startServer("global", { KOE_GLOBAL_DAILY_WORDS: "5", KOE_HOURLY_WORDS: "5000" });
  const key = (await mintKey(s.base)).data.key;

  const text = Array(20).fill("word").join(" ");
  const over = await json(s.base, "/tts", { method: "POST", key, body: { text } });
  assert.equal(over.status, 429);
  assert.equal(over.data.reason, "global_daily_words");

  const usage = await json(s.base, "/usage", { key });
  assert.equal(usage.data.usage.hour.words, 0);
  assert.equal(usage.data.usage.hour.requests, 0);
});

test("a single job over the word cap is a 400 before counting", async () => {
  const s = await startServer("jobcap");
  const key = (await mintKey(s.base)).data.key;

  const text = Array(6001).fill("word").join(" ");
  const big = await json(s.base, "/tts", { method: "POST", key, body: { text } });
  assert.equal(big.status, 400);
  assert.match(big.data.error, /Job too long/);
  assert.equal(big.data.maxWords, 6000);

  const usage = await json(s.base, "/usage", { key });
  assert.equal(usage.data.usage.hour.words, 0, "the rejected job was never charged");
});

test("a failed generation refunds its words but keeps the request", async () => {
  const s = await startServer("refund");
  const key = (await mintKey(s.base)).data.key;

  // Charged on submission, then synthesis fails (docker is not on PATH),
  // so the guard must give the words back.
  const failed = await json(s.base, "/tts-preview", {
    method: "POST",
    key,
    body: { text: "one two three four five" },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error, "Preview generation failed");

  const usage = await json(s.base, "/usage", { key });
  assert.equal(usage.data.usage.hour.words, 0, "words refunded");
  assert.equal(usage.data.usage.day.words, 0, "day words refunded");
  assert.equal(usage.data.usage.hour.requests, 1, "the request still counts");
  assert.equal(usage.data.usage.day.requests, 1);
});

// ── key issuance ─────────────────────────────────────────────

test("the 4th mint from one IP on the same UTC day is a 429", async () => {
  const s = await startServer("mintcap", { KOE_REGISTER_IP_DAY: "3" });

  for (let i = 1; i <= 3; i++) {
    const minted = await mintKey(s.base);
    assert.equal(minted.status, 201, `mint #${i} must succeed`);
    assert.match(minted.data.key, /^koe_sk_[0-9a-f]{32}$/);
  }

  const fourth = await mintKey(s.base);
  assert.equal(fourth.status, 429);
  assert.ok(fourth.data.retryAfterSeconds > 0);
  assert.match(fourth.data.error, /Registration limit reached/);
});

// ── kill switch ──────────────────────────────────────────────

test("KOE_KILL_SWITCH answers 503 on every generation entry point", async () => {
  const s = await startServer("kill", { KOE_KILL_SWITCH: "true" });
  const key = (await mintKey(s.base)).data.key;

  const tts = await json(s.base, "/tts", { method: "POST", key, body: { text: "hello world" } });
  assert.equal(tts.status, 503);
  assert.equal(tts.data.error, "temporarily_disabled");

  const preview = await json(s.base, "/tts-preview", { method: "POST", key, body: { text: "hello" } });
  assert.equal(preview.status, 503);
  assert.equal(preview.data.error, "temporarily_disabled");

  const piper = await json(s.base, "/tts-preview-piper", { method: "POST", key, body: { text: "hello" } });
  assert.equal(piper.status, 503);

  const mcp = await json(s.base, "/mcp", {
    method: "POST",
    key,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(mcp.status, 503);
  assert.equal(mcp.data.error, "temporarily_disabled");

  // Non-generation surfaces keep working, and health advertises the switch.
  const usage = await json(s.base, "/usage", { key });
  assert.equal(usage.status, 200);
  const health = await json(s.base, "/healthz");
  assert.equal(health.data.killSwitch, true);
});

// ── persistence ──────────────────────────────────────────────

test("killing and restarting the process preserves keys and counters", async () => {
  const s = await startServer("restart", { KOE_REGISTER_IP_DAY: "3" });

  const keys = [];
  for (let i = 0; i < 3; i++) {
    const minted = await mintKey(s.base);
    assert.equal(minted.status, 201);
    keys.push(minted.data.key);
  }

  // Charge (and refund) once so there is a counter on disk to preserve.
  const failed = await json(s.base, "/tts-preview", {
    method: "POST",
    key: keys[0],
    body: { text: "one two three four five" },
  });
  assert.equal(failed.status, 500);
  const before = await json(s.base, "/usage", { key: keys[0] });
  assert.equal(before.data.usage.hour.requests, 1);

  await stop(s.child);

  // Same name → same KOE_DB_PATH, brand new process.
  const again = await startServer("restart", { KOE_REGISTER_IP_DAY: "3" });

  const after = await json(again.base, "/usage", { key: keys[0] });
  assert.equal(after.status, 200, "the key minted before the restart still resolves");
  assert.equal(after.data.usage.day.requests, 1, "usage counters survived the restart");
  assert.equal(after.data.usage.hour.words, 0, "the refund survived too");

  // The per-IP mint cap is persisted as well: the IP already used 3 today.
  const fourth = await mintKey(again.base);
  assert.equal(fourth.status, 429, "mint cap survived the restart");

  await stop(again.child);
});

// ── log hygiene ──────────────────────────────────────────────

test("rejections are logged by reason and key prefix, never by full key", async () => {
  const s = await startServer("logs");
  const key = (await mintKey(s.base)).data.key;
  assert.match(key, /^koe_sk_[0-9a-f]{32}$/);

  const forged = `koe_sk_${"cd".repeat(16)}`;
  await json(s.base, "/usage", { key: forged });
  await json(s.base, "/tts", { method: "POST", key, body: { text: "" } });
  await new Promise((r) => setTimeout(r, 300));

  const logs = s.logs();
  assert.ok(!logs.includes(key), "a full key must never appear in the logs");
  assert.match(logs, /\[guard\] reject reason=invalid_key key=koe_sk_cdcd ip=/);
  assert.match(logs, /\[keys\] minted key=koe_sk_[0-9a-f]{4} ip=/);
  // The successful mint line carries only the prefix too.
  const prefix = key.slice(0, 11);
  const mintLine = logs.split("\n").find((l) => l.includes(`[keys] minted key=${prefix}`));
  assert.ok(mintLine, "a mint is logged with the key prefix");
  assert.ok(!mintLine.includes(key), "the mint log line stops at the prefix");
});
