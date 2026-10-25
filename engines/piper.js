"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/piper.js
//
//  Offline Piper. The two runner bodies were moved here verbatim from
//  server.js — same docker image, same model path, same 10-minute timeout,
//  text still fed over stdin, same error strings. Only the handoff changed:
//  the adapter returns bytes instead of leaving a file for the caller.
//
//  Output is still WAV, so every ext/mime decision that said
//  `engine === "piper" ? "wav" : "mp3"` keeps working unchanged.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { TTS_BACKEND, MAX_BUFFER, cmdAvailable } = require("./backend");
const { PIPER_VOICES } = require("../voices");

const PIPER_IMAGE = "piper-tts";
const PIPER_MODEL = "en_US-lessac-medium.onnx";
// `__dirname` here is engines/, so the repo-root fallback is explicit — the
// original `path.join(__dirname, ...)` in server.js pointed at the repo root.
const PIPER_ROOT = process.env.PIPER_ROOT || path.join(
  process.env.HOME || process.env.USERPROFILE || path.join(__dirname, ".."),
  "piper-docker"
);
const PIPER_MODELS_DIR = path.join(PIPER_ROOT, "models");

const PIPER_TIMEOUT_MS = 10 * 60 * 1000;
const CONTENT_TYPE = "audio/wav";
const EXT = "wav";

function runDockerPiperTTS({ text, hostDir, containerDir, fileName }) {
  return new Promise((resolve, reject) => {
    const args = [
      "run", "--rm", "-i",
      "-v", `${PIPER_MODELS_DIR}:/models`,
      "-v", `${hostDir}:${containerDir}`,
      PIPER_IMAGE,
      "--model", `/models/${PIPER_MODEL}`,
      "--output_file", `${containerDir}/${fileName}`,
    ];

    const child = execFile("docker", args, { maxBuffer: MAX_BUFFER, timeout: PIPER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error("[PIPER ERROR docker]", stderr);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });

    child.stdin.write(text);
    child.stdin.end();
  });
}

function runNativePiperTTS({ text, outPath }) {
  return new Promise((resolve, reject) => {
    const modelPath = path.join(PIPER_MODELS_DIR, PIPER_MODEL);
    if (!fs.existsSync(modelPath)) {
      return reject(new Error(`Piper model not found at ${modelPath}`));
    }

    const child = execFile(
      "piper",
      ["--model", modelPath, "--output_file", outPath],
      { maxBuffer: MAX_BUFFER, timeout: PIPER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[PIPER ERROR native]", stderr || err.message);
          if (err.code === "ENOENT") {
            return reject(new Error("piper CLI not found on this host (pip install piper-tts)"));
          }
          return reject(new Error(stderr || err.message));
        }
        resolve();
      }
    );

    child.stdin.write(text);
    child.stdin.end();
  });
}

// Boot-time capability probe, identical to the old CAPABILITIES.piper.
const AVAILABLE = TTS_BACKEND === "docker" ? true : cmdAvailable("piper");

function scratchPath(scratchDir) {
  const dir = scratchDir || os.tmpdir();
  return path.join(dir, `piper-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${EXT}`);
}

module.exports = {
  name: "piper",
  ext: EXT,
  contentType: CONTENT_TYPE,

  /**
   * @param {{text:string, voice?:string, scratchDir?:string}} p
   *   `voice`/`rate`/`pitch` are accepted for interface symmetry and ignored,
   *   exactly as the piper runners always ignored them.
   * @returns {Promise<{bytes: Buffer, contentType: string}>}
   */
  async synthesize({ text, scratchDir }) {
    const outPath = scratchPath(scratchDir);
    try {
      if (TTS_BACKEND === "docker") {
        await runDockerPiperTTS({
          text,
          hostDir: path.dirname(outPath),
          containerDir: "/output",
          fileName: path.basename(outPath),
        });
      } else {
        await runNativePiperTTS({ text, outPath });
      }
      const bytes = await fs.promises.readFile(outPath);
      return { bytes, contentType: CONTENT_TYPE };
    } finally {
      fs.promises.rm(outPath, { force: true }).catch(() => {});
    }
  },

  // Static curated catalog — unchanged.
  listVoices({ lang } = {}) {
    const out = lang
      ? PIPER_VOICES.filter((v) => v.lang.toLowerCase().startsWith(String(lang).toLowerCase()))
      : PIPER_VOICES;
    return Promise.resolve(out);
  },

  healthy() {
    return Promise.resolve(Boolean(AVAILABLE));
  },
};
