"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — cache.js
//
//  The synthesis cache stores finished audio keyed by the exact request
//  (engine, voice, rate, pitch, text). It used to grow forever: every distinct
//  script added a file nobody ever removed.
//
//  Now every write prunes the directory back under a byte budget, oldest file
//  first (KOE_CACHE_MAX_MB, default 256 MB). Nothing is required for
//  correctness — a missing entry just means one more upstream call — so pruning
//  is allowed to be aggressive.
// ─────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = Math.max(1, parseInt(process.env.KOE_CACHE_MAX_MB, 10) || 256) * 1024 * 1024;

function entries(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) files.push({ full, size: stat.size, at: stat.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  return files;
}

function totalBytes(dir) {
  return entries(dir).reduce((sum, f) => sum + f.size, 0);
}

// Delete oldest-first until the directory fits in `maxBytes`.
function prune(dir, maxBytes = DEFAULT_MAX_BYTES) {
  const files = entries(dir);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return { removed: 0, bytes: total, maxBytes };

  files.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const file of files) {
    if (total <= maxBytes) break;
    try {
      fs.rmSync(file.full, { force: true });
      total -= file.size;
      removed += 1;
    } catch { /* someone else pruned it first */ }
  }
  return { removed, bytes: total, maxBytes };
}

function read(dir, name) {
  try {
    const bytes = fs.readFileSync(path.join(dir, name));
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

function write(dir, name, bytes, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  } catch {
    return { pruned: null };   // the cache is best-effort
  }
  return { pruned: prune(dir, maxBytes) };
}

module.exports = { DEFAULT_MAX_BYTES, prune, read, write, totalBytes };
