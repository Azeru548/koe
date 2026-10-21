"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — audio.js
//
//  Small buffer helpers shared by the studio server and the MCP
//  servers to turn a job's per-part audio into one file.
//    • MP3 parts concatenate frame-by-frame (same encoder params).
//    • WAV parts are stitched by rewriting the RIFF header.
// ─────────────────────────────────────────────────────────────

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

// Merge ordered parts into a single buffer. `ext` is "mp3" or "wav".
function mergeAudioParts(buffers, ext) {
  if (!Array.isArray(buffers) || buffers.length === 0) throw new Error("no audio parts");
  if (buffers.length === 1) return buffers[0];
  return ext === "wav" ? concatWav(buffers) : Buffer.concat(buffers);
}

module.exports = { parseWav, concatWav, mergeAudioParts };
