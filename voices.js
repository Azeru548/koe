"use strict";
// ─────────────────────────────────────────────────────────────
//  Koe TTS Studio — voices.js
//
//  Curated voice catalog shared by the stdio MCP server (mcp/index.js)
//  and the hosted MCP endpoint (hosted-mcp.js). The `id` is what callers
//  pass as the `voice` argument; the server forwards it straight to
//  edge-tts, so any official Microsoft voice name also works.
// ─────────────────────────────────────────────────────────────

const EDGE_VOICES = [
  { id: "en-US-GuyNeural",       name: "Guy",       lang: "en-US", gender: "Male",   style: "News" },
  { id: "en-US-JennyNeural",     name: "Jenny",     lang: "en-US", gender: "Female", style: "Friendly" },
  { id: "en-US-AriaNeural",      name: "Aria",      lang: "en-US", gender: "Female", style: "Natural" },
  { id: "en-US-DavisNeural",     name: "Davis",     lang: "en-US", gender: "Male",   style: "Chat" },
  { id: "en-US-AndrewNeural",    name: "Andrew",    lang: "en-US", gender: "Male",   style: "Warm" },
  { id: "en-US-EmmaNeural",      name: "Emma",      lang: "en-US", gender: "Female", style: "Conversational" },
  { id: "en-GB-RyanNeural",      name: "Ryan",      lang: "en-GB", gender: "Male",   style: "Chat" },
  { id: "en-GB-SoniaNeural",     name: "Sonia",     lang: "en-GB", gender: "Female", style: "Formal" },
  { id: "en-GB-LibbyNeural",     name: "Libby",     lang: "en-GB", gender: "Female", style: "Conversational" },
  { id: "en-AU-NatashaNeural",   name: "Natasha",   lang: "en-AU", gender: "Female", style: "Natural" },
  { id: "en-AU-WilliamNeural",   name: "William",   lang: "en-AU", gender: "Male",   style: "Natural" },
  { id: "en-CA-ClaraNeural",     name: "Clara",     lang: "en-CA", gender: "Female", style: "Natural" },
  { id: "en-IN-NeerjaNeural",    name: "Neerja",    lang: "en-IN", gender: "Female", style: "Friendly" },
  { id: "es-ES-ElviraNeural",    name: "Elvira",    lang: "es-ES", gender: "Female", style: "Warm" },
  { id: "es-MX-DaliaNeural",     name: "Dalia",     lang: "es-MX", gender: "Female", style: "Friendly" },
  { id: "es-US-PalomaNeural",    name: "Paloma",    lang: "es-US", gender: "Female", style: "Casual" },
  { id: "fr-FR-DeniseNeural",    name: "Denise",    lang: "fr-FR", gender: "Female", style: "Elegant" },
  { id: "fr-CA-SylvieNeural",    name: "Sylvie",    lang: "fr-CA", gender: "Female", style: "Friendly" },
  { id: "de-DE-KatjaNeural",     name: "Katja",     lang: "de-DE", gender: "Female", style: "Professional" },
  { id: "de-DE-ConradNeural",    name: "Conrad",    lang: "de-DE", gender: "Male",   style: "Professional" },
  { id: "it-IT-ElsaNeural",      name: "Elsa",      lang: "it-IT", gender: "Female", style: "Warm" },
  { id: "pt-BR-FranciscaNeural", name: "Francisca", lang: "pt-BR", gender: "Female", style: "Calm" },
  { id: "pt-PT-RaquelNeural",    name: "Raquel",    lang: "pt-PT", gender: "Female", style: "Warm" },
  { id: "zh-CN-XiaoxiaoNeural",  name: "Xiaoxiao",  lang: "zh-CN", gender: "Female", style: "Warm" },
  { id: "zh-CN-YunxiNeural",     name: "Yunxi",     lang: "zh-CN", gender: "Male",   style: "Lively" },
  { id: "ja-JP-NanamiNeural",    name: "Nanami",    lang: "ja-JP", gender: "Female", style: "Polite" },
  { id: "ko-KR-SunHiNeural",     name: "Sun-Hi",    lang: "ko-KR", gender: "Female", style: "Bright" },
  { id: "ar-SA-ZariyahNeural",   name: "Zariyah",   lang: "ar-SA", gender: "Female", style: "Natural" },
  { id: "hi-IN-SwaraNeural",     name: "Swara",     lang: "hi-IN", gender: "Female", style: "Friendly" },
];

const PIPER_VOICES = [
  { id: "en_US-lessac-medium", name: "Lessac", lang: "en-US", gender: "Male", style: "Natural" },
];

// ── Kokoro ─────────────────────────────────────────────────────
// Kokoro ids look like `af_heart`: first letter is the locale, second is the
// gender. These are the ids fastkokoro serves from GET /v1/audio/voices; the
// list below is only the FALLBACK used when the sidecar cannot be reached.
const KOKORO_LOCALES = {
  a: "en-US", // American English
  b: "en-GB", // British English
  j: "ja-JP",
  z: "zh-CN",
  e: "es-ES",
  f: "fr-FR",
  h: "hi-IN",
  i: "it-IT",
  p: "pt-BR",
};

// Built-in fallback catalog (fastkokoro 0.7 README). Used only when the
// sidecar's /v1/audio/voices cannot be fetched — see engines/kokoro.js.
const KOKORO_FALLBACK_VOICES = [
  // American English (en-us)
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
  // British English (en-gb)
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  // Japanese (ja-jp)
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  // Mandarin Chinese (zh-cn)
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
  // Spanish (es-es)
  "ef_dora", "em_alex", "em_santa",
  // French (fr-fr)
  "ff_siwis",
  // Hindi (hi-in)
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  // Italian (it-it)
  "if_sara", "im_nicola",
  // Brazilian Portuguese (pt-br)
  "pf_dora", "pm_alex", "pm_santa",
].map((id) => ({ id, name: id, lang: KOKORO_LOCALES[id[0]] || "und", gender: id[1] === "f" ? "Female" : id[1] === "m" ? "Male" : undefined }));

// Turn a raw sidecar voice id into the same shape as the other catalogs.
// Unknown shapes are passed through untouched — never renamed or aliased.
function describeKokoroVoice(id) {
  const s = String(id || "");
  return {
    id: s,
    name: s,
    lang: KOKORO_LOCALES[s[0]] || "und",
    gender: s[1] === "f" ? "Female" : s[1] === "m" ? "Male" : undefined,
  };
}

// True when `voice` belongs to this engine's catalog. Used to reject a voice
// id from a DIFFERENT engine rather than silently aliasing it across.
function isKokoroVoice(voice, knownIds) {
  const list = knownIds || KOKORO_FALLBACK_VOICES.map((v) => v.id);
  return list.includes(String(voice || ""));
}

function voicesFor(engine) {
  // NOTE: unknown engines fall through to EDGE_VOICES — pre-existing
  // behaviour, kept deliberately so nothing changes for edge callers.
  return engine === "piper" ? PIPER_VOICES : EDGE_VOICES;
}

module.exports = {
  EDGE_VOICES,
  PIPER_VOICES,
  KOKORO_FALLBACK_VOICES,
  KOKORO_LOCALES,
  voicesFor,
  describeKokoroVoice,
  isKokoroVoice,
};
