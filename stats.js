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
const BUCKETS = { requests: 0, tts: 0, previews: 0, downloads: 0, registers: 0, mcp: 0, words: 0 };

let store = { allTime: { ...BUCKETS }, days: {}, visitors: {} };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(STORE, "utf8"))); } catch { /* first boot */ }
store.allTime  = { ...BUCKETS, ...store.allTime  };
store.days     = (store.days && typeof store.days === "object") ? store.days : {};
store.visitors = (store.visitors && typeof store.visitors === "object") ? store.visitors : {};

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
  if (!store.days[k]) store.days[k] = { ...BUCKETS };
  else store.days[k] = { ...BUCKETS, ...store.days[k] };
  return store.days[k];
}

// ── observation ─────────────────────────────────────────────
function pathKind(method, p) {
  if (p === "/tts") return "tts";
  if (p === "/tts-preview" || p === "/tts-preview-piper") return "previews";
  if (p.startsWith("/download/") || p.startsWith("/audio/")) return "downloads";
  if (p === "/api/register") return "registers";
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

function observe(req) {
  if (isSystemNoise(req)) return;
  const now = Date.now();
  const kind = pathKind(req.method, req.path);

  store.allTime.requests++;
  const d = dayBucket(now);
  d.requests++;
  if (kind) { store.allTime[kind] = (store.allTime[kind] || 0) + 1; d[kind] = (d[kind] || 0) + 1; }

  if (isAsset(req.path)) { dirty = true; return; }

  const sid = subjectOf(req);
  const v = store.visitors[sid] || { last: 0, requests: 0, words: 0, actions: 0 };
  v.last = now;
  v.requests++;
  if (kind) {
    v.actions = (v.actions || 0) + 1;
    v.lastAction = now;
  }
  store.visitors[sid] = v;

  dirty = true;
}

function markWords({ subject, words = 0 }) {
  const sid = (subject && subject.id) || "admin";
  const now = Date.now();
  const v = store.visitors[sid] || { last: now, requests: 0, words: 0, actions: 0 };
  v.last = now;
  if (words > 0) v.lastAction = now;
  v.words += words;
  store.visitors[sid] = v;
  store.allTime.words += words;
  dayBucket(now).words += words;
  dirty = true;
}

// ── queries ─────────────────────────────────────────────────
function query() {
  const now = Date.now();
  const out = { allTime: { ...store.allTime }, today: { ...store.days[new Date(now).toISOString().slice(0, 10)] || BUCKETS }, windows: {} };
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
    .map(([day, d]) => ({ day, ...d }));
}

module.exports = { observe, markWords, query, topSubjects, subjectLabel, recentDays, renderPage };
