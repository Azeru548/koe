"use strict";
// Shared helpers for the HTTP test suites: proof-of-work solving, key minting,
// and starting a real studio (server.js) against an isolated database.
// (Not a test file — it is not listed in `npm test`.)

const { spawn } = require("node:child_process");
const crypto = require("crypto");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sha256(challenge + nonce) must start with `zeros` '0' hex chars.
function solvePow(challenge, zeros = 4) {
  const target = "0".repeat(zeros);
  for (let i = 0; i < 5_000_000; i++) {
    const nonce = i.toString(16).padStart(4, "0");
    const hash = crypto.createHash("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hash.startsWith(target)) return nonce;
  }
  throw new Error("proof-of-work did not converge");
}

async function json(base, pathname, { method = "GET", key, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// GET /keys/challenge, solve the PoW, POST /keys → { status, data }.
async function mintKey(base) {
  const ch = await json(base, "/keys/challenge");
  if (ch.status !== 200 || !ch.data.challenge) {
    return { status: ch.status, data: ch.data };
  }
  const nonce = solvePow(ch.data.challenge, (ch.data.pow && ch.data.pow.leadingZeroHexChars) || 4);
  return json(base, "/keys", { method: "POST", body: { challenge: ch.data.challenge, nonce } });
}

// A port the OS just handed out. It is released before the child binds it, so a
// parallel suite can take it; startStudio retries on that rather than failing.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Kill a spawned studio and wait for it to be gone, so the next suite does not
// inherit a process still holding CPU or its output directory.
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    child.kill();
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 3000);
    if (timer.unref) timer.unref();
  });
}

/**
 * Spawn server.js on a free port and wait until it answers `readyPath`.
 *
 * Every HTTP suite starts its own server, and `npm test` runs those files in
 * parallel — each one booting a process that opens SQLite and starts worker
 * loops. On a loaded machine that can take tens of seconds, so the budget is
 * generous and polled at 100ms instead of a fixed sleep.
 *
 * Two distinct failures are handled differently:
 *   • the child exits before answering → the freePort() hand-off lost a race (or
 *     the port was taken): report its output and retry once on a fresh port;
 *   • the deadline passes → report the child's own output and fail, because a
 *     retry under the same load only repeats the wait.
 *
 * @returns {Promise<{base, port, child, logs: () => string, stop: () => Promise<void>}>}
 */
async function startStudio({ env = {}, readyPath = "/healthz", timeoutMs = 90000, attempts = 2 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let output = "";

    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: { ...process.env, TTS_BACKEND: "native", PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });

    const logs = () => output;
    let exitCode = null;
    child.once("exit", (code, signal) => { exitCode = code === null ? signal : code; });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && exitCode === null) {
      try {
        const res = await fetch(`${base}${readyPath}`);
        if (res.ok) return { base, port, child, logs, stop: () => stop(child) };
      } catch { /* not listening yet */ }
      await sleep(100);
    }

    await stop(child);
    if (exitCode === null) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${base}${readyPath}\n${logs()}`);
    }
    lastError = new Error(
      `server.js exited (${exitCode}) before answering ${base}${readyPath} — ` +
      `the port may have been taken; retrying on a fresh one.\n${logs()}`
    );
  }

  throw lastError || new Error("server.js did not start");
}

module.exports = { solvePow, json, mintKey, freePort, stop, startStudio, ROOT };
