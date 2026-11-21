"use strict";
// Kitten TTS adapter tests. The sidecar is stubbed over HTTP — no model, no
// Python, no network — so this runs anywhere CI does.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { freePort } = require("./helpers");

const FAKE_WAV = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt fake-kitten-audio");

// Mutable stub: each test sets `stub.mode` / `stub.voices`.
const stub = {
  mode: "ok",       // ok | fail | bad-request
  voices: ["bella", "jasper"],
  hits: { health: 0, voices: 0, speech: 0 },
  lastBody: null,
};

function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        stub.hits.health += 1;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "healthy" }));
      }
      if (req.url === "/voices") {
        stub.hits.voices += 1;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ voices: stub.voices }));
      }
      if (req.url === "/synthesize" && req.method === "POST") {
        stub.hits.speech += 1;
        let raw = "";
        req.on("data", (d) => { raw += d; });
        req.on("end", () => {
          stub.lastBody = JSON.parse(raw || "{}");
          if (stub.mode === "fail") {
            res.writeHead(500, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: "model exploded" }));
          }
          if (stub.mode === "bad-request") {
            res.writeHead(400, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: "unknown voice" }));
          }
          res.writeHead(200, { "content-type": "audio/wav" });
          res.end(FAKE_WAV);
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let sidecar;
let deadPort;

function pointAt(url) {
  process.env.KITTEN_BASE_URL = url;
  kitten.resetVoices();
  kitten.resetHealth();
}

const kitten = require("../engines/kitten");

test.before(async () => {
  sidecar = await startStub();
  deadPort = await freePort(); // nothing is listening here
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
});

test.after(() => {
  if (sidecar) sidecar.close();
});

test("kitten is a registered engine that produces WAV", () => {
  const engines = require("../engines");
  assert.equal(engines.isRegistered("kitten"), true);
  assert.equal(engines.extFor("kitten"), "wav");
  assert.equal(engines.getEngine("kitten").contentType, "audio/wav");
  assert.deepEqual(engines.ENGINE_NAMES, ["edge", "piper", "kokoro", "kitten"]);
});

test("the built-in catalog is used while the sidecar is unreachable", async () => {
  pointAt(`http://127.0.0.1:${deadPort}`);
  const voices = await kitten.listVoices();
  assert.equal(voices.length, 8);
  assert.deepEqual(voices.map((v) => v.id), ["bella", "jasper", "luna", "bruno", "rosie", "hugo", "kiki", "leo"]);
  assert.equal(voices[0].lang, "en-US");
});

test("the sidecar's own voice list wins when it answers", async () => {
  stub.voices = ["bella", "custom_voice"];
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  const voices = await kitten.listVoices();
  assert.deepEqual(voices.map((v) => v.id), ["bella", "custom_voice"]);
  // A known id keeps its catalog metadata; an unknown one is passed through.
  assert.equal(voices[0].name, "Bella");
  assert.equal(voices[1].lang, "und");
  stub.voices = ["bella", "jasper"];
});

test("a locale filter only returns matching voices", async () => {
  pointAt(`http://127.0.0.1:${deadPort}`);
  assert.deepEqual((await kitten.listVoices({ lang: "en" })).length, 8);
  assert.deepEqual(await kitten.listVoices({ lang: "fr" }), []);
});

test("synthesize sends text, a lowercased voice and a clamped speed", async () => {
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  stub.mode = "ok";
  const out = await kitten.synthesize({ text: "Hello there.", voice: "BELLA", rate: 1.25 });
  assert.deepEqual(out.bytes, FAKE_WAV);
  assert.equal(out.contentType, "audio/wav");
  assert.deepEqual(stub.lastBody, { text: "Hello there.", voice: "bella", speed: 1.25 });

  await kitten.synthesize({ text: "Faster.", voice: "bella", rate: 3 });
  assert.equal(stub.lastBody.speed, 2, "rate above 2 is clamped, not forwarded");

  await kitten.synthesize({ text: "Default.", voice: "bella" });
  assert.equal("speed" in stub.lastBody, false, "rate 1 sends no speed at all");
});

test("a sidecar 500 is retried once and surfaces as one readable line", async () => {
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  stub.mode = "fail";
  const before = stub.hits.speech;
  await assert.rejects(
    () => kitten.synthesize({ text: "Boom.", voice: "bella" }),
    (err) => {
      assert.match(String(err.message), /Kitten sidecar returned 500/);
      assert.match(String(err.message), /model exploded/);
      assert.equal(err.retryable, true);
      return true;
    }
  );
  assert.equal(stub.hits.speech - before, 2, "500 is retryable: two attempts");
  stub.mode = "ok";
});

test("a 4xx is never retried — the request itself is wrong", async () => {
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  stub.mode = "bad-request";
  const before = stub.hits.speech;
  await assert.rejects(
    () => kitten.synthesize({ text: "Nope.", voice: "bella" }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(stub.hits.speech - before, 1);
  stub.mode = "ok";
});

test("an already-aborted job never reaches the sidecar", async () => {
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  const before = stub.hits.speech;
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => kitten.synthesize({ text: "Stop.", voice: "bella", signal: ctrl.signal }),
    (err) => err.reason === "aborted"
  );
  assert.equal(stub.hits.speech, before);
});

test("healthy() tracks the sidecar, cached for the TTL", async () => {
  pointAt(`http://127.0.0.1:${sidecar.address().port}`);
  assert.equal(await kitten.healthy(), true);

  pointAt(`http://127.0.0.1:${deadPort}`);
  assert.equal(await kitten.healthy(), false);

  // Stale-beats-unavailable: a cached 'true' is reused inside the TTL.
  process.env.KITTEN_BASE_URL = `http://127.0.0.1:${sidecar.address().port}`;
  kitten.resetHealth();
  assert.equal(await kitten.healthy(), true);
});

test("kitten ids never collide with another engine's", () => {
  const { KITTEN_VOICES, KOKORO_FALLBACK_VOICES, PIPER_VOICES, EDGE_VOICES } = require("../voices");
  const kittenIds = KITTEN_VOICES.map((v) => v.id);
  const others = new Set([
    ...KOKORO_FALLBACK_VOICES.map((v) => v.id),
    ...PIPER_VOICES.map((v) => v.id),
    ...EDGE_VOICES.map((v) => v.id),
  ]);
  assert.equal(kittenIds.some((id) => others.has(id)), false);
  assert.equal(new Set(kittenIds).size, kittenIds.length);
});
