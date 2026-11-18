// Generates the film's voiceover through the live Koe instance (the product narrating itself).
// Uses the stored free key from ~/.koe/credentials.json; never prints it.
// Flow: POST /tts -> poll /job/:id -> GET /download/:id (zip of parts) -> extract part_001.mp3
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const STUDIO = "https://koe.kennedyazeru.space";
const credsPath = join(process.env.USERPROFILE || process.env.HOME, ".koe", "credentials.json");

async function mintKey() {
  const ch = await (await fetch(`${STUDIO}/keys/challenge`)).json();
  if (ch.mode !== "pow") throw new Error("challenge mode is " + ch.mode + ", not pow");
  const prefix = "0".repeat(ch.pow.leadingZeroHexChars);
  for (let n = 0; n < 50_000_000; n++) {
    const nonce = String(n);
    if (!createHash("sha256").update(ch.challenge + nonce).digest("hex").startsWith(prefix)) continue;
    const res = await fetch(`${STUDIO}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: ch.challenge, nonce }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error("key mint failed: " + JSON.stringify(body));
    return body;
  }
  throw new Error("no nonce found");
}

const creds = JSON.parse(readFileSync(credsPath, "utf8"));
let key = creds[STUDIO]?.key;
if (!key) throw new Error("no stored key — run this once with minting enabled");

const auth = { "x-api-key": key };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry wrapper: honour 503 cool-downs and queue pressure instead of failing the line.
async function call(url, init = {}, label = "") {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    if (res.ok) return res;
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 503 || res.status === 429) {
      let wait = 20;
      try {
        wait = Math.min(120, Number(JSON.parse(detail)?.retryAfterSeconds) || 20);
      } catch {}
      console.log(`${label}: ${res.status}, waiting ${wait}s -> ${detail}`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${label}: HTTP ${res.status} ${detail}`);
  }
  throw new Error(`${label}: gave up after retries`);
}

// Line order matches the visual beats in beat-sheet.md: intro build, hero card, what,
// fit, how (key / client / voiceover), proof, end card (claim + close).
const lines = [
  { file: "vo-01.mp3", text: "Koe is a text-to-speech MCP server. Most agents still don't have a voice." },
  { file: "vo-02.mp3", text: "Give your agent a voice." },
  { file: "vo-03.mp3", text: "Text goes in. An MP3 comes out." },
  { file: "vo-04.mp3", text: "Point your agent at one URL." },
  { file: "vo-05.mp3", text: "Create a key. Send it as a bearer header." },
  { file: "vo-06.mp3", text: "Claude Code connects with one command." },
  { file: "vo-07.mp3", text: "A free key gets sixty requests an hour. The audio deletes itself after fifteen minutes." },
  { file: "vo-08.mp3", text: "Twenty-nine voices, one URL, and no API bill." },
  { file: "vo-09.mp3", text: "Free to start. No account, no card." },
  // added after the first cut: naming the local engines. Numbering is creation order;
  // placement order lives in mix.mjs.
  { file: "vo-10.mp3", text: "Kokoro and Piper run offline." },
];

const engine = process.env.VO_ENGINE || "edge";
const voice = process.env.VO_VOICE || "en-US-EmmaNeural";
mkdirSync("assets", { recursive: true });

// One line = one job. Edge fails on the server now and then (ENOENT after synthesis), so a
// failed job is resubmitted instead of aborting the whole run. Files already on disk are kept.
async function renderLine(line) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const submit = await call(`${STUDIO}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: line.text, voice, engine }),
    }, line.file + " submit");
    const { jobId } = await submit.json();

    let job;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const res = await call(`${STUDIO}/job/${jobId}`, {}, line.file + " poll");
      job = await res.json();
      if (job.status === "done" || job.status === "failed") break;
    }
    if (job?.status === "done") {
      const dl = await call(`${STUDIO}/download/${jobId}`, {}, line.file + " download");
      const zipPath = join("assets", `${line.file}.zip`);
      writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));
      // unzip -p streams the entry to stdout, so parts from different lines never collide.
      const audio = execFileSync("unzip", ["-p", zipPath, "part_001.mp3"], { maxBuffer: 64 * 1024 * 1024 });
      writeFileSync(join("assets", line.file), audio);
      rmSync(zipPath);
      console.log(line.file, "ok —", job.parts, "part(s),", job.wordCount, "words,", job.voice);
      return;
    }
    console.log(`${line.file}: attempt ${attempt} ended ${job?.status} (${job?.error || ""}) — retrying`);
    await sleep(6000);
  }
  throw new Error(`${line.file}: gave up after 4 attempts`);
}

for (const line of lines) {
  if (existsSync(join("assets", line.file))) {
    console.log(line.file, "already rendered — skipped");
    continue;
  }
  await renderLine(line);
}

const usage = await (await fetch(`${STUDIO}/usage`, { headers: auth })).json();
console.log("usage:", JSON.stringify(usage.usage?.hour));
