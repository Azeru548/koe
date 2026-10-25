"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — engines/google.js  (STUB — NOT REGISTERED)
//
//  Placeholder for Google Cloud Text-to-Speech (Chirp 3 HD), the likely
//  fourth engine. It deliberately does NOT appear in the registry in
//  engines/index.js, so no HTTP route, MCP tool or studio control can
//  ever select it. Registering it is a one-line change once the real
//  client exists.
//
//  WHERE IT PLUGS IN — the contract every engine implements:
//
//    name       "google"
//    synthesize({ text, voice, rate, pitch, signal })
//               -> Promise<{ bytes: Buffer, contentType: string }>
//    listVoices({ lang } = {})
//               -> Promise<Array<{ id, name, lang, gender?, style? }>>
//    healthy()  -> Promise<boolean>
//
//  Google's API returns audio bytes directly (like the Kokoro sidecar), so
//  this will fit the same shape as engines/kokoro.js rather than the CLI
//  shape of edge/piper: no scratch file, no shell-out, just an HTTP call.
// ─────────────────────────────────────────────────────────────

class NotImplementedError extends Error {
  constructor(what) {
    super(`Google Cloud TTS is not implemented yet: ${what}`);
    this.name = "NotImplementedError";
    this.code = "NOT_IMPLEMENTED";
  }
}

const notImplemented = (what) => () => Promise.reject(new NotImplementedError(what));

module.exports = {
  name: "google",
  ext: "mp3",
  contentType: "audio/mpeg",

  synthesize: notImplemented("synthesize()"),
  listVoices: notImplemented("listVoices()"),
  healthy: notImplemented("healthy()"),
};
