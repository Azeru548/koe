"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — hosted MCP server
//
//  Builds an MCP server that runs *inside* the studio and exposes the
//  same tools as the stdio MCP (mcp/index.js) over Streamable HTTP.
//  Mounted by server.js at POST /mcp, so agents connect by URL — no
//  install, no local Node, no absolute paths.
//
//  Differences from the stdio server, by necessity:
//    • generate_voiceover cannot write to the caller's disk (the audio
//      lives on the studio), so it returns a short-lived signed download
//      URL and, when the clip is small enough, the audio inline.
//    • The caller is identified by the free key they send with the MCP
//      request; every tool call re-passes it through the studio's own
//      guarded API so rate limits and tenant isolation apply unchanged.
//
//  `client` is provided by server.js and talks to the studio's local
//  HTTP API with the caller's key. See makeStudioClient() in server.js.
// ─────────────────────────────────────────────────────────────

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const AdmZip = require("adm-zip");
const { voicesFor } = require("./voices");
const { mergeAudioParts } = require("./audio");

const VERSION = "1.0.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function extractZipAudio(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .sort((a, b) => a.entryName.localeCompare(b.entryName))
    .map((e) => e.getData());
}

/**
 * @param {object} opts
 * @param {object} opts.client studio client (health/usage/submit/job/listJobs/download/signAudioUrl/…)
 * @returns {McpServer}
 */
function createHostedMcp({ client }) {
  const server = new McpServer({ name: "koe-tts-studio", version: VERSION });
  const pollMs = Math.max(500, intEnv("KOE_MCP_POLL_MS", 2000));
  const inlineMax = intEnv("KOE_MCP_INLINE_AUDIO_MAX", 3 * 1024 * 1024);

  server.tool(
    "studio_status",
    "Check that the Koe TTS Studio is reachable, which engines it has, and your free-tier usage. Call this first if a generate call fails — the studio runs on a free host that sleeps after ~15 minutes idle, so the first call can take up to ~60s.",
    {},
    async () => {
      try {
        const health = await client.health();
        let usage = null;
        try { usage = await client.usage(); } catch { /* best effort */ }
        return jsonResult({
          ...health,
          studioUrl: client.studioUrl,
          transport: "streamable-http",
          client: { keyMode: client.keyMode, usage },
        });
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  server.tool(
    "list_voices",
    "List the available voices. 'edge' voices are Microsoft neural voices (cloud, many languages); 'piper' voices run offline on the studio host. Pass an id to generate_voiceover.",
    {
      engine: z.enum(["edge", "piper"]).default("edge").describe("Which engine's voices to list"),
      lang: z.string().optional().describe("Optional language prefix filter, e.g. 'en', 'en-GB', 'fr'"),
    },
    async ({ engine, lang }) => {
      let voices = voicesFor(engine);
      if (lang) voices = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
      if (!voices.length) {
        return errorResult(`No ${engine} voices match '${lang}'. Call list_voices without a filter to see all.`);
      }
      return jsonResult(voices);
    }
  );

  server.tool(
    "generate_voiceover",
    "Generate a voiceover from text and return it as a short-lived download link (plus inline audio for short clips). Free: the studio applies per-caller hourly/daily word limits. Generated audio is ephemeral — the link works for ~15 minutes, so download the file during the session. Call list_voices first to pick a voice id.",
    {
      text: z.string().min(1).max(40000).describe("The script to narrate. Paragraph breaks are allowed; long scripts are split into parts automatically."),
      voice: z.string().default("en-US-GuyNeural").describe("Voice id from list_voices, e.g. 'en-US-AndrewNeural'"),
      engine: z.enum(["edge", "piper"]).default("edge").describe("'edge' = Microsoft neural voices (cloud, supports rate/pitch), 'piper' = offline"),
      rate: z.number().min(0.5).max(2).default(1).describe("Speaking speed multiplier (1 = normal)"),
      pitch: z.number().int().min(-100).max(100).default(0).describe("Pitch shift in Hz (0 = normal)"),
      timeout_seconds: z.number().int().min(30).max(900).default(300).describe("How long to wait for the job before giving up"),
    },
    async (args) => {
      let jobId;
      try {
        const started = await client.submit({
          text: args.text,
          voice: args.voice,
          engine: args.engine,
          rate: args.rate,
          pitch: args.pitch,
        });
        jobId = started.jobId;
      } catch (err) {
        return errorResult(err.message);
      }

      const ext = args.engine === "piper" ? "wav" : "mp3";
      const deadline = Date.now() + args.timeout_seconds * 1000;
      let job;
      try {
        for (;;) {
          await sleep(pollMs);
          job = await client.job(jobId);
          if (job.status === "done" || job.status === "failed") break;
          if (Date.now() > deadline) {
            return jsonResult({
              jobId,
              status: job.status,
              note: `Still generating after ${args.timeout_seconds}s. The studio keeps working — call get_voiceover_status with this jobId in a moment.`,
            });
          }
        }
      } catch (err) {
        return errorResult(err.message);
      }

      if (job.status === "failed") {
        return errorResult(`TTS job failed on the studio server: ${job.error}`);
      }

      const downloadUrl = client.signAudioUrl(jobId);
      const payload = {
        jobId,
        voice: job.voice,
        engine: job.engine,
        parts: job.parts,
        wordCount: job.wordCount,
        format: ext,
        downloadUrl,
        expiresInSeconds: Number.isFinite(job.expiresInSeconds) ? job.expiresInSeconds : null,
        note: "The studio audio is ephemeral: download it now. The link is signed and needs no API key.",
      };
      const content = [{ type: "text", text: JSON.stringify(payload, null, 2) }];

      // Inline the audio for clients that can save an audio content block.
      if (inlineMax > 0) {
        try {
          const zipBuffer = await client.download(jobId);
          const merged = mergeAudioParts(extractZipAudio(zipBuffer), ext);
          if (merged.length <= inlineMax) {
            content.push({
              type: "audio",
              data: merged.toString("base64"),
              mimeType: ext === "wav" ? "audio/wav" : "audio/mpeg",
            });
          }
        } catch { /* the link above is the fallback */ }
      }

      return { content };
    }
  );

  server.tool(
    "get_voiceover_status",
    "Check the status of one of your TTS jobs by id (useful when generate_voiceover timed out). Jobs expire after about an hour; audio expires sooner.",
    {
      job_id: z.string().describe("Job id returned by generate_voiceover"),
    },
    async ({ job_id }) => {
      try {
        return jsonResult(await client.job(job_id));
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  server.tool(
    "list_recent_voiceovers",
    "List your 10 most recent jobs on the studio (newest first). Jobs are tenant-isolated: you only see your own.",
    {},
    async () => {
      try {
        const jobs = await client.listJobs();
        const summary = jobs.slice(0, 10).map((j) => ({
          id: j.id, status: j.status, voice: j.voice, engine: j.engine,
          wordCount: j.wordCount, createdAt: j.createdAt, completedAt: j.completedAt,
          expiresInSeconds: j.expiresInSeconds, error: j.error,
        }));
        return jsonResult(summary);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  server.tool(
    "get_usage",
    "Show your free-tier usage: requests/words this hour and today, the limits, and when they reset.",
    {},
    async () => {
      try {
        const usage = await client.usage();
        return jsonResult({ keyMode: client.keyMode, ...usage });
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  return server;
}

module.exports = { createHostedMcp, VERSION };
