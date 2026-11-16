"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/errors.js
//
//  Turn a CLI's stderr into one line a human or an agent can act on.
//
//  edge-tts and piper are Python programs: when they fail, stderr is a full
//  traceback — dozens of frames, then one exception line with the actual
//  reason. That whole dump used to be copied into `job.error` and handed to
//  MCP clients verbatim, which buried the one useful sentence.
//
//  This keeps the exception line (or, failing that, the last line of output)
//  and drops the rest. Logs still get the full stderr from the caller.
// ─────────────────────────────────────────────────────────────

const MAX_LEN = 300;

// "edge_tts.exceptions.NoAudioReceived: No audio was received." / "Error: ..."
const EXCEPTION_LINE = /^[A-Za-z_][\w.]*:\s+\S/;

function readableError(stderr, fallback) {
  const lines = String(stderr || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const exception = [...lines].reverse().find((l) => EXCEPTION_LINE.test(l) && !l.startsWith("File "));
  const picked = exception || lines[lines.length - 1] || "";

  const fromFallback = fallback && fallback.message ? String(fallback.message) : fallback ? String(fallback) : "";
  const out = (picked || fromFallback || "synthesis failed").replace(/\s+/g, " ").trim();

  return out.length > MAX_LEN ? `${out.slice(0, MAX_LEN - 1)}…` : out;
}

module.exports = { readableError, MAX_LEN };
