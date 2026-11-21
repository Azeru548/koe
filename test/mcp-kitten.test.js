"use strict";

// Both MCP servers used to decide the output container with a piper-only
// ternary (`engine === "piper" ? "wav" : "mp3"`), so a kitten job — which is
// WAV — was saved as `.mp3`, and a multi-part one was merged as if its parts
// were MP3 frames. These tests pin the container to engines.extFor() for the
// engine that actually produced the audio.
//
//   • hosted MCP: a real MCP client over the in-memory transport, with a stub
//     studio client, so the tool call is exercised without a sidecar or HTTP.
//   • stdio MCP: the real `mcp/index.js` process against a minimal fake studio
//     that serves a kitten job, so the saved file and its extension are real.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-mcp-kitten-"));
const OUT_DIR = path.join(TMP, "voiceovers");
const JOB_ID = "1700000000123-kttn1";

// Keep the hosted tool's polling loop short; it is read when the server is built.
process.env.KOE_MCP_POLL_MS = "500";

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// A minimal but valid RIFF/WAVE file, so the assertions can look at the magic
// bytes rather than only the file name.
function wavBytes(pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0])) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(24000, 24);   // sample rate
  header.writeUInt32LE(48000, 28);   // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function kittenJob() {
  return {
    id: JOB_ID,
    status: "done",
    voice: "bella",
    engine: "kitten",
    rate: 1,
    pitch: 0,
    parts: 1,
    wordCount: 2,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    expiresInSeconds: 800,
    file: `${JOB_ID}.zip`,
    error: null,
  };
}

function kittenZip() {
  const zip = new AdmZip();
  zip.addFile("part_001.wav", wavBytes());
  return zip.toBuffer();
}

test("hosted MCP reports a kitten job as WAV, not MP3", { timeout: 30000 }, async () => {
  const { createHostedMcp } = require("../hosted-mcp");

  const client = {
    studioUrl: "https://studio.test",
    keyMode: "key",
    health: async () => ({ status: "ok" }),
    usage: async () => ({ subject: "key", usage: {} }),
    submit: async () => ({ jobId: JOB_ID, parts: 1, wordCount: 2 }),
    job: async () => kittenJob(),
    listJobs: async () => [],
    download: async () => kittenZip(),
    signAudioUrl: (id) => `https://studio.test/audio/${id}?dl=signed`,
  };

  const server = createHostedMcp({ client });
  const mcpClient = new Client({ name: "kitten-format-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "generate_voiceover",
      arguments: { text: "Two words.", engine: "kitten", voice: "bella" },
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.engine, "kitten");
    assert.equal(payload.format, "wav", "a kitten job must be reported as WAV");
    assert.match(payload.downloadUrl, /\/audio\//);

    const audio = result.content.find((c) => c.type === "audio");
    assert.ok(audio, "the short clip is inlined");
    assert.equal(audio.mimeType, "audio/wav", "inline audio must carry the WAV mime type");
    assert.equal(Buffer.from(audio.data, "base64").subarray(0, 4).toString("ascii"), "RIFF");
  } finally {
    await mcpClient.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

// ── stdio MCP against a minimal fake studio ──────────────────

function startFakeStudio() {
  const server = http.createServer((req, res) => {
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (req.method === "POST" && req.url === "/tts") {
      req.resume();
      req.on("end", () => send(200, { jobId: JOB_ID, parts: 1, wordCount: 2 }));
      return;
    }
    if (req.method === "GET" && req.url === `/job/${JOB_ID}`) return send(200, kittenJob());
    if (req.method === "GET" && req.url === `/download/${JOB_ID}`) {
      return send(200, kittenZip(), "application/zip");
    }
    if (req.method === "DELETE" && req.url === `/job/${JOB_ID}`) return send(200, { deleted: JOB_ID });
    return send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("stdio MCP saves a kitten job as a .wav file", { timeout: 60000 }, async () => {
  const { server, base } = await startFakeStudio();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "mcp", "index.js")],
    cwd: TMP,
    env: {
      ...process.env,
      TTS_STUDIO_URL: base,
      TTS_API_KEY: `koe_sk_${"a".repeat(32)}`,
      VOICEOVER_DIR: OUT_DIR,
      KOE_DISABLE_AUTO_REGISTER: "1",
    },
    stderr: "pipe", // keep the child's stderr out of TAP output
  });

  const mcpClient = new Client({ name: "kitten-stdio-test", version: "1.0.0" });

  try {
    await mcpClient.connect(transport);

    const result = await mcpClient.callTool({
      name: "generate_voiceover",
      arguments: { text: "Two words.", engine: "kitten", voice: "bella", file_name: "kitten-take" },
    });

    assert.ok(!result.isError, `tool failed: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.format, "wav", "a kitten job must be reported as WAV");
    assert.equal(payload.files.length, 1, payload.note);

    const saved = payload.files[0];
    assert.match(saved, /\.wav$/, `saved file must keep the WAV extension, got ${saved}`);
    assert.ok(fs.existsSync(saved), `${saved} was written`);
    const bytes = fs.readFileSync(saved);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", "the saved bytes are a WAV file");

    const written = fs.readdirSync(OUT_DIR);
    assert.ok(!written.some((name) => name.endsWith(".mp3")), `no MP3 was written: ${written.join(", ")}`);
  } finally {
    await mcpClient.close().catch(() => {});
    server.close();
  }
});
