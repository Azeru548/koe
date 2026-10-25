"use strict";
// ─────────────────────────────────────────────────────────────
//  Kokoro engine unit tests.
//
//  A real `node:http` server on 127.0.0.1 plays the sidecar, so the connect
//  probe, fetch, retries and timeouts are all exercised for real — with no
//  external network and no Docker daemon.
// ─────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// These must be set BEFORE the module loads: the timeouts are read once.
// Production never sets them, so the real defaults stay 5s / 180s.
process.env.KOKORO_CONNECT_TIMEOUT_MS = "1500";
process.env.KOKORO_READ_TIMEOUT_MS = "400";
process.env.KOKORO_RETRY_BASE_MS = "10";
// A certainly-closed port, so the module-load voice warm-up fails fast
// instead of dialling a real sidecar.
process.env.KOKORO_BASE_URL = "http://127.0.0.1:1";

const kokoro = require("../engines/kokoro");
const { KOKORO_FALLBACK_VOICES } = require("../voices");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const portOf = (s) => s.address().port;
const useSidecar = (s) => { process.env.KOKORO_BASE_URL = `http://127.0.0.1:${portOf(s)}`; };

async function shutdown(server) {
  // A test that deliberately never answers would otherwise block close().
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

// Start a sidecar double that hands the parsed request to `handler`.
function sidecar(handler) {
  return startServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => handler({ req, res, raw, url: req.url }));
  });
}

// ── voices ───────────────────────────────────────────────────

test("listVoices: falls back to the built-in catalog when the sidecar is unreachable", async () => {
  // Deliberately FIRST: a successful fetch would populate the 60s cache and
  // this case would then never be observed.
  process.env.KOKORO_BASE_URL = "http://127.0.0.1:1";
  const voices = await kokoro.listVoices();

  assert.equal(voices.length, KOKORO_FALLBACK_VOICES.length, "every built-in voice is offered");
  assert.ok(voices.length >= 50, "the Kokoro catalog has 50+ voices");
  const heart = voices.find((v) => v.id === "af_heart");
  assert.ok(heart, "af_heart is present");
  assert.equal(heart.lang, "en-US", "locale is derived from the id prefix");
  assert.equal(heart.gender, "Female", "gender is derived from the id prefix");
  assert.ok(voices.every((v) => v.id && v.lang), "every entry has an id and a lang");
});

test("listVoices: fetches from the sidecar and derives metadata", async () => {
  const s = await sidecar(({ res }) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ voices: ["af_heart", "bm_george", "ff_siwis"] }));
  });
  useSidecar(s);
  try {
    const voices = await kokoro.loadVoices({ force: true });
    assert.deepEqual(voices.map((v) => v.id), ["af_heart", "bm_george", "ff_siwis"]);
    assert.equal(voices[1].lang, "en-GB");
    assert.equal(voices[1].gender, "Male");
    assert.equal(voices[2].lang, "fr-FR");
  } finally {
    await shutdown(s);
  }
});

test("listVoices: lang filter narrows the catalog", async () => {
  const voices = await kokoro.listVoices({ lang: "fr" });
  assert.ok(voices.length >= 1);
  assert.ok(voices.every((v) => v.lang.toLowerCase().startsWith("fr")));
});

// ── request mapping ──────────────────────────────────────────

test("buildRequestBody: maps rate to speed and never sends pitch", () => {
  const normal = kokoro.buildRequestBody({ text: "hi", voice: "af_heart", rate: 1, pitch: 0 });
  assert.equal(normal.model, "kokoro");
  assert.equal(normal.input, "hi");
  assert.equal(normal.voice, "af_heart");
  assert.equal(normal.response_format, "mp3", "MP3, so the job pipeline matches edge");
  assert.equal(normal.speed, undefined, "speed is omitted at 1.0 rather than forced");

  // The sidecar pydantic-validates speed to 1.0..2.0, so below 1.0 must clamp.
  assert.equal(kokoro.buildRequestBody({ text: "hi", voice: "af_heart", rate: 0.85, pitch: 0 }).speed, 1.0);
  assert.equal(kokoro.buildRequestBody({ text: "hi", voice: "af_heart", rate: 1.5, pitch: 0 }).speed, 1.5);
  assert.equal(kokoro.buildRequestBody({ text: "hi", voice: "af_heart", rate: 3, pitch: 0 }).speed, 2.0, "clamped at the top too");

  const pitched = kokoro.buildRequestBody({ text: "hi", voice: "af_heart", rate: 1, pitch: -15 });
  assert.ok(!("pitch" in pitched), "pitch is dropped, not forwarded");
});

