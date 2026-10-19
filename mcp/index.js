#!/usr/bin/env node
"use strict";

// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — MCP server (stdio)
//
//  Talks to a running TTS Studio instance (local `node server.js`
//  or the Render deployment) and saves generated voiceover audio
//  to a local folder so agents can drop it straight into a video.
//
//  Env:
//    TTS_STUDIO_URL   base URL of the studio  (default http://localhost:3000)
//    TTS_API_KEY      API key, if the studio requires one
//    VOICEOVER_DIR    output folder           (default ./voiceovers)
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const AdmZip = require("adm-zip");

const BASE_URL = (process.env.TTS_STUDIO_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_KEY = process.env.TTS_API_KEY || "";
const OUT_DIR = process.env.VOICEOVER_DIR || path.join(process.cwd(), "voiceovers");

// Render free instances cold-start in ~60s, so requests get a generous timeout.
const REQUEST_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Voices curated in the studio UI (index.html)
const EDGE_VOICES = [
  { id: "en-US-GuyNeural",       name: "Guy",       lang: "en-US", gender: "Male",   style: "News" },
  { id: "en-US-JennyNeural",     name: "Jenny",     lang: "en-US", gender: "Female", style: "Friendly" },
  { id: "en-US-AriaNeural",      name: "Aria",      lang: "en-US", gender: "Female", style: "Natural" },
  { id: "en-US-DavisNeural",     name: "Davis",     lang: "en-US", gender: "Male",   style: "Chat" },
  { id: "en-US-AndrewNeural",    name: "Andrew",    lang: "en-US", gender: "Male",   style: "Warm" },
  { id: "en-US-EmmaNeural",      name: "Emma",      lang: "en-US", gender: "Female", style: "Conversational" },
  { id: "en-GB-RyanNeural",      name: "Ryan",      lang: "en-GB", gender: "Male",   style: "Chat" },
  { id: "en-GB-SoniaNeural",     name: "Sonia",     lang: "en-GB", gender: "Female", style: "Formal" },
  { id: "en-GB-LibbyNeural",     name: "Libby",     lang: "en-GB", gender: "Female", style: "Conversational" },
  { id: "en-AU-NatashaNeural",   name: "Natasha",   lang: "en-AU", gender: "Female", style: "Natural" },
  { id: "en-AU-WilliamNeural",   name: "William",   lang: "en-AU", gender: "Male",   style: "Natural" },
  { id: "en-CA-ClaraNeural",     name: "Clara",     lang: "en-CA", gender: "Female", style: "Natural" },
  { id: "en-IN-NeerjaNeural",    name: "Neerja",    lang: "en-IN", gender: "Female", style: "Friendly" },
  { id: "es-ES-ElviraNeural",    name: "Elvira",    lang: "es-ES", gender: "Female", style: "Warm" },
  { id: "es-MX-DaliaNeural",     name: "Dalia",     lang: "es-MX", gender: "Female", style: "Friendly" },
  { id: "es-US-PalomaNeural",    name: "Paloma",    lang: "es-US", gender: "Female", style: "Casual" },
  { id: "fr-FR-DeniseNeural",    name: "Denise",    lang: "fr-FR", gender: "Female", style: "Elegant" },
  { id: "fr-CA-SylvieNeural",    name: "Sylvie",    lang: "fr-CA", gender: "Female", style: "Friendly" },
  { id: "de-DE-KatjaNeural",     name: "Katja",     lang: "de-DE", gender: "Female", style: "Professional" },
  { id: "de-DE-ConradNeural",    name: "Conrad",    lang: "de-DE", gender: "Male",   style: "Professional" },
  { id: "it-IT-ElsaNeural",      name: "Elsa",      lang: "it-IT", gender: "Female", style: "Warm" },
  { id: "pt-BR-FranciscaNeural", name: "Francisca", lang: "pt-BR", gender: "Female", style: "Calm" },
  { id: "pt-PT-RaquelNeural",    name: "Raquel",    lang: "pt-PT", gender: "Female", style: "Warm" },
  { id: "zh-CN-XiaoxiaoNeural",  name: "Xiaoxiao",  lang: "zh-CN", gender: "Female", style: "Warm" },
  { id: "zh-CN-YunxiNeural",     name: "Yunxi",     lang: "zh-CN", gender: "Male",   style: "Lively" },
  { id: "ja-JP-NanamiNeural",    name: "Nanami",    lang: "ja-JP", gender: "Female", style: "Polite" },
  { id: "ko-KR-SunHiNeural",     name: "Sun-Hi",    lang: "ko-KR", gender: "Female", style: "Bright" },
  { id: "ar-SA-ZariyahNeural",   name: "Zariyah",   lang: "ar-SA", gender: "Female", style: "Natural" },
  { id: "hi-IN-SwaraNeural",     name: "Swara",     lang: "hi-IN", gender: "Female", style: "Friendly" },
];

const PIPER_VOICES = [
  { id: "en_US-lessac-medium", name: "Lessac", lang: "en-US", gender: "Male", style: "Natural" },
];

// ── HTTP helpers ─────────────────────────────────────────────

async function api(method, pathname, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: body ? { "Content-Type": "application/json", ...(API_KEY ? { "x-api-key": API_KEY } : {}) }
                    : (API_KEY ? { "x-api-key": API_KEY } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err.cause && err.cause.code ? err.cause.code : err.message;
    throw new Error(
      `Could not reach the TTS Studio at ${BASE_URL} (${cause}). ` +
      (BASE_URL.includes("onrender.com")
        ? "The Render free instance may be asleep or deleted — check the service URL."
        : "Is the studio running? Set TTS_STUDIO_URL if it lives elsewhere.")
    );
  }
  if (res.status === 401) {
    throw new Error("TTS Studio rejected the API key (401). Set TTS_API_KEY in your MCP config to the key from the Render dashboard.");
  }
  return res;
}

async function apiJson(method, pathname, body) {
  const res = await api(method, pathname, body);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    throw new Error(data.error ? `${res.status} — ${data.error}` : `${res.status} — ${pathname} failed`);
  }
  return data;
}

