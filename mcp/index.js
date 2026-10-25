#!/usr/bin/env node
"use strict";

// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — MCP server (stdio)
//
//  Talks to a running TTS Studio instance (local `node server.js`
//  or the hosted free deployment) and saves generated voiceover
//  audio to a local folder so agents can drop it straight into a
//  video.
//
//  Free multi-tenant model:
//    • TTS_API_KEY set        → use it (admin key or a key you saved)
//    • otherwise              → reuse ~/.koe/credentials.json
//    • otherwise              → GET /keys/challenge + POST /keys once
//                               (proof-of-work) and persist the free key
//                               for this studio URL
//  Keys are per-install, so every user gets their own quota.
//
//  Env:
//    TTS_STUDIO_URL            base URL of the studio (default http://localhost:3000)
//    TTS_API_KEY               optional explicit key (admin or tenant)
//    VOICEOVER_DIR             output folder (default ./voiceovers)
//    KOE_CREDENTIALS_FILE      where auto-registered keys are stored
//    KOE_DISABLE_AUTO_REGISTER set to 1 to never mint a free key
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const AdmZip = require("adm-zip");
const { EDGE_VOICES, PIPER_VOICES } = require("../voices");
const { mergeAudioParts } = require("../audio");

const BASE_URL = (process.env.TTS_STUDIO_URL || "http://localhost:3000").replace(/\/+$/, "");
const OUT_DIR = process.env.VOICEOVER_DIR || path.join(process.cwd(), "voiceovers");
const CRED_FILE = process.env.KOE_CREDENTIALS_FILE || path.join(os.homedir(), ".koe", "credentials.json");
const AUTO_REGISTER = !["0", "false", "no", "off"].includes(String(process.env.KOE_DISABLE_AUTO_REGISTER || "").toLowerCase());

// A container restart or a busy small instance can take a while to answer,
// so requests get a generous timeout.
const REQUEST_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tenant key management ───────────────────────────────────

let tenantKey = process.env.TTS_API_KEY || "";
let keySource = tenantKey ? "env" : "none";

function readCreds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCreds(creds) {
  try {
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error(`[koe] could not save the free key: ${err.message}`);
  }
}

function loadStoredKey() {
  if (tenantKey) return tenantKey;
  const rec = readCreds()[BASE_URL];
  if (rec && typeof rec.key === "string" && rec.key) {
    tenantKey = rec.key;
    keySource = "stored";
  }
  return tenantKey || null;
}

function clearStoredKey() {
  const creds = readCreds();
  if (creds[BASE_URL]) {
    delete creds[BASE_URL];
    writeCreds(creds);
  }
  tenantKey = "";
  keySource = "none";
}

// ── key issuance gate (GET /keys/challenge → POST /keys) ────
// sha256(challenge + nonce) must start with `zeros` '0' hex chars.
function solvePow(challenge, zeros) {
  const target = "0".repeat(zeros);
  for (let i = 0; i < 8_000_000; i++) {
    const nonce = i.toString(16).padStart(4, "0");
    const hash = crypto.createHash("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hash.startsWith(target)) return nonce;
  }
  throw new Error("proof-of-work did not converge");
}

async function mintFreeKey() {
  const info = await fetch(`${BASE_URL}/keys/challenge`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then((r) => r.json());
  if (info && info.mode === "turnstile") {
    const err = new Error(
      "this studio gates key issuance behind Cloudflare Turnstile, which a headless MCP client cannot solve — " +
      "open its /mcp page in a browser to mint a key, then set TTS_API_KEY to that key."
    );
    err.code = "turnstile_required";
    throw err;
  }

  const nonce = solvePow(info && info.challenge, (info && info.pow && info.pow.leadingZeroHexChars) || 4);
  const res = await fetch(`${BASE_URL}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: info.challenge, nonce }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `key mint failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function registerFreeKey() {
  if (!AUTO_REGISTER) return null;
  try {
    const data = await mintFreeKey();
    if (!data || typeof data.key !== "string" || !data.key) return null;

    tenantKey = data.key;
    keySource = "auto";
    const creds = readCreds();
    creds[BASE_URL] = {
      key: data.key,
      tenant: data.tenant || null,
      createdAt: new Date().toISOString(),
    };
    writeCreds(creds);
    const words = data.limits && data.limits.key ? data.limits.key.wordsPerHour : null;
    console.error(`[koe] registered a free tenant key${words ? ` (${words} words/hour)` : ""}; saved to ${CRED_FILE}`);
    return tenantKey;
  } catch (err) {
    if (err.code === "turnstile_required") console.error(`[koe] could not register a free key: ${err.message}`);
    else if (err.status === 429) console.error(`[koe] free-key registration limit reached for this IP; try again later or set TTS_API_KEY.`);
    else console.error(`[koe] could not register a free key: ${err.message}`);
    return null;
  }
}

async function ensureKey() {
  if (tenantKey) return tenantKey;
  if (loadStoredKey()) return tenantKey;
  return registerFreeKey();
}

// ── HTTP helpers ─────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
    const retry = Number(this.data.retryAfterSeconds);
    this.retryAfterSeconds = Number.isFinite(retry) ? retry : null;
  }
}

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}

async function fetchOnce(method, pathname, body, key) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["x-api-key"] = key;

  try {
    return await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err.cause && err.cause.code ? err.cause.code : err.message;
    throw new Error(
      `Could not reach the TTS Studio at ${BASE_URL} (${cause}). ` +
      "Is the instance running? Check the URL and the service health; set TTS_STUDIO_URL if it lives elsewhere."
    );
  }
}

