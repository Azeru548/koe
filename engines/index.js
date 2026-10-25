"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/index.js  (THE REGISTRY)
//
//  One place that answers "what engines exist?" and "give me engine X".
//  Everything that used to be a scattered `if (engine === "edge")` chain
//  resolves through here instead.
//
//    edge    Microsoft neural voices via the edge-tts CLI   (DEFAULT)
//    piper   offline Piper via the piper CLI
//    kokoro  Kokoro-82M via the fastkokoro sidecar over HTTP
//
//  google (engines/google.js) is a deliberate stub and is NOT registered,
//  so no HTTP route or MCP tool can select it.
//
//  Every adapter implements:
//    { name, ext, contentType,
//      synthesize({ text, voice, rate, pitch, signal, scratchDir })
//        -> Promise<{ bytes: Buffer, contentType: string }>,
//      listVoices({ lang } = {}) -> Promise<Array<voice>>,
//      healthy() -> Promise<boolean> }
// ─────────────────────────────────────────────────────────────

const edge = require("./edge");
const piper = require("./piper");
const kokoro = require("./kokoro");

// name -> adapter. Order is documentation only; selection is by name.
const REGISTRY = new Map([
  [edge.name, edge],
  [piper.name, piper],
  [kokoro.name, kokoro],
]);

// Accepted values for the `engine` parameter, in catalog order.
const ENGINE_NAMES = [...REGISTRY.keys()];

// Edge stays the default. KOE_DEFAULT_ENGINE may override it, but the
// deployment leaves it unset, so behaviour is unchanged from before.
const DEFAULT_ENGINE = (() => {
  const raw = String(process.env.KOE_DEFAULT_ENGINE || "").trim().toLowerCase();
  if (!raw) return "edge";
  if (REGISTRY.has(raw)) return raw;
  console.warn(`[engines] KOE_DEFAULT_ENGINE="${raw}" is not a registered engine — falling back to "edge"`);
  return "edge";
})();

function isRegistered(name) {
  return REGISTRY.has(String(name || ""));
}

function getEngine(name) {
  return REGISTRY.get(String(name || "")) || null;
}

// File/mime decisions, replacing every `engine === "piper" ? "wav" : "mp3"`
// ternary that used to be scattered across server.js and both MCP servers.
function extFor(name) {
  const e = getEngine(name);
  return e ? e.ext : "mp3";
}

function contentTypeFor(name) {
  const e = getEngine(name);
  return e ? e.contentType : "audio/mpeg";
}

// Health of every registered engine, for GET /healthz. Kokoro's is a live
// (cached) sidecar probe; edge and piper are their boot-time CLI probes.
async function healthSnapshot() {
  const out = {};
  for (const [name, engine] of REGISTRY) {
    try {
      out[name] = Boolean(await engine.healthy());
    } catch {
      out[name] = false;
    }
  }
  return out;
}

module.exports = {
  REGISTRY,
  ENGINE_NAMES,
  DEFAULT_ENGINE,
  isRegistered,
  getEngine,
  extFor,
  contentTypeFor,
  healthSnapshot,
};