// ── Audio merging ────────────────────────────────────────────

function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") fmt = { size, raw: buf.subarray(body, body + size) };
    if (id === "data") data = { size: Math.min(size, buf.length - body), start: body };
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  return { fmt, pcm: buf.subarray(data.start, data.start + data.size) };
}

function concatWav(buffers) {
  const parsed = buffers.map(parseWav);
  const first = parsed[0];
  if (first.fmt.size !== 16) throw new Error("unexpected fmt chunk size");
  for (const p of parsed.slice(1)) {
    if (p.fmt.size !== first.fmt.size || !p.fmt.raw.equals(first.fmt.raw)) {
      throw new Error("WAV parts have different formats");
    }
  }
  const pcm = Buffer.concat(parsed.map((p) => p.pcm));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  first.fmt.raw.copy(header, 12);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "").slice(0, 120) || "voiceover";
}

// ── MCP server ───────────────────────────────────────────────

const server = new McpServer({ name: "koe-tts-studio", version: "1.0.0" });

server.tool(
  "studio_status",
  `Check that the Koe TTS Studio is reachable and which engines it has. Call this first if a generate call fails; on the Render free plan the first request may take ~60s while the instance wakes up.`,
  {},
  async () => {
    try {
      const health = await apiJson("GET", "/health");
      return { content: [{ type: "text", text: JSON.stringify({ ...health, studioUrl: BASE_URL }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_voices",
  "List the available voices of the Koe TTS Studio. 'edge' voices are Microsoft neural voices (cloud, many languages); 'piper' voices run offline on the studio host.",
  {
    engine: z.enum(["edge", "piper"]).default("edge").describe("Which engine's voices to list"),
    lang: z.string().optional().describe("Optional language prefix filter, e.g. 'en', 'en-GB', 'fr'"),
  },
  async ({ engine, lang }) => {
    let voices = engine === "piper" ? PIPER_VOICES : EDGE_VOICES;
    if (lang) voices = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
    if (!voices.length) {
      return { content: [{ type: "text", text: `No ${engine} voices match '${lang}'. Use list_voices without a filter to see all.` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(voices, null, 2) }] };
  }
);

server.tool(
  "generate_voiceover",
  `Generate a voiceover with the Koe TTS Studio and save the audio file(s) locally (default folder: ./voiceovers). Submits a TTS job, polls until done, downloads the audio, and merges multi-part jobs into a single file when possible. Long scripts are split by the studio into parts; the merged result is returned as one path. Call list_voices first to pick a voice id.`,
  {
    text: z.string().min(1).describe("The script to narrate. Paragraph breaks are allowed; very long scripts are split into parts automatically."),
    voice: z.string().default("en-US-GuyNeural").describe("Voice id from list_voices, e.g. 'en-US-AndrewNeural'"),
    engine: z.enum(["edge", "piper"]).default("edge").describe("'edge' = Microsoft neural voices (cloud, supports rate/pitch), 'piper' = offline"),
    rate: z.number().min(0.5).max(2).default(1).describe("Speaking speed multiplier (1 = normal)"),
    pitch: z.number().int().min(-100).max(100).default(0).describe("Pitch shift in Hz (0 = normal)"),
    file_name: z.string().optional().describe("Output file name without folder, e.g. 'intro-narration.mp3'. Defaults to voiceover-<jobId>"),
    timeout_seconds: z.number().int().min(30).max(900).default(300).describe("How long to wait for the job before giving up"),
    cleanup: z.boolean().default(true).describe("Delete the job and its zip from the studio server after downloading"),
  },
  async (args) => {
    try {
      const started = await apiJson("POST", "/tts", {
        text: args.text,
        voice: args.voice,
        engine: args.engine,
        rate: args.rate,
        pitch: args.pitch,
      });
      const jobId = started.jobId;

      const deadline = Date.now() + args.timeout_seconds * 1000;
      let job;
      for (;;) {
        await sleep(POLL_INTERVAL_MS);
        job = await apiJson("GET", `/job/${jobId}`);
        if (job.status === "done" || job.status === "failed") break;
        if (Date.now() > deadline) {
          throw new Error(`Timed out after ${args.timeout_seconds}s waiting for job ${jobId} (last status: ${job.status})`);
        }
      }
      if (job.status === "failed") throw new Error(`TTS job failed on the studio server: ${job.error}`);

      const dl = await api("GET", `/download/${jobId}`);
      if (!dl.ok) throw new Error(`${dl.status} — could not download job ${jobId} (file may have been cleaned up on a server restart)`);
      const zip = new AdmZip(Buffer.from(await dl.arrayBuffer()));
      const entries = zip.getEntries().filter((e) => !e.isDirectory).sort((a, b) => a.entryName.localeCompare(b.entryName));
      if (!entries.length) throw new Error(`Job ${jobId} zip contained no audio parts`);

      const buffers = entries.map((e) => e.getData());
      const ext = (job.engine || args.engine) === "piper" ? "wav" : "mp3";

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const stem = safeFileName((args.file_name || `voiceover-${jobId}`).replace(/\.(mp3|wav)$/i, ""));
      const outPath = path.join(OUT_DIR, `${stem}.${ext}`);

      let savedPaths;
      if (buffers.length === 1) {
        fs.writeFileSync(outPath, buffers[0]);
        savedPaths = [outPath];
      } else {
        try {
          const merged = ext === "wav" ? concatWav(buffers) : Buffer.concat(buffers);
          fs.writeFileSync(outPath, merged);
          savedPaths = [outPath];
        } catch (e) {
          savedPaths = buffers.map((b, i) => {
            const p = path.join(OUT_DIR, `${stem}.part${String(i + 1).padStart(2, "0")}.${ext}`);
            fs.writeFileSync(p, b);
            return p;
          });
        }
      }

      if (args.cleanup) {
        await api("DELETE", `/job/${jobId}`).catch(() => {});
      }

      const result = {
        files: savedPaths,
        merged: savedPaths.length === 1 && buffers.length > 1 ? true : buffers.length === 1,
        format: ext,
        jobId,
        voice: job.voice,
        engine: job.engine,
        parts: job.parts,
        wordCount: job.wordCount,
        note: savedPaths.length > 1
          ? "Parts could not be merged automatically; all parts are listed."
          : undefined,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_voiceover_status",
  "Check the status of a TTS Studio job by id (useful when generate_voiceover timed out, or to re-check a job started elsewhere).",
  {
    job_id: z.string().describe("Job id returned by generate_voiceover"),
  },
  async ({ job_id }) => {
    try {
      const job = await apiJson("GET", `/job/${encodeURIComponent(job_id)}`);
      return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_recent_voiceovers",
  "List the most recent jobs on the TTS Studio server (newest first), without cleanup applied.",
  {},
  async () => {
    try {
      const jobs = await apiJson("GET", "/jobs");
      const summary = jobs.slice(0, 10).map((j) => ({
        id: j.id, status: j.status, voice: j.voice, engine: j.engine,
        wordCount: j.wordCount, createdAt: j.createdAt, error: j.error,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── boot ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`koe-tts-mcp → ${BASE_URL}${API_KEY ? " (API key set)" : ""}, output dir: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("koe-tts-mcp failed to start:", err);
  process.exit(1);
});