async function api(method, pathname, body, opts = {}) {
  const { needKey = true } = opts;
  if (needKey) await ensureKey();

  let res = await fetchOnce(method, pathname, body, tenantKey);

  // A rotated KOE_SECRET invalidates previously minted keys. Re-register once
  // (never for an explicitly configured TTS_API_KEY).
  if (res.status === 401 && keySource !== "env") {
    clearStoredKey();
    await ensureKey();
    res = await fetchOnce(method, pathname, body, tenantKey);
  }
  return res;
}

async function apiJson(method, pathname, body, opts) {
  const res = await api(method, pathname, body, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }

  if (!res.ok) {
    if (res.status === 401) {
      const msg = keySource === "env"
        ? "The TTS Studio rejected TTS_API_KEY (401). Fix or remove TTS_API_KEY in your MCP config."
        : "The TTS Studio requires a free key and auto-registration did not succeed. Set TTS_API_KEY or check GET /keys/challenge + POST /keys.";
      throw new ApiError(401, msg, data);
    }
    const base = data.error || data.detail || `${pathname} failed`;
    const retry = Number.isFinite(Number(data.retryAfterSeconds)) && Number(data.retryAfterSeconds) > 0
      ? ` Retry in ${formatDuration(Number(data.retryAfterSeconds))}.`
      : "";
    throw new ApiError(res.status, `${res.status} — ${base}${retry}`, data);
  }
  return data;
}

