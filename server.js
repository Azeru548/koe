const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec, execFile, execSync } = require("child_process");
const archiver = require("archiver");
const PIPER_IMAGE = "piper-tts";
const PIPER_MODEL = "en_US-lessac-medium.onnx";
const PIPER_ROOT = process.env.PIPER_ROOT || path.join(process.env.HOME || process.env.USERPROFILE || __dirname, "piper-docker");
const PIPER_MODELS_DIR = path.join(PIPER_ROOT, "models");

// ─────────────────────────────────────────────
//  TTS BACKEND
//  "docker" → shells out to docker (local dev, as before)
//  "native" → runs `edge-tts` / `piper` CLIs directly (Render: no Docker daemon)
//  Auto-detects when TTS_BACKEND is unset: docker if the CLI exists, else native.
// ─────────────────────────────────────────────

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

function cmdAvailable(cmd) {
  try {
    execSync(`"${cmd}" --help`, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const CAPABILITIES = TTS_BACKEND === "native"
  ? { edge: cmdAvailable("edge-tts"), piper: cmdAvailable("piper") }
  : { edge: true, piper: true };

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─────────────────────────────────────────────
//  AUTH (optional) — set API_KEY to require it
// ─────────────────────────────────────────────

const API_KEY = process.env.API_KEY || "";

function keyMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (!API_KEY || req.path === "/health") return next();
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.headers["x-api-key"] || bearer || req.query.key || "";
  if (keyMatches(provided)) return next();
  res.status(401).json({ error: "Unauthorized — send the key as x-api-key header, Authorization: Bearer, or ?key=" });
});

// Serve the studio UI from the same origin (used on Render)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ─────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, "output");
const JOBS_FILE  = path.join(__dirname, "jobs.json");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE))  fs.writeFileSync(JOBS_FILE, "[]");

