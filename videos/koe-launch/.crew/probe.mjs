import { readFileSync } from "node:fs";
import { join } from "node:path";
const STUDIO = "https://koe.kennedyazeru.space";
const key = JSON.parse(readFileSync(join(process.env.USERPROFILE, ".koe", "credentials.json"), "utf8"))[STUDIO].key;
const auth = { "x-api-key": key };
const h = await (await fetch(STUDIO + "/healthz")).json();
console.log("engines:", JSON.stringify(h.engines), "| killSwitch:", h.killSwitch);
for (const engine of ["edge", "kokoro", "kitten"]) {
  const r = await fetch(STUDIO + "/tts", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "Hello.", engine }) });
  const body = await r.text();
  console.log(engine, "submit ->", r.status, body.slice(0, 150));
  if (r.ok) {
    const { jobId } = JSON.parse(body);
    let job;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      job = await (await fetch(`${STUDIO}/job/${jobId}`, { headers: auth })).json();
      if (job.status === "done" || job.status === "failed") break;
    }
    console.log(engine, "job ->", job.status, (job.error || "").slice(0, 120), "voice:", job.voice);
  }
}
