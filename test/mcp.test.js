"use strict";

// Exercises the hosted MCP endpoint at POST /mcp with the real MCP client SDK,
// plus the signed, key-less audio link the hosted tools hand back.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-mcp-test-"));
const OUTPUT = path.join(TMP, "output");
const JOBS_FILE = path.join(OUTPUT, "jobs.json");
const AUDIO_DIR = path.join(OUTPUT, "audio");
const SECRET = "mcp-test-secret";

// Required by guard.js at require time, so the test can sign a download link
// exactly like the server does.
process.env.KOE_SECRET = SECRET;
process.env.KOE_STATE_FILE = path.join(TMP, "guard-state.json");

let child;
let base;
let logs = "";
let key = "";
let tenant = "";

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

test.before(async () => {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TTS_BACKEND: "native",
      KOE_SECRET: SECRET,
      KOE_REQUIRE_KEY: "true",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_OUTPUT_DIR: OUTPUT,
      KOE_JOBS_FILE: JOBS_FILE,
      KOE_SWEEP_INTERVAL_SEC: "15",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  child.on("exit", (code) => { logs += `\n[server exited ${code}]`; });
  await waitFor(`${base}/health`);

  const res = await fetch(`${base}/api/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  assert.equal(res.status, 200);
  key = data.key;
  tenant = data.tenant;
});

test.after(() => {
  if (child && !child.killed) child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function mcpClient() {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "koe-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

test("GET /mcp serves the public setup page to browsers", async () => {
  const res = await fetch(`${base}/mcp`, { headers: { Accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Koe MCP/);
  assert.match(html, /mcp-sample-andrew\.mp3/);
  assert.match(html, /<audio id="sample-audio"/);
  assert.match(html, /logo-mark\.png/);
  assert.match(html, /favicon-32\.png/);
});

test("GET / redirects to the MCP landing page", async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/mcp");
});

test("GET /studio serves the studio page", async () => {
  const res = await fetch(`${base}/studio`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Koe Studio/);
  assert.match(html, /id="scriptText"/);
  assert.match(html, /logo-mark\.png/);
});

test("brand assets are served publicly", async () => {
  for (const route of ["/logo-mark.png", "/favicon-32.png", "/apple-touch-icon.png"]) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") || "", /image\/png/, route);
  }
});

test("GET /mcp without HTML Accept returns a text hint, not a 405", async () => {
  const res = await fetch(`${base}/mcp`, { headers: { Accept: "application/json" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  assert.match(await res.text(), /MCP clients use POST/);
});

test("GET /mcp-sample-andrew.mp3 serves the public voice sample", async () => {
  const res = await fetch(`${base}/mcp-sample-andrew.mp3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /audio\/mpeg/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 1000, `expected an mp3 body, got ${bytes.length} bytes`);
});

test("unknown /mcp-sample-*.mp3 names are rejected", async () => {
  const res = await fetch(`${base}/mcp-sample-nope.mp3`);
  assert.equal(res.status, 404);
});

test("POST /mcp requires a free key", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(res.status, 401);
});

test("hosted MCP lists the expected tools and answers calls", async () => {
  const { client, transport } = await mcpClient();
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "generate_voiceover", "get_usage", "get_voiceover_status",
      "list_recent_voiceovers", "list_voices", "studio_status",
    ]);

    const voices = await client.callTool({ name: "list_voices", arguments: { engine: "edge", lang: "en-GB" } });
    const parsed = JSON.parse(voices.content[0].text);
    assert.ok(parsed.length >= 3);
    assert.ok(parsed.every((v) => v.lang.startsWith("en-GB")));

    const usage = await client.callTool({ name: "get_usage", arguments: {} });
    const usageData = JSON.parse(usage.content[0].text);
    assert.equal(usageData.keyMode, "key");
    assert.equal(usageData.subject, "key");
    assert.ok(usageData.usage.hour.wordsLimit > 0);

    const status = await client.callTool({ name: "studio_status", arguments: {} });
    const health = JSON.parse(status.content[0].text);
    assert.equal(health.status, "ok");
    assert.equal(health.transport, "streamable-http");
    assert.equal(health.client.keyMode, "key");
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}, { timeout: 30000 });

test("signed audio links work without a key, and expire with the job", async () => {
  const guard = require("../guard");

  const id = "1700000000999-mcpt1";
  const audio = Buffer.from("ID3-kohaku-test-audio");
  const zip = new AdmZip();
  zip.addFile("part_001.mp3", audio);
  fs.writeFileSync(path.join(AUDIO_DIR, `${id}.zip`), zip.toBuffer());

  const now = new Date().toISOString();
  const job = {
    id, status: "done", voice: "en-US-GuyNeural", engine: "edge", rate: 1, pitch: 0,
    parts: 1, wordCount: 4, words: 4, textChars: 20, tenant: `key:${tenant}`,
    createdAt: now, completedAt: now,
    audioExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    audioDeletedAt: null, file: `${id}.zip`, error: null, progress: 100,
  };
  const jobs = fs.existsSync(JOBS_FILE) ? JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")) : [];
  fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.filter((j) => j.id !== id), job], null, 2));

  const token = guard.signDownload(id);
  const ok = await fetch(`${base}/audio/${id}?dl=${token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), audio);

  const bad = await fetch(`${base}/audio/${id}?dl=not-a-real-token`);
  assert.equal(bad.status, 401, "invalid token with no key is rejected");

  const owner = await fetch(`${base}/audio/${id}`, { headers: { "x-api-key": key } });
  assert.equal(owner.status, 200, "the owning key can also fetch audio");

  // Ephemeral: once the file is gone, the route reports 410.
  fs.rmSync(path.join(AUDIO_DIR, `${id}.zip`));
  const gone = await fetch(`${base}/audio/${id}?dl=${token}`);
  assert.equal(gone.status, 410);
});
