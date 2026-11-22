// stats.js — global traffic counters + the operator's /stats dashboard
//
// Wire-up (server.js):
//   const stats = require("./stats");
//   app.use((req, res, next) => { stats.observe(req); next(); });
//   // after a successful guard.charge(...) in /tts and /tts-preview:
//   stats.markWords({ subject, words });
//
// Design: counters survive restarts via .koe-stats.json (written ~every 60 s).
// Visitor identities are subject ids from the same scheme as guard.js
// ("key:<tid>" / "anon:<hash>" / "admin") — never raw IPs, never raw content,
// never heard audio. The anonymous id is the guard's keyed HMAC so request and
// word accounting stay attached to the same subject.

const fs = require("fs");
const path = require("path");
const guard = require("./guard");

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;
const STORE = process.env.KOE_STATS_FILE || path.join(__dirname, ".koe-stats.json");

// ── persisted store ─────────────────────────────────────────
const BUCKETS = {
  requests: 0, tts: 0, previews: 0, downloads: 0, registers: 0, mcp: 0, words: 0,
  pageviews: 0, bots: 0,
};

let store = { allTime: { ...BUCKETS }, days: {}, visitors: {}, paths: {}, engines: {} };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(STORE, "utf8"))); } catch { /* first boot */ }
store.allTime  = { ...BUCKETS, ...store.allTime  };
store.days     = (store.days && typeof store.days === "object") ? store.days : {};
store.visitors = (store.visitors && typeof store.visitors === "object") ? store.visitors : {};
store.paths    = (store.paths && typeof store.paths === "object") ? store.paths : {};
store.engines  = (store.engines && typeof store.engines === "object") ? store.engines : {};

let dirty = false;

