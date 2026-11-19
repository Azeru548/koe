// Generates the film's voiceover as ONE continuous read through the live Koe instance.
// Ten separate jobs each reset the prosody (that's what made the VO sound stitched);
// one job over the whole script keeps a single performance, and mix.mjs then cuts that
// take at its own sentence pauses to sit the pieces on the picture beats.
// Flow: POST /tts -> poll /job/:id -> GET /download/:id (zip of parts) -> part_001.mp3
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const STUDIO = "https://koe.kennedyazeru.space";
const OUT = "assets/vo-take.mp3";
const credsPath = join(process.env.USERPROFILE || process.env.HOME, ".koe", "credentials.json");

const creds = JSON.parse(readFileSync(credsPath, "utf8"));
const key = creds[STUDIO]?.key;
if (!key) throw new Error("no stored key in ~/.koe/credentials.json");
const auth = { "x-api-key": key };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The whole script as one paragraph: single spaces, no blank lines, so the server
// synthesises it as a single chunk instead of splitting it into parts.
export const SCRIPT =
  "Agents can research, write, and ship whole projects. They just can't speak. " +
  "That's where Koe comes in. " +
  "Koe is a text-to-speech server with a host of voice models. " +
  "Point your agent at it. " +
  "Take a free key, connect your agent, and ask for a voiceover. " +
  "No account. No API bill. Nothing to install. " +
  "Or play in the studio — type a line, pick a voice, and hear it. " +
  "A host of voices. One URL. " +
  "Free to start. Give your agent a voice.";

const engine = process.env.VO_ENGINE || "edge";
const voice = process.env.VO_VOICE || "en-US-EmmaNeural";

async function call(url, init = {}, label = "") {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    if (res.ok) return res;
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 503 || res.status === 429) {
      let wait = 20;
      try { wait = Math.min(120, Number(JSON.parse(detail)?.retryAfterSeconds) || 20); } catch {}
      console.log(`${label}: ${res.status}, waiting ${wait}s -> ${detail}`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${label}: HTTP ${res.status} ${detail}`);
  }
  throw new Error(`${label}: gave up after retries`);
}

mkdirSync("assets", { recursive: true });

for (let attempt = 1; attempt <= 4; attempt++) {
  const submit = await call(`${STUDIO}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: SCRIPT, voice, engine }),
  }, "take submit");
  const { jobId, parts, wordCount } = await submit.json();
  console.log(`job ${jobId} — ${parts} part(s), ${wordCount} words, ${voice}`);

  let job;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    job = await (await call(`${STUDIO}/job/${jobId}`, {}, "take poll")).json();
    if (job.status === "done" || job.status === "failed") break;
  }
  if (job?.status === "done") {
    const dl = await call(`${STUDIO}/download/${jobId}`, {}, "take download");
    const zipPath = join("assets", "vo-take.zip");
    writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));
    const audio = execFileSync("unzip", ["-p", zipPath, "part_001.mp3"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(OUT, audio);
    rmSync(zipPath);
    console.log(`${OUT} ok — ${job.parts} part(s), ${job.wordCount} words`);
    process.exit(0);
  }
  console.log(`attempt ${attempt} ended ${job?.status} (${job?.error || ""}) — retrying`);
  await sleep(6000);
}
throw new Error("take: gave up after 4 attempts");