// ─────────────────────────────────────────────
//  JOB STORE HELPERS
// ─────────────────────────────────────────────

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveJob(updatedJob) {
  const jobs = loadJobs();
  const idx  = jobs.findIndex(j => j.id === updatedJob.id);
  if (idx !== -1) jobs[idx] = updatedJob;
  else jobs.push(updatedJob);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function getJob(id) {
  return loadJobs().find(j => j.id === id) || null;
}

// ─────────────────────────────────────────────
//  TEXT SPLITTING
// ─────────────────────────────────────────────

function splitText(text) {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const parts = [];
  for (const para of paragraphs) {
    if (para.length <= 3000) {
      parts.push(para);
    } else {
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let chunk = "";
      for (const s of sentences) {
        if ((chunk + s).length > 3000) {
          if (chunk) parts.push(chunk.trim());
          chunk = s;
        } else {
          chunk += s;
        }
      }
      if (chunk.trim()) parts.push(chunk.trim());
    }
  }
  return parts;
}

// ─────────────────────────────────────────────
//  TTS ENGINES
// ─────────────────────────────────────────────

function formatRate(rate) {
  const pct = Math.round((parseFloat(rate) - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatPitch(pitch) {
  const hz = parseInt(pitch, 10);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

const EDGE_TIMEOUT_MS = 5 * 60 * 1000;
const PIPER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024 * 10;

function runDockerEdgeTTS({ text, voice, rate, pitch, hostDir, containerDir, fileName }) {
  return new Promise((resolve, reject) => {
    const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cmd = [
      "docker run --rm",
      `-v "${hostDir}:${containerDir}"`,
      "edge-tts",
      `--voice ${voice}`,
      `--rate "${formatRate(rate)}"`,
      `--pitch "${formatPitch(pitch)}"`,
      `--text "${safeText}"`,
      `--write-media "${containerDir}/${fileName}"`,
    ].join(" \\");

    exec(cmd, { maxBuffer: MAX_BUFFER, timeout: EDGE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR docker] voice=${voice}\n${stderr}`);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

function runNativeEdgeTTS({ text, voice, rate, pitch, outPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--voice", voice,
      "--rate", formatRate(rate),
      "--pitch", formatPitch(pitch),
      "--text", text,
      "--write-media", outPath,
    ];

    execFile("edge-tts", args, { maxBuffer: MAX_BUFFER, timeout: EDGE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[TTS ERROR native] voice=${voice}\n${stderr || err.message}`);
        if (err.code === "ENOENT") {
          return reject(new Error("edge-tts CLI not found on this host (pip install edge-tts)"));
        }
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
  });
}

function runDockerPiperTTS({ text, hostDir, containerDir, fileName }) {
  return new Promise((resolve, reject) => {
    const safeText = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$");

    const cmd = [
      `echo "${safeText}" |`,
      "docker run --rm -i",
      `-v "${PIPER_MODELS_DIR}:/models"`,
      `-v "${hostDir}:${containerDir}"`,
      PIPER_IMAGE,
      `--model /models/${PIPER_MODEL}`,
      `--output_file ${containerDir}/${fileName}`,
    ].join(" \\");

    exec(cmd, { maxBuffer: MAX_BUFFER, timeout: PIPER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error("[PIPER ERROR docker]", stderr);
        return reject(new Error(stderr || err.message));
      }
      resolve();
    });
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

// Unified entry: picks engine + backend. hostDir is the host folder mounted for
// docker runs (also the native output folder); containerDir is where that folder
// appears inside the container.
async function runTTS({ engine, text, voice, rate, pitch, hostDir, containerDir, fileName }) {
  if (engine === "edge") {
    if (TTS_BACKEND === "docker") {
      return runDockerEdgeTTS({ text, voice, rate, pitch, hostDir, containerDir, fileName });
    }
    return runNativeEdgeTTS({ text, voice, rate, pitch, outPath: path.join(hostDir, fileName) });
  }
  if (engine === "piper") {
    if (TTS_BACKEND === "docker") {
      return runDockerPiperTTS({ text, hostDir, containerDir, fileName });
    }
    return runNativePiperTTS({ text, outPath: path.join(hostDir, fileName) });
  }
  throw new Error("Invalid engine");
}

// ─────────────────────────────────────────────
//  ZIP HELPER
// ─────────────────────────────────────────────

function createZip(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// POST /tts
app.post("/tts", async (req, res) => {
  const {
    text,
    voice = "en-US-GuyNeural",
    rate = 1,
    pitch = 0,
    engine = "edge"
  } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  if (engine !== "edge" && engine !== "piper") {
    return res.status(400).json({ error: "Invalid engine — use 'edge' or 'piper'" });
  }

  if (!CAPABILITIES[engine]) {
    return res.status(503).json({
      error: `Engine '${engine}' is not available on this server (backend: ${TTS_BACKEND})`,
    });
  }

  const jobId      = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir     = path.join(OUTPUT_DIR, jobId);
  const zipPath    = path.join(__dirname, `${jobId}.zip`);
  const parts      = splitText(text);
  const wordCount  = text.trim().split(/\s+/).length;

  fs.mkdirSync(jobDir, { recursive: true });

  const job = {
    id:         jobId,
    status:     "processing",
    voice,
    engine,
    rate:       parseFloat(rate),
    pitch:      parseInt(pitch, 10),
    parts:      parts.length,
    wordCount,
    createdAt:  new Date().toISOString(),
    completedAt: null,
    file:       null,
    error:      null,
  };

  saveJob(job);
  res.json({ jobId, parts: parts.length, wordCount });

  setImmediate(async () => {
    try {
      for (let i = 0; i < parts.length; i++) {
        const base = `part_${String(i + 1).padStart(3, "0")}`;

        if (engine === "edge") {
          await runTTS({
            engine: "edge",
            text: parts[i],
            voice,
            rate,
            pitch,
            hostDir: jobDir,
            containerDir: "/app/output",
            fileName: `${base}.mp3`,
          });
        } else {
          await runTTS({
            engine: "piper",
            text: parts[i],
            hostDir: jobDir,
            containerDir: "/output",
            fileName: `${base}.wav`,
          });
        }

        job.status = `generating (${i + 1}/${parts.length})`;
        job.progress = Math.round(((i + 1) / parts.length) * 100);
        saveJob(job);
      }

      await createZip(jobDir, zipPath);
      fs.rmSync(jobDir, { recursive: true, force: true });

      job.status      = "done";
      job.file        = `${jobId}.zip`;
      job.completedAt = new Date().toISOString();
      job.progress    = 100;
      saveJob(job);

    } catch (err) {
      console.error(`[JOB ${jobId}] failed:`, err.message);
      job.status = "failed";
      job.error  = err.message;
      saveJob(job);
      if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  });
});

// GET /job/:id
app.get("/job/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// GET /jobs
app.get("/jobs", (req, res) => {
  const jobs = loadJobs().reverse();
  res.json(jobs);
});

// GET /download/:id
app.get("/download/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not ready", status: job.status });

  const filePath = path.join(__dirname, `${req.params.id}.zip`);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: "File no longer available" });
  }

  res.download(filePath, `tts-${req.params.id}.zip`);
});

// DELETE /job/:id
app.delete("/job/:id", (req, res) => {
  const jobs    = loadJobs();
  const job     = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });

  const zipPath = path.join(__dirname, `${req.params.id}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const updated = jobs.filter(j => j.id !== req.params.id);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(updated, null, 2));

  res.json({ deleted: req.params.id });
});

// POST /tts-preview — Edge only, streams MP3 directly
app.post("/tts-preview", (req, res) => {
  const {
    voice = "en-US-GuyNeural",
    text  = "This is a preview of your selected voice.",
    rate  = 1,
    pitch = 0,
  } = req.body;

  const fileName     = `preview-${Date.now()}.mp3`;
  const previewPath  = path.join(__dirname, fileName);

  runTTS({ engine: "edge", text, voice, rate, pitch, hostDir: __dirname, containerDir: "/app", fileName })
    .then(() => {
      if (!fs.existsSync(previewPath)) {
        return res.status(500).json({ error: "Preview file not written" });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", "inline; filename=preview.mp3");

      const stream = fs.createReadStream(previewPath);
      stream.pipe(res);
      stream.on("close", () => { fs.unlink(previewPath, () => {}); });
      stream.on("error", () => { fs.unlink(previewPath, () => {}); });
    })
    .catch((err) => {
      console.error("[PREVIEW ERROR]", err.message);
      res.status(500).json({ error: "Preview generation failed", detail: err.message });
    });
});

// POST /tts-preview-piper — Piper only, streams WAV directly
app.post("/tts-preview-piper", (req, res) => {
  const {
    voice = "en_US-lessac-medium",
    text  = "This is a preview of your selected Piper voice.",
  } = req.body;

  const fileName     = `preview-piper-${Date.now()}.wav`;
  const previewPath  = path.join(__dirname, fileName);

  runTTS({ engine: "piper", text, voice, hostDir: __dirname, containerDir: "/output", fileName })
    .then(() => {
      if (!fs.existsSync(previewPath)) {
        return res.status(500).json({ error: "Preview file not written" });
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Disposition", "inline; filename=preview.wav");

      const stream = fs.createReadStream(previewPath);
      stream.pipe(res);
      stream.on("close", () => { fs.unlink(previewPath, () => {}); });
      stream.on("error", () => { fs.unlink(previewPath, () => {}); });
    })
    .catch((err) => {
      console.error("[PIPER PREVIEW ERROR]", err.message);
      res.status(500).json({ error: "Piper preview generation failed", detail: err.message });
    });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({
    status:       "ok",
    uptime:       Math.round(process.uptime()),
    jobs:         loadJobs().length,
    time:         new Date().toISOString(),
    backend:      TTS_BACKEND,
    engines:      CAPABILITIES,
    authRequired: Boolean(API_KEY),
  });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TTS Studio server running → http://localhost:${PORT}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`TTS backend: ${TTS_BACKEND}${TTS_BACKEND === "native" ? ` (edge: ${CAPABILITIES.edge}, piper: ${CAPABILITIES.piper})` : ""}`);
  console.log(`API key: ${API_KEY ? "required" : "not set (open access)"}`);
});
