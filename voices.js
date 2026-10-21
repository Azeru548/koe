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

function voicesFor(engine) {
  return engine === "piper" ? PIPER_VOICES : EDGE_VOICES;
}

module.exports = { EDGE_VOICES, PIPER_VOICES, voicesFor };