function savePersisted() {
  try {
    const tmp = `${STORE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE);
  } catch { /* best effort — in-memory stays valid this uptime */ }
}

// Older builds stored anonymous visitors as "anon:<raw IP>". Re-key those
// records through the guard's HMAC and merge any matching hashed record.
// This runs once on load so a persisted store cannot keep leaking raw IPs.
function migrateVisitorIds() {
  let changed = false;
  for (const [id, old] of Object.entries(store.visitors)) {
    if (!id.startsWith("anon:")) continue;
    const value = id.slice("anon:".length);
    if (!value.includes(".") && !value.includes(":")) continue; // already a hash
    const next = guard.anonSubject(value);
    const cur = store.visitors[next] || { last: 0, requests: 0, words: 0, actions: 0 };
    cur.last = Math.max(Number(cur.last) || 0, Number(old.last) || 0);
    cur.requests = (Number(cur.requests) || 0) + (Number(old.requests) || 0);
    cur.words = (Number(cur.words) || 0) + (Number(old.words) || 0);
    cur.actions = (Number(cur.actions) || 0) + (Number(old.actions) || 0);
    const actionAt = Number(old.lastAction) || (Number(old.words) > 0 ? Number(old.last) || 0 : 0);
    if (actionAt) cur.lastAction = Math.max(Number(cur.lastAction) || 0, actionAt);
    store.visitors[next] = cur;
    delete store.visitors[id];
    changed = true;
  }
  if (changed) {
    dirty = true;
    savePersisted();
  }
}

migrateVisitorIds();

setInterval(() => { if (dirty) { dirty = false; savePersisted(); } }, 60 * 1000).unref?.();
process.on("SIGTERM", () => savePersisted());
process.on("SIGINT",  () => savePersisted());

function pruneOld(now) {
  const cutoff = new Date(now - 36 * DAY).toISOString().slice(0, 10);
  for (const d of Object.keys(store.days)) if (d < cutoff) delete store.days[d];
  for (const id of Object.keys(store.visitors)) {
    try { if (now - store.visitors[id].last > DAY) delete store.visitors[id]; } catch { delete store.visitors[id]; }
  }
}

function dayBucket(now) {
  pruneOld(now);
  const k = new Date(now).toISOString().slice(0, 10);
  const prev = store.days[k] || {};
  store.days[k] = {
    ...BUCKETS, ...prev,
    paths: prev.paths || {},
    engines: prev.engines || {},
  };
  return store.days[k];
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// ── observation ─────────────────────────────────────────────
function pathKind(method, p) {
  if (p === "/tts") return "tts";
  if (p === "/tts-preview" || p === "/tts-preview-piper") return "previews";
  if (p.startsWith("/download/") || p.startsWith("/audio/")) return "downloads";
  // `/keys` is the canonical mint; `/api/register` is its legacy alias, and a
  // mint on either path is a registration.
  if (p === "/keys" || p === "/api/register") return "registers";
  if (p === "/mcp" && method === "POST") return "mcp";
  return null; // plain requests: counted in total only
}

function subjectOf(req) {
  if (!req.ctx) return "anon:unknown";
  if (req.ctx.admin) return "admin";
  if (req.ctx.tid) return `key:${req.ctx.tid}`;
  return guard.anonSubject(req.ctx.ip);
}

// System noise is not user traffic and is never counted:
//   • /health probes (the watchdog pings it every 2 min; rebuild loops too)
//   • the dashboard measuring itself (/stats, /stats.html, /stats.json polls)
//   • requests from private/loopback sources — the box talking to itself
//     (127.0.0.1, the Docker bridge 172.17.x, RFC1918, link-local, ::1)
// Operator (admin) and keyed-user requests are real humans and DO count.
const PRIVATE_IP_RE = /^(::ffff:)?(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$/;

// Static assets create visitors in every crawler run without describing a
// person. Count them in the raw HTTP total, but never as a visitor.
const ASSET_PATHS = new Set(["/favicon-32.png", "/apple-touch-icon.png", "/logo-mark.png"]);
function isAsset(p) {
  return ASSET_PATHS.has(p) || p.startsWith("/mcp-sample-");
}

function isSystemNoise(req) {
  if (!req.ctx) return true;
  // health probes + the dashboard measuring itself (polls every 15 s while
  // someone watches it — that's measurement, not usage)
  if (req.path === "/health" || req.path === "/stats" || req.path === "/stats.html" || req.path === "/stats.json") return true;
  if (req.ctx.admin || req.ctx.tid) return false;
  return PRIVATE_IP_RE.test(String(req.ctx.ip || ""));
}

// ── page views, bots, funnel ───────────────────────────────
// The four HTML documents the product serves. A page view is one GET of one of
// them by a browser — not an API call, not an asset, not a health probe.
const PAGE_PATHS = new Set(["/", "/mcp", "/docs", "/studio"]);

function wantsHtml(req) {
  return String((req.headers && req.headers.accept) || "").includes("text/html");
}

function isPageView(req) {
  if (req.method !== "GET" || !PAGE_PATHS.has(req.path)) return false;
  // `GET /mcp` without an HTML Accept is the plain-text MCP hint, not a page.
  return req.path !== "/mcp" || wantsHtml(req);
}

// Crawlers hit the same pages as people and would otherwise inflate the
// funnel. Only page views are classified, so a bot posting /tts can never be
// mistaken for a visitor, and an absent UA is never a bot.
const BOT_UA_RE = /(bot\b|crawler|spider|slurp|bingpreview|facebookexternalhit|applebot|petalbot|semrush|ahrefs|mj12|ccbot|gptbot|claudebot|perplexity|headlesschrome|phantomjs|python-requests|curl\/|wget|go-http-client|libwww|lighthouse|uptime|pingdom|statuscake|betteruptime|monitoring)/i;

function isBotPageView(req) {
  if (!isPageView(req)) return false;
  const ua = String((req.headers && req.headers["user-agent"]) || "");
  return ua ? BOT_UA_RE.test(ua) : false;
}

// Funnel stages, in order. Each visitor keeps the first timestamp it reached
// each one, so the funnel can be read as a cohort rather than as counters that
// double-count a refresh.
const STAGES = ["visited", "setup", "keyed", "generated", "downloaded"];

function markStage(v, stage, now) {
  if (!v.stages) v.stages = {};
  if (!v.stages[stage]) v.stages[stage] = now;
}

function stageFor(pathname, kind) {
  if (kind === "registers") return "keyed";
  if (kind === "tts") return "generated";
  if (kind === "downloads") return "downloaded";
  return null;
}

// `rejected` marks a request the guard/auth layer refused before the normal
// counter is mounted. It is still a real HTTP hit and a visitor, but it must
// never count as a voiceover/MCP action (a forged key is not a product user).
function observe(req, { rejected = false } = {}) {
  if (isSystemNoise(req)) return;
  const now = Date.now();
  const kind = rejected ? null : pathKind(req.method, req.path);
  const page = !rejected && isPageView(req);

  store.allTime.requests++;
  const d = dayBucket(now);
  d.requests++;

  if (!rejected && isBotPageView(req)) {
    store.allTime.bots++;
    d.bots++;
    dirty = true;
    return; // a crawl is traffic, not a visitor
  }

  if (kind) { store.allTime[kind] = (store.allTime[kind] || 0) + 1; d[kind] = (d[kind] || 0) + 1; }

  if (page) {
    store.allTime.pageviews++;
    d.pageviews++;
    store.paths[req.path] = (store.paths[req.path] || 0) + 1;
    d.paths[req.path] = (d.paths[req.path] || 0) + 1;
  }

  if (isAsset(req.path)) { dirty = true; return; }

  const sid = subjectOf(req);
  const v = store.visitors[sid] || { last: 0, requests: 0, words: 0, actions: 0 };
  v.last = now;
  v.first = v.first || now;
  v.requests++;

  // Distinct days seen, capped — this is what makes "daily active visitors"
  // and "came back" cheap to compute without storing per-day subject sets.
  const day = dayKey(now);
  if (!Array.isArray(v.dayList)) v.dayList = [];
  if (!v.dayList.includes(day)) {
    v.dayList.push(day);
    if (v.dayList.length > 21) v.dayList = v.dayList.slice(-21);
  }

  if (page) {
    markStage(v, "visited", now);
    if (req.path === "/mcp" || req.path === "/docs") markStage(v, "setup", now);
  }
  const stage = rejected ? null : stageFor(req.path, kind);
  if (stage) markStage(v, stage, now);

  if (kind) {
    v.actions = (v.actions || 0) + 1;
    v.lastAction = now;
  }
  store.visitors[sid] = v;

  dirty = true;
}

function markWords({ subject, words = 0, engine = null }) {
  const sid = (subject && subject.id) || "admin";
  const now = Date.now();
  const v = store.visitors[sid] || { last: now, requests: 0, words: 0, actions: 0 };
  v.last = now;
  if (words > 0) v.lastAction = now;
  v.words += words;
  store.visitors[sid] = v;
  store.allTime.words += words;
  const d = dayBucket(now);
  d.words += words;
  if (engine) {
    store.engines[engine] = (store.engines[engine] || 0) + 1;
    d.engines[engine] = (d.engines[engine] || 0) + 1;
  }
  dirty = true;
}

// ── queries ─────────────────────────────────────────────────
function uniquesForDay(day) {
  let n = 0;
  for (const [id, v] of Object.entries(store.visitors)) {
    if (id === "admin") continue;
    if (Array.isArray(v.dayList) && v.dayList.includes(day)) n++;
  }
  return n;
}

function uniquesInLastDays(days) {
  const cutoff = dayKey(Date.now() - (days - 1) * DAY);
  let n = 0;
  for (const [id, v] of Object.entries(store.visitors)) {
    if (id === "admin") continue;
    if (Array.isArray(v.dayList) && v.dayList.some((d) => d >= cutoff)) n++;
  }
  return n;
}

// Cohort funnel: each subject contributes at most once per stage, so someone
// refreshing the setup page five times still reads as one person.
function funnel() {
  const counts = {};
  for (const s of STAGES) counts[s] = 0;
  for (const [id, v] of Object.entries(store.visitors)) {
    if (id === "admin" || id === "anon:unknown") continue;
    if (!v.stages) continue;
    for (const s of STAGES) if (v.stages[s]) counts[s]++;
  }
  return counts;
}

function daySum(fromDaysAgo, toDaysAgo = 0, field = "tts") {
  let sum = 0;
  for (let i = fromDaysAgo; i >= toDaysAgo; i--) {
    const b = store.days[dayKey(Date.now() - i * DAY)];
    if (b) sum += Number(b[field]) || 0;
  }
  return sum;
}

// Signals are the "so what" layer: every one is derived from the counters
// above, never invented, and says what changed rather than restating a number.
function signals(q) {
  const a = q.allTime;
  const out = [];
  const rate = (num, den) => (den > 0 ? num / den : null);
  const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

  const usage = rate(a.tts, a.pageviews);
  out.push({
    key: "usage",
    level: usage == null ? "warn" : usage >= 0.15 ? "ok" : usage >= 0.05 ? "warn" : "bad",
    headline: usage == null ? "No page views recorded yet" : `${pct(usage)} of page views become a voiceover`,
    detail: usage == null
      ? "Page and funnel data starts filling in once this build is live."
      : `${a.tts} jobs from ${a.pageviews} page views — ${usage < 0.1 ? "most visitors read without trying it" : "traffic is turning into generation"}.`,
    value: usage == null ? null : Number((usage * 100).toFixed(1)),
  });

  const jobSize = rate(a.words, a.tts);
  out.push({
    key: "job-size",
    level: jobSize == null ? "warn" : jobSize >= 150 ? "ok" : jobSize >= 40 ? "warn" : "bad",
    headline: jobSize == null ? "No voiceovers yet" : `Average job is ${Math.round(jobSize)} words`,
    detail: jobSize == null
      ? "Nothing to size yet."
      : jobSize < 40
        ? "Test sentences, not narration — nobody is using this for a real video yet."
        : jobSize < 150
          ? "Short clips: people are experimenting, not producing."
          : "Real scripts: jobs are sized like actual voiceover work.",
    value: jobSize == null ? null : Math.round(jobSize),
  });

  const dl = rate(a.downloads, a.tts);
  out.push({
    key: "download-rate",
    level: dl == null ? "warn" : dl >= 0.7 ? "ok" : dl >= 0.4 ? "warn" : "bad",
    headline: dl == null ? "No audio generated yet" : `${pct(dl, 0)} of generated audio was downloaded`,
    detail: dl == null
      ? "Nothing generated."
      : dl >= 0.7
        ? "People who generate keep the file — the core loop works."
        : "Audio is generated but never fetched, which usually means a broken client.",
    value: dl == null ? null : Math.round(dl * 100),
  });

  const keyed = Number(a.registers) || 0;
  const generatedKeys = Object.entries(store.visitors)
    .filter(([id, v]) => id.startsWith("key:") && v.stages && v.stages.generated).length;
  // Stages only exist from the build that added them, so keys minted before it
  // cannot be placed in the funnel. Saying "0% converted" would be a lie about
  // the product instead of a limit of the instrumentation.
  const measured = Object.values(store.visitors).some((v) => v.stages && Object.keys(v.stages).length);
  const conv = measured && keyed > 0 ? generatedKeys / keyed : null;
  out.push({
    key: "key-to-job",
    level: conv == null ? "warn" : conv >= 0.5 ? "ok" : conv >= 0.25 ? "warn" : "bad",
    headline: conv == null
      ? (keyed > 0 ? `${keyed} keys minted before stage tracking` : "No keys minted yet")
      : `${pct(conv, 0)} of free keys ever generated audio`,
    detail: conv == null
      ? (keyed > 0
        ? "Funnel stages start recording with this build; older keys count but cannot be placed in it."
        : "Nobody has completed setup.")
      : `${generatedKeys} of ${keyed} keys produced at least one job.`,
    value: conv == null ? null : Math.round(conv * 100),
  });

  const seen = Object.entries(store.visitors).filter(([id, v]) => id !== "admin" && Array.isArray(v.dayList) && v.dayList.length);
  const returning = seen.filter(([, v]) => v.dayList.length > 1).length;
  const ret = rate(returning, seen.length);
  out.push({
    key: "return-rate",
    level: ret == null ? "warn" : ret >= 0.2 ? "ok" : ret >= 0.08 ? "warn" : "bad",
    headline: ret == null ? "No visitor history yet" : `${returning} of ${seen.length} visitors came back another day`,
    detail: ret == null
      ? "Nothing to measure."
      : ret < 0.1
        ? "Effectively a one-visit product — nothing here asks someone to return."
        : "A repeat audience exists.",
    value: ret == null ? null : Math.round(ret * 100),
  });

  const last3 = daySum(0, 0) + daySum(1, 1) + daySum(2, 2);
  const prev3 = daySum(3, 3) + daySum(4, 4) + daySum(5, 5);
  const delta = prev3 > 0 ? (last3 - prev3) / prev3 : null;
  out.push({
    key: "momentum",
    level: last3 === 0 ? "bad" : delta == null ? "warn" : delta >= 0 ? "ok" : "warn",
    headline: `Last 3 days: ${last3} jobs (previous 3: ${prev3})`,
    detail: last3 === 0
      ? "No voiceovers generated in three days — usage has stopped, not slowed."
      : delta == null
        ? "No earlier window to compare against."
        : `${delta >= 0 ? "Up" : "Down"} ${Math.abs(Math.round(delta * 100))}% versus the previous three days.`,
    value: last3,
  });

  out.push({
    key: "bots",
    level: a.requests && (a.bots / a.requests) > 0.5 ? "warn" : "ok",
    headline: `${a.bots || 0} crawler page views excluded`,
    detail: `Out of ${a.requests || 0} HTTP hits. Crawlers count as traffic but never as visitors or funnel stages.`,
    value: a.bots || 0,
  });

  return out;
}

function query() {
  const now = Date.now();
  const f = funnel();
  const out = {
    allTime: { ...store.allTime },
    today: { ...store.days[dayKey(now)] || BUCKETS },
    windows: {},
    funnel: f,
    paths: Object.entries(store.paths)
      .map(([path, views]) => ({ path, views }))
      .sort((x, y) => y.views - x.views),
    engines: { ...store.engines },
    uniques: {
      today: uniquesForDay(dayKey(now)),
      yesterday: uniquesForDay(dayKey(now - DAY)),
      d7: uniquesInLastDays(7),
      d14: uniquesInLastDays(14),
    },
  };
  for (const w of [[5, "5m"], [60, "1h"], [24 * 60, "24h"]]) {
    const cutoff = now - w[0] * 60 * 1000;
    let visitors = 0;
    let users = 0;
    for (const v of Object.values(store.visitors)) {
      if (v.last >= cutoff) visitors++;
      // Product user = someone who actually generated, previewed, downloaded,
      // registered, or called MCP inside the window. A crawler hitting a page
      // is a visitor, not a user.
      if (v.lastAction && v.lastAction >= cutoff) users++;
    }
    out.windows[w[1]] = { users, visitors };
  }
  out.signals = signals(out);
  return out;
}

function topSubjects(limit = 10, by = "words") {
  const arr = Object.entries(store.visitors).map(([id, v]) => ({ id, ...v }));
  arr.sort((a, b) => {
    const primary = by === "requests"
      ? (b.requests || 0) - (a.requests || 0)
      : (b.words || 0) - (a.words || 0);
    return primary || (b.requests || 0) - (a.requests || 0) || (b.words || 0) - (a.words || 0);
  });
  return arr.slice(0, limit);
}

function subjectLabel(id) {
  if (id === "admin") return "Operator";
  if (id === "anon:unknown") return "Unknown visitor";
  if (id.startsWith("key:")) return `Key ${id.slice(4, 10)}`;
  if (id.startsWith("anon:")) return `Visitor ${id.slice(5, 11)}`;
  return String(id);
}

function renderPage(extra = {}) {
  const q = query();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cell = (k) => `<td class="n">${esc(q.allTime[k] ?? 0)}</td><td class="n">${esc(q.today[k] ?? 0)}</td>`;
  const ago = (ts) => {
    const sec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  };
  const rows = (list, empty) => {
    const out = list.map((s, i) =>
      `<tr><td class="num">${i + 1}</td><td>${esc(subjectLabel(s.id))}</td><td class="n">${esc(s.requests || 0)}</td><td class="n">${esc(s.words || 0)}</td><td class="n muted">${esc(ago(s.last))}</td></tr>`).join("");
    return out || `<tr><td colspan="5" class="empty">${esc(empty)}</td></tr>`;
  };
  const topWords = topSubjects(10, "words");
  const topRequests = topSubjects(8, "requests");
  const days = Object.entries(store.days).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14).map(([day, d]) =>
    `<tr><td class="mono">${esc(day)}</td><td class="n">${esc(d.requests)}</td><td class="n">${esc(d.tts)}</td><td class="n">${esc(d.downloads)}</td><td class="n">${esc(d.registers)}</td><td class="n">${esc(d.words)}</td></tr>`).join("");
  const uptime = extra.uptimeSec ? `${Math.floor(extra.uptimeSec / 3600)}h ${Math.floor((extra.uptimeSec % 3600) / 60)}m` : "?";
  const statuses = extra.byStatus && Object.keys(extra.byStatus).length
    ? Object.entries(extra.byStatus).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(" · ")
    : "none";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#f2f0e9">
<meta http-equiv="refresh" content="30"><title>Koe — operator stats</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --paper:#f2f0e9; --sheet:#fbfaf5; --sheet2:#f6f3ea; --ink:#181613; --ink2:#3b372f; --muted:#6d675c; --line:#d8d2c4; --line2:#c3baa8; --accent:#b23a2b; --accent-soft:#f3e2dc; --success:#2f6b4f; --font:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif; --display:'Source Serif 4',Georgia,serif; --mono:'DM Mono','Fira Mono',monospace; }
  * { box-sizing:border-box; } body { margin:0; background:var(--paper); color:var(--ink2); font:13px/1.5 var(--font); }
  a { color:var(--ink2); text-underline-offset:3px; } a:hover { color:var(--accent); }
  .topbar { height:56px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 22px; border-bottom:1px solid var(--line); background:var(--paper); }
  .brand { display:flex; align-items:center; gap:10px; } .brand img { width:20px; height:26px; } .wordmark { font-weight:600; color:var(--ink); letter-spacing:-.02em; font-size:15px; }
  .rule { width:1px; height:18px; background:var(--line2); } .workspace { font:11px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
  .topbar nav { display:flex; align-items:center; gap:16px; font-size:12px; }
  .wrap { max-width:1000px; margin:0 auto; padding:32px 22px 64px; }
  h1 { margin:0; color:var(--ink); font:500 34px/1.15 var(--display,Georgia,serif); letter-spacing:-.02em; }
  .sub { margin:7px 0 0; color:var(--muted); font-size:12px; }
  h2 { margin:0 0 10px; font:600 11px/1.2 var(--mono); letter-spacing:.13em; text-transform:uppercase; color:var(--ink); }
  section { margin-top:30px; } .readout { display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--line2); border-bottom:1px solid var(--line2); margin-top:28px; }
  .readout div { padding:14px 16px; border-right:1px solid var(--line); } .readout div:last-child { border-right:0; }
  .readout b { display:block; font:500 26px/1 var(--mono); color:var(--ink); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
  .readout span { display:block; margin-top:7px; font:11px/1.2 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  table { width:100%; border-collapse:collapse; } th { padding:8px 10px; border-bottom:1px solid var(--line2); text-align:left; font:500 11px/1.2 var(--mono); letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
  td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; } tr:hover td { background:var(--sheet2); }
  .n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; } .num { color:var(--muted); width:32px; } .mono { font-family:var(--mono); font-size:12px; }
  .muted { color:var(--muted); } .empty { color:var(--muted); font-style:italic; } .split { display:grid; grid-template-columns:1fr 1fr; gap:30px; }
  .note { margin:10px 0 0; color:var(--muted); font-size:12px; } footer { margin-top:34px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
  @media (max-width:720px) { .readout { grid-template-columns:1fr 1fr; } .readout div:nth-child(2) { border-right:0; } .readout div:nth-child(-n+2) { border-bottom:1px solid var(--line); } .split { grid-template-columns:1fr; gap:0; } h1 { font-size:29px; } }
</style></head><body>
<header class="topbar">
  <div class="brand"><img src="/logo-mark.png" alt=""><span class="wordmark">Koe</span><span class="rule"></span><span class="workspace">Operator</span></div>
  <nav><a href="/stats.html">Live dashboard</a><a href="/studio">Studio</a><a href="/mcp">MCP</a></nav>
</header>
<main class="wrap">
  <h1>Operator stats</h1>
  <p class="sub">Server time ${esc(new Date().toISOString())} · up ${esc(uptime)} · refreshes every 30s</p>

  <div class="readout">
    <div><b>${esc(q.allTime.tts)}</b><span>voiceovers all-time</span></div>
    <div><b>${esc(q.today.words)}</b><span>words today</span></div>
    <div><b>${esc(q.windows["24h"].users)}</b><span>product users 24h</span></div>
    <div><b>${esc(extra.slots?.active ?? 0)} / ${esc(extra.slots?.queued ?? 0)}</b><span>active / queued</span></div>
  </div>

  <section><h2>Traffic · all-time / today</h2>
    <table><thead><tr><th>Metric</th><th class="n">All-time</th><th class="n">Today</th></tr></thead><tbody>
      <tr><td>All HTTP hits <span class="muted">(incl. bots, crawls, pages)</span></td>${cell("requests")}</tr>
      <tr><td>Voiceover jobs</td>${cell("tts")}</tr>
      <tr><td>MCP calls</td>${cell("mcp")}</tr>
      <tr><td>Previews</td>${cell("previews")}</tr>
      <tr><td>Downloads</td>${cell("downloads")}</tr>
      <tr><td>New keys</td>${cell("registers")}</tr>
    </tbody></table>
    <p class="note">Visitors in the last 24h: ${esc(q.windows["24h"].visitors)} · product users: ${esc(q.windows["24h"].users)}. Visitor ids are keyed hashes; raw IPs are never stored.</p>
  </section>

  <div class="split">
    <section><h2>Job ledger</h2>
      <table><tbody>
        <tr><td>Jobs on disk</td><td class="n">${esc(extra.jobsTotal ?? 0)}</td></tr>
        <tr><td>Jobs today</td><td class="n">${esc(extra.jobsToday ?? 0)}</td></tr>
        <tr><td>Jobs last 24h</td><td class="n">${esc(extra.jobs24h ?? 0)}</td></tr>
        <tr><td>By status</td><td class="n">${statuses}</td></tr>
      </tbody></table>
    </section>
    <section><h2>Capacity</h2>
      <table><tbody>
        <tr><td>Workers active</td><td class="n">${esc(extra.slots?.active ?? "?")}</td></tr>
        <tr><td>Waiting in queue</td><td class="n">${esc(extra.slots?.queued ?? "?")}</td></tr>
        <tr><td>Concurrency limit</td><td class="n">${esc(extra.slots?.concurrency ?? "?")}</td></tr>
        <tr><td>Queue capacity</td><td class="n">${esc(extra.slots?.queueMax ?? "?")}</td></tr>
        <tr><td>Uptime</td><td class="n">${esc(uptime)}</td></tr>
      </tbody></table>
    </section>
  </div>

  <section><h2>Top voiceover users · by words</h2>
    <table><thead><tr><th>#</th><th>Subject</th><th class="n">Requests</th><th class="n">Words</th><th class="n">Last seen</th></tr></thead>
    <tbody>${rows(topWords, "No voiceovers yet. Generate one in the studio or through MCP.")}</tbody></table>
  </section>

  <section><h2>Request sources · by HTTP requests</h2>
    <table><thead><tr><th>#</th><th>Subject</th><th class="n">Requests</th><th class="n">Words</th><th class="n">Last seen</th></tr></thead>
    <tbody>${rows(topRequests, "No requests recorded yet.")}</tbody></table>
    <p class="note">Crawlers and bots appear here as visitors. Only product actions count as users.</p>
  </section>

  <section><h2>Daily totals · last 14 days kept</h2>
    <table><thead><tr><th>Day</th><th class="n">Requests</th><th class="n">Jobs</th><th class="n">Downloads</th><th class="n">New keys</th><th class="n">Words</th></tr></thead>
    <tbody>${days || '<tr><td colspan="6" class="empty">No daily history yet.</td></tr>'}</tbody></table>
  </section>

  <footer>Counters persist to disk. Auto-refresh every 30s. This page requires the admin key and is not indexed.</footer>
</main></body></html>`;
}

function recentDays(limit = 14) {
  return Object.entries(store.days)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([day, d]) => ({
      day, ...d,
      uniques: uniquesForDay(day),
      paths: { ...(d.paths || {}) },
      engines: { ...(d.engines || {}) },
    }));
}

module.exports = { observe, markWords, query, topSubjects, subjectLabel, recentDays, renderPage, funnel, uniquesForDay };
