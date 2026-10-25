"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/backend.js
//
//  HOW the CLI engines are executed on this host. Shared by
//  engines/edge.js, engines/piper.js and server.js (logging + /healthz).
//
//  It lives in its own module so edge.js and piper.js can require it
//  without an import cycle through engines/index.js.
//
//    "docker" → shells out to docker (local dev, as before)
//    "native" → runs `edge-tts` / `piper` CLIs directly (Docker image: no daemon)
//  Auto-detects when TTS_BACKEND is unset: docker if the CLI exists, else native.
//
//  Moved verbatim out of server.js — no behaviour change.
// ─────────────────────────────────────────────────────────────

const { execSync } = require("child_process");

function detectBackend() {
  const pref = (process.env.TTS_BACKEND || "").toLowerCase();
  if (pref === "docker" || pref === "native") return pref;
  try {
    execSync("docker --version", { stdio: "ignore", timeout: 5000 });
    return "docker";
  } catch {
    return "native";
  }
}

const TTS_BACKEND = detectBackend();

// Probe a CLI by running `--help`. Used at boot to build CAPABILITIES.
function cmdAvailable(cmd) {
  try {
    execSync(`"${cmd}" --help`, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Shared execFile guard: keeps a runaway synthesiser from eating the process.
const MAX_BUFFER = 1024 * 1024 * 10;

module.exports = { TTS_BACKEND, detectBackend, cmdAvailable, MAX_BUFFER };
