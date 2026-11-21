"use strict";

// Exercises the hosted MCP endpoint at POST /mcp with the real MCP client SDK,
// plus the signed, key-less audio link the hosted tools hand back.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startStudio, mintKey: mintViaHttp } = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-mcp-test-"));
const OUTPUT = path.join(TMP, "output");
const JOBS_FILE = path.join(OUTPUT, "jobs.json");
const DB_PATH = path.join(TMP, "koe.db");
const { seedJob } = require("./dbseed");
const AUDIO_DIR = path.join(OUTPUT, "audio");
const SECRET = "mcp-test-secret";

// Required by guard.js at require time, so the test can sign a download link
// exactly like the server does.
process.env.KOE_SECRET = SECRET;
process.env.KOE_STATE_FILE = path.join(TMP, "guard-state.json");
process.env.KOE_DB_PATH = path.join(TMP, "koe.db");

let studio;
let base;
let key = "";
let tenant = "";

// JPEG SOF markers carry the real pixel dimensions; assert them so a social
// card tag cannot drift from the file it points at.
function jpegDims(bytes) {
  for (let i = 2; i < bytes.length - 9; ) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

test.before(async () => {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  studio = await startStudio({
    readyPath: "/health",
    env: {
      KOE_SECRET: SECRET,
      KOE_REQUIRE_KEY: "true",
      KOE_STATE_FILE: path.join(TMP, "state.json"),
      KOE_DB_PATH: DB_PATH,
      KOE_OUTPUT_DIR: OUTPUT,
      KOE_JOBS_FILE: JOBS_FILE,
      KOE_SWEEP_INTERVAL_SEC: "15",
    },
  });
  base = studio.base;

  const minted = await mintViaHttp(base);
  assert.equal(minted.status, 201);
  key = minted.data.key;
  tenant = minted.data.tenant;
});

test.after(async () => {
  if (studio) await studio.stop();
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

test("GET / serves the landing page", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Koe/);
  assert.match(html, /<h1[^>]*id="hero-title"/);
  assert.match(html, /a voice\./);
  // the portrait floats free: it must carry alt text and must not be boxed
  // into a framed plate again
  assert.match(html, /<img[^>]+src="\/oiran\.png\?v=\d+"[^>]+alt="[^"]*oiran/);
  const figure = html.slice(
    html.indexOf('class="print"'),
    html.indexOf("</figure>", html.indexOf('class="print"')),
  );
  assert.doesNotMatch(figure, /<svg|<rect/, "the hero portrait must not be framed");
  // and it links onward to the setup page rather than replacing it
  assert.match(html, /href="\/mcp"/);
  assert.match(html, /koe\.kennedyazeru\.space\/mcp/);
});

test("GET /docs serves the agent reference without a key", async () => {
  const res = await fetch(`${base}/docs`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Koe docs/);
  assert.match(html, /generate_voiceover/, "the tool list must be on the page");
  assert.match(html, /href="\/mcp"/, "docs must link back to setup");
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
  // /oiran.png is the landing hero: an <img> that must load before the visitor
  // has a key, or the figure renders as an empty box.
  for (const route of ["/logo-mark.png", "/favicon-32.png", "/apple-touch-icon.png", "/oiran.png"]) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") || "", /image\/png/, route);
  }
});

test("the homepage advertises a 1200x630 social card that is actually served", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<meta property="og:image" content="https:\/\/koe\.kennedyazeru\.space\/og-cover\.jpg">/);
  assert.match(html, /og:image:width" content="1200"/);
  assert.match(html, /og:image:height" content="630"/);
  assert.match(html, /og:image:alt" content="[^"]+"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:image" content="https:\/\/koe\.kennedyazeru\.space\/og-cover\.jpg">/);

  // An unreachable card is the whole bug: the crawler needs a 200 with a real
  // image content type, at a URL that needs no key.
  const res = await fetch(`${base}/og-cover.jpg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/jpeg/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 30_000, "the card must be a real photo, not a 1px placeholder");
  // JPEG SOF marker carries the real pixel dimensions; assert them so the tag
  // cannot drift from the file.
  assert.deepEqual(jpegDims(bytes), { width: 1200, height: 630 });
});

test("every public page advertises a 1200x630 card that is actually served", async () => {
  const pages = [
    ["/docs", "og-docs.jpg"],
    ["/mcp", "og-mcp.jpg"],
    ["/studio", "og-studio.jpg"],
  ];
  for (const [page, card] of pages) {
    const html = await (await fetch(`${base}${page}`, { headers: { Accept: "text/html" } })).text();
    assert.match(
      html,
      new RegExp(`<meta property="og:image" content="https:\\/\\/koe\\.kennedyazeru\\.space\\/${card.replace(".", "\\.")}">`),
      page
    );
    assert.match(html, /og:image:type" content="image\/jpeg"/, page);
    assert.match(html, /og:image:width" content="1200"/, page);
    assert.match(html, /og:image:height" content="630"/, page);
    assert.match(html, /og:image:alt" content="[^"]+"/, page);
    assert.match(html, /name="twitter:card" content="summary_large_image"/, page);
    assert.match(
      html,
      new RegExp(`name="twitter:image" content="https:\\/\\/koe\\.kennedyazeru\\.space\\/${card.replace(".", "\\.")}"`),
      page
    );

    // Keyless and a real JPEG: a crawler cannot mint a key, and a placeholder
    // would still be a broken preview.
    const res = await fetch(`${base}/${card}`);
    assert.equal(res.status, 200, card);
    assert.match(res.headers.get("content-type") || "", /image\/jpeg/, card);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 30_000, `${card} must be a real photo, not a 1px placeholder`);
    assert.deepEqual(jpegDims(bytes), { width: 1200, height: 630 }, card);
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

    // The hosted endpoint must be able to request every engine its own
    // list_voices advertises — kitten was listable but not selectable.
    const gen = tools.tools.find((t) => t.name === "generate_voiceover");
    assert.deepEqual(
      [...gen.inputSchema.properties.engine.enum].sort(),
      ["edge", "kitten", "kokoro", "piper"],
    );

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
  // The job store is SQLite: insert the fixture the server will serve.
  seedJob(DB_PATH, job);

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