// ── synthesis ────────────────────────────────────────────────

test("synthesize: success returns bytes and audio/mpeg", async () => {
  let received = null;
  let path = null;
  const s = await sidecar(({ res, raw, url }) => {
    received = JSON.parse(raw);
    path = url;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from("FAKE-MP3-BYTES"));
  });
  useSidecar(s);
  try {
    const out = await kokoro.synthesize({ text: "hello world", voice: "af_heart", rate: 1.1, pitch: 0 });

    assert.ok(Buffer.isBuffer(out.bytes), "bytes, not a file path");
    assert.equal(out.bytes.toString(), "FAKE-MP3-BYTES");
    assert.equal(out.contentType, "audio/mpeg");
    assert.equal(path, "/v1/audio/speech");
    assert.equal(received.model, "kokoro");
    assert.equal(received.input, "hello world");
    assert.equal(received.voice, "af_heart");
    assert.equal(received.speed, 1.1, "rate is mapped to speed");
  } finally {
    await shutdown(s);
  }
});

test("synthesize: sidecar 503 is retried twice, then fails", async () => {
  let hits = 0;
  const s = await sidecar(({ res }) => {
    hits += 1;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("upstream exploded");
  });
  useSidecar(s);
  try {
    await assert.rejects(
      () => kokoro.synthesize({ text: "hi", voice: "af_heart" }),
      (err) => /503/.test(err.message) && /upstream exploded/.test(err.message)
    );
    assert.equal(hits, 3, "the initial attempt plus exactly two retries");
  } finally {
    await shutdown(s);
  }
});

test("synthesize: a 4xx (unknown voice) is never retried", async () => {
  let hits = 0;
  const s = await sidecar(({ res }) => {
    hits += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown voice" }));
  });
  useSidecar(s);
  try {
    await assert.rejects(() => kokoro.synthesize({ text: "hi", voice: "not-a-kokoro-voice" }), /400/);
    assert.equal(hits, 1, "4xx means the request itself is wrong — no retries");
  } finally {
    await shutdown(s);
  }
});

test("synthesize: read timeout fails fast and is retried", async () => {
  let hits = 0;
  const s = await sidecar(({ res }) => {
    hits += 1;
    // never answer — the 400ms read deadline must fire
  });
  useSidecar(s);
  const started = Date.now();
  try {
    await assert.rejects(() => kokoro.synthesize({ text: "hi", voice: "af_heart" }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `should fail inside 5s, took ${elapsed}ms (3 x 400ms + backoff)`);
    assert.equal(hits, 3, "a read timeout is retryable");
  } finally {
    await shutdown(s);
  }
});

test("synthesize: connection refused fails cleanly instead of hanging", async () => {
  const probe = await startServer(() => {});
  const deadPort = portOf(probe);
  await shutdown(probe);
  process.env.KOKORO_BASE_URL = `http://127.0.0.1:${deadPort}`;

  const started = Date.now();
  await assert.rejects(() => kokoro.synthesize({ text: "hi", voice: "af_heart" }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `a dead sidecar must fail fast, took ${elapsed}ms`);
});

test("synthesize: honours an already-aborted caller signal", async () => {
  const s = await sidecar(() => { /* never answer */ });
  useSidecar(s);
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => kokoro.synthesize({ text: "hi", voice: "af_heart", signal: ctrl.signal }),
      /abort/i
    );
  } finally {
    await shutdown(s);
  }
});
