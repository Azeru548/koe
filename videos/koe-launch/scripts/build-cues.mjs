#!/usr/bin/env node
// Word-level cue times for the narration, from the phrases Koe generated.
// Each beat is its own MP3; Parakeet gives the start of every word inside it,
// which is what the scenes use to land text on the word that says it.
//
//   node scripts/build-cues.mjs   ->  scripts/cues.json  (seconds, local to each file)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AUDIO = path.join(ROOT, "assets", "audio");
const FILES = [
  "01-hook", "02-tension", "03-reveal", "04-connect",
  "05-call", "06-limits", "07-ephemeral", "08-claim",
];

const out = {};
const OUT_PATH = path.join(ROOT, "scripts", "cues.json");
const save = () => fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
for (const f of FILES) {
  if (fs.existsSync(OUT_PATH)) {
    try { Object.assign(out, JSON.parse(fs.readFileSync(OUT_PATH, "utf8"))); } catch { /* rebuild */ }
    if (out[f]?.length) continue;
  }
  const run = spawnSync(
    "npx",
    ["hyperframes@0.8.193", "transcribe", path.join(AUDIO, `${f}.mp3`), "--json", "--no-runtime-install"],
    { encoding: "utf8", maxBuffer: 1e8, shell: true },
  );
  const line = `${run.stdout || ""}\n${run.stderr || ""}`
    .split(/\r?\n/)
    .find((l) => l.includes('"type":"words"'));
  if (!line) throw new Error(`${f}: no word timings returned`);
  out[f] = JSON.parse(line).words.map((w) => ({
    t: w.text.replace(/[.,:!?]/g, ""),
    s: +w.start.toFixed(3),
    e: +w.end.toFixed(3),
  }));
  save();
}

save();
for (const f of FILES) {
  const w = out[f];
  console.log(`${f.padEnd(13)} ${String(w.length).padStart(2)} words  speech ends ${w[w.length - 1].e}s`);
}