// 429/503 responses usually clear within seconds (queue full, brief cool-down),
// so retry those once before surfacing the limit to the user.
async function submitTts(body) {
  await ensureKey();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiJson("POST", "/tts", body);
    } catch (err) {
      const wait = err.retryAfterSeconds;
      const transient = (err.status === 429 || err.status === 503) && wait > 0 && wait <= 45;
      if (attempt === 0 && transient) {
        console.error(`[koe] studio busy (${err.status}); retrying in ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      throw err;
    }
  }
}

// Voices come from the shared catalog (../voices.js) so the hosted MCP and the
// studio UI stay in sync.

// ── Audio merging ────────────────────────────────────────────

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "").slice(0, 120) || "voiceover";
}

// ── MCP server ───────────────────────────────────────────────

const server = new McpServer({ name: "koe-tts-studio", version: "1.3.0" });

server.tool(
  "studio_status",
  `Check that the Koe TTS Studio is reachable, which engines it has, and your free-tier usage. Call this first if a generate call fails; the first request after a restart may take longer while the container warms up.`,
  {},
  async () => {
    try {
      const health = await apiJson("GET", "/health", undefined, { needKey: false });
      // Pre-register so users see their quota immediately (best effort).
      await ensureKey();
      let usage = null;
      try { usage = await apiJson("GET", "/usage", undefined, { needKey: false }); } catch { /* usage is best effort */ }
      const payload = {
        ...health,
        studioUrl: BASE_URL,
        client: {
          keyMode: keySource,            // env | stored | auto | none
          credentialsFile: CRED_FILE,
          usage,
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_voices",    "List the available voices of the Koe TTS Studio for one engine. 'edge' = Microsoft neural voices (cloud, many languages); 'piper' = offline on the studio host; 'kokoro' = the studio's local Kokoro sidecar (offline, MP3). Voice ids are never shared between engines — always list the engine you intend to use.",
  {
    engine: z.enum(["edge", "piper", "kokoro"]).default("edge").describe("Which engine's voices to list"),
    lang: z.string().optional().describe("Optional language prefix filter, e.g. 'en', 'en-GB', 'fr'"),
  },
  async ({ engine, lang }) => {
    let voices;
    if (engine === "kokoro") {
      // Kokoro's catalog is served by the studio: it asks the sidecar and
      // falls back to a built-in list when the sidecar is down. edge/piper
      // keep using the static catalog below, exactly as before.
      try {
        const q = lang ? `&lang=${encodeURIComponent(lang)}` : "";
        const data = await apiJson("GET", `/voices?engine=kokoro${q}`);
        voices = data.voices || [];
      } catch (err) {
        return { content: [{ type: "text", text: `Error: could not list kokoro voices — ${err.message}` }], isError: true };
      }
    } else {
      voices = engine === "piper" ? PIPER_VOICES : EDGE_VOICES;
      if (lang) voices = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
    }
    if (!voices.length) {
      return { content: [{ type: "text", text: `No ${engine} voices match '${lang}'. Use list_voices without a filter to see all.` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(voices, null, 2) }] };
  }
);

server.tool(
  "generate_voiceover",
  `Generate a voiceover with the Koe TTS Studio and save the audio file(s) locally (default folder: ./voiceovers). Free: the MCP auto-registers a per-user tenant key on first use, subject to the studio's hourly/daily word limits. Submits a TTS job, polls until done, downloads the audio, and merges multi-part jobs into a single file when possible. The studio deletes generated audio automatically (typically after ~15 minutes), so download/keep the local file. Call list_voices first to pick a voice id.`,
  {
    text: z.string().min(1).max(40000).describe("The script to narrate. Paragraph breaks are allowed; very long scripts are split into parts automatically."),
    voice: z.string().default("en-US-GuyNeural").describe("Voice id from list_voices, e.g. 'en-US-AndrewNeural'"),
    engine: z.enum(["edge", "piper", "kokoro"]).default("edge").describe("'edge' = Microsoft neural voices (cloud, supports rate/pitch), 'piper' = offline WAV, 'kokoro' = offline Kokoro MP3 (rate is clamped to 1.0-2.0, pitch ignored)"),
    rate: z.number().min(0.5).max(2).default(1).describe("Speaking speed multiplier (1 = normal)"),
    pitch: z.number().int().min(-100).max(100).default(0).describe("Pitch shift in Hz (0 = normal)"),
    file_name: z.string().optional().describe("Output file name without folder, e.g. 'intro-narration.mp3'. Defaults to voiceover-<jobId>"),
    timeout_seconds: z.number().int().min(30).max(900).default(300).describe("How long to wait for the job before giving up"),
    cleanup: z.boolean().default(true).describe("Delete the job and its zip from the studio server after downloading"),
  },
  async (args) => {
    try {
      const started = await submitTts({
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
        try {
          job = await apiJson("GET", `/job/${jobId}`);
        } catch (err) {
          if (err.status === 404) {
            throw new Error(`Job ${jobId} is no longer on the server (ephemeral jobs expire after about an hour). Submit a new generate_voiceover call.`);
          }
          throw err;
        }
        if (job.status === "done" || job.status === "failed") break;
        if (Date.now() > deadline) {
          throw new Error(`Timed out after ${args.timeout_seconds}s waiting for job ${jobId} (last status: ${job.status}). The studio keeps working; use get_voiceover_status with this id.`);
        }
      }
      if (job.status === "failed") throw new Error(`TTS job failed on the studio server: ${job.error}`);

      const dl = await api("GET", `/download/${jobId}`);
      if (!dl.ok) {
        const data = await dl.json().catch(() => ({}));
        throw new Error(`${dl.status} — ${data.error || `could not download job ${jobId}`}`);
      }
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
          const merged = mergeAudioParts(buffers, ext);
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
        expiresInSeconds: Number.isFinite(job.expiresInSeconds) ? job.expiresInSeconds : null,
        note: savedPaths.length > 1
          ? "Parts could not be merged automatically; all parts are listed."
          : "The studio audio is ephemeral; your local file is the permanent copy.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_voiceover_status",
  "Check the status of one of your TTS Studio jobs by id (useful when generate_voiceover timed out). Jobs expire after about an hour; audio expires sooner.",
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
  "List your 10 most recent jobs on the TTS Studio server (newest first). Tenant isolation means you only see your own jobs.",
  {},
  async () => {
    try {
      const jobs = await apiJson("GET", "/jobs");
      const summary = jobs.slice(0, 10).map((j) => ({
        id: j.id, status: j.status, voice: j.voice, engine: j.engine,
        wordCount: j.wordCount, createdAt: j.createdAt, completedAt: j.completedAt,
        expiresInSeconds: j.expiresInSeconds, error: j.error,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_usage",
  "Show this install's free-tier usage: requests/words this hour and today, the limits, and when they reset.",
  {},
  async () => {
    try {
      await ensureKey();
      const usage = await apiJson("GET", "/usage");
      return { content: [{ type: "text", text: JSON.stringify({ keyMode: keySource, ...usage }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── boot ─────────────────────────────────────────────────────

async function main() {
  loadStoredKey();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`koe-tts-mcp → ${BASE_URL} (key: ${keySource}), output dir: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("koe-tts-mcp failed to start:", err);
  process.exit(1);
});
