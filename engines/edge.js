"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/edge.js  (DEFAULT ENGINE)
//
//  Microsoft neural voices via the `edge-tts` CLI. The four runner bodies
//  below were moved here verbatim from server.js: same arguments, same
//  timeouts, same error strings, same `execFile` (never `exec`), so user
//  text never touches a shell. Only the handoff changed — the adapter now
//  returns the bytes instead of leaving a file behind for the caller.
//
//  Nothing about edge's behaviour, voice ids, rate/pitch formatting or
//  output format (MP3) has changed.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { TTS_BACKEND, MAX_BUFFER } = require("./backend");
const { EDGE_VOICES } = require("../voices");

const EDGE_TIMEOUT_MS = 5 * 60 * 1000;
const CONTENT_TYPE = "audio/mpeg";
const EXT = "mp3";

// edge-tts wants "+10%" / "-5%" and "+0Hz" / "-20Hz" strings.
function formatRate(rate) {
  const pct = Math.round((parseFloat(rate) - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatPitch(pitch) {
  const hz = parseInt(pitch, 10);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

function runDockerEdgeTTS({ text, voice, rate, pitch, hostDir, containerDir, fileName }) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) — user-supplied text/voice never touch a shell.
    const args = [
      "run", "--rm",
      "-v", `${hostDir}:${containerDir}`,
      "edge-tts",
      "--voice", voice,
      "--rate", formatRate(rate),
      "--pitch", formatPitch(pitch),
      "--text", text,
      "--write-media", `${containerDir}/${fileName}`,
    ];

    execFile("docker", args, { maxBuffer: MAX_BUFFER, timeout: EDGE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR docker] voice=${voice}\n${stderr}`);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

function runNativeEdgeTTS({ text, voice, rate, pitch, outPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--voice", voice,
      "--rate", formatRate(rate),
      "--pitch", formatPitch(pitch),
      "--text", text,
      "--write-media", outPath,
    ];

    execFile("edge-tts", args, { maxBuffer: MAX_BUFFER, timeout: EDGE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR native] voice=${voice}\n${stderr || err.message}`);
        if (err.code === "ENOENT") {
          return reject(new Error("edge-tts CLI not found on this host (pip install edge-tts)"));
        }
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

// Boot-time capability probe, identical to the old CAPABILITIES.edge.
// Cached: a CLI does not appear or vanish while the process is running.
const AVAILABLE = TTS_BACKEND === "docker" ? true : require("./backend").cmdAvailable("edge-tts");

// Scratch file for the CLI, which can only write to a path. It is read back
// into bytes and removed immediately, so no audio lingers outside the job dir.
function scratchPath(scratchDir) {
  const dir = scratchDir || os.tmpdir();
  return path.join(dir, `edge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${EXT}`);
}

module.exports = {
  name: "edge",
  ext: EXT,
  contentType: CONTENT_TYPE,
  formatRate,
  formatPitch,

  /**
   * @param {{text:string, voice:string, rate:number, pitch:number, scratchDir?:string}} p
   * @returns {Promise<{bytes: Buffer, contentType: string}>}
   */
  async synthesize({ text, voice, rate, pitch, scratchDir }) {
    const outPath = scratchPath(scratchDir);
    try {
      if (TTS_BACKEND === "docker") {
        await runDockerEdgeTTS({
          text, voice, rate, pitch,
          hostDir: path.dirname(outPath),
          containerDir: "/app/output",
          fileName: path.basename(outPath),
        });
      } else {
        await runNativeEdgeTTS({ text, voice, rate, pitch, outPath });
      }
      const bytes = await fs.promises.readFile(outPath);
      return { bytes, contentType: CONTENT_TYPE };
    } finally {
      fs.promises.rm(outPath, { force: true }).catch(() => {});
    }
  },

  // Static curated catalog — unchanged, and still the source the studio UI
  // and both MCP servers show for edge.
  listVoices({ lang } = {}) {
    const out = lang
      ? EDGE_VOICES.filter((v) => v.lang.toLowerCase().startsWith(String(lang).toLowerCase()))
      : EDGE_VOICES;
    return Promise.resolve(out);
  },

  healthy() {
    return Promise.resolve(Boolean(AVAILABLE));
  },
};
