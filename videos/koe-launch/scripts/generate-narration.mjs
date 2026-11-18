#!/usr/bin/env node
// Generates the launch film's narration **with Koe itself** — the film's core
// idea: the product voices its own launch. Each beat is a separate job so its
// MP3 is its own cue point on the timeline (film.md: write the voiceover as
// separate phrases so it has cue points).
//
//   node scripts/generate-narration.mjs
//
// Reads API_KEY from $KOE_ADMIN_KEY or from the local secrets file, submits one
// job per line to the live instance, polls, downloads the zip, keeps
// part_001.mp3 as assets/audio/NN-slug.mp3.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "assets", "audio");
const BASE = process.env.KOE_URL || "https://koe.kennedyazeru.space";
const VOICE = process.env.KOE_VOICE || "en-US-AndrewNeural";

function adminKey() {
  if (process.env.KOE_ADMIN_KEY) return process.env.KOE_ADMIN_KEY.trim();
  const candidates = [
    path.join(process.env.TEMP || "", "opencode", "koe-secrets.txt"),
    "C:/Users/User/Documents/Koe Secrets/koe-secrets.txt",
  ];
  for (const f of candidates) {
    try {
      const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("API_KEY="));
      if (line) return line.slice("API_KEY=".length).trim();
    } catch { /* try next */ }
  }
  throw new Error("No admin key: set KOE_ADMIN_KEY or provide the secrets file");
}

const LINES = [
  ["01-hook", "You're listening to the thing this film is launching."],
  ["02-tension", "Voiceover used to cost an account, a card, and a meter running in the corner."],
  ["03-reveal", "Koe, version two: a voice for any agent, at one URL."],
  ["04-connect", "Point Claude, Cursor, or any client at the endpoint, and the agent sets itself up."],
  ["05-call", "Then it asks for a take, and the finished file lands in your project."],
  ["06-limits", "Twenty-nine voices, sixty requests an hour, twenty thousand words a day."],
  ["07-ephemeral", "No account, no card, and the audio is deleted after fifteen minutes."],
  ["08-claim", "The agentic era needed a voice. This is Koe."],
];

const key = adminKey();
const headers = { "x-api-key": key, "Content-Type": "application/json" };

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function durationOf(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim();
  return Number(out);
}

fs.mkdirSync(OUT, { recursive: true });
const report = [];

for (const [slug, text] of LINES) {
  const dest = path.join(OUT, `${slug}.mp3`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    report.push([slug, durationOf(dest), "cached"]);
    continue;
  }
  const { jobId } = await api("POST", "/tts", { text, voice: VOICE, engine: "edge", rate: 1.0 });

  let job = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    job = await api("GET", `/job/${jobId}`);
    if (job.status === "done" || job.status === "failed") break;
  }
  if (!job || job.status !== "done") throw new Error(`${slug}: job ${jobId} ended ${job?.status} ${job?.error || ""}`);

  const zip = Buffer.from(await (await fetch(`${BASE}/download/${jobId}`, { headers, signal: AbortSignal.timeout(30000) })).arrayBuffer());
  fs.writeFileSync(path.join(OUT, `${slug}.zip`), zip);

  const { default: AdmZip } = await import("file://" + path.join(ROOT, "..", "..", "node_modules", "adm-zip", "adm-zip.js"));
  const entry = new AdmZip(zip).getEntries().find((e) => /part_001\.(mp3|wav)$/.test(e.entryName));
  if (!entry) throw new Error(`${slug}: no part_001 in zip`);
  fs.writeFileSync(dest, entry.getData());
  fs.unlinkSync(path.join(OUT, `${slug}.zip`));
  await api("DELETE", `/job/${jobId}`);

  report.push([slug, durationOf(dest), "fresh"]);
}

let total = 0;
for (const [slug, sec, how] of report) {
  total += sec;
  console.log(`${slug.padEnd(16)} ${sec.toFixed(2)}s  (${how})`);
}
console.log(`speech total      ${total.toFixed(2)}s  voice=${VOICE}`);
