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
// ("key:<tid>" / "anon:<ip>" / "admin") — never raw content, never heard audio.

const fs = require("fs");
const path = require("path");

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
  return `anon:${req.ctx.ip}`;
}

function observe(req) {
  const now = Date.now();
  const kind = pathKind(req.method, req.path);

  store.allTime.requests++;
  const d = dayBucket(now);
  d.requests++;
  if (kind) { store.allTime[kind] = (store.allTime[kind] || 0) + 1; d[kind] = (d[kind] || 0) + 1; }

  const sid = subjectOf(req);
  const v = store.visitors[sid] || { last: 0, requests: 0, words: 0 };
  v.last = now;
  v.requests++;
  store.visitors[sid] = v;

  dirty = true;
}

function markWords({ subject, words = 0 }) {
  const sid = (subject && subject.id) || "admin";
  const v = store.visitors[sid] || { last: Date.now(), requests: 0, words: 0 };
  v.last = Date.now();
  v.words += words;
  store.visitors[sid] = v;
  store.allTime.words += words;
  dayBucket(Date.now()).words += words;
  dirty = true;
}

// ── queries ─────────────────────────────────────────────────
function query() {
  const now = Date.now();
  const out = { allTime: { ...store.allTime }, today: { ...store.days[new Date(now).toISOString().slice(0, 10)] || BUCKETS }, windows: {} };
  for (const w of [[5, "5m"], [60, "1h"], [24 * 60, "24h"]]) {
    const cutoff = now - w[0] * 60 * 1000;
    let users = 0;
    for (const v of Object.values(store.visitors)) {
      if (v.last >= cutoff) users++;
    }
    out.windows[w[1]] = { users };
  }
  return out;
}

function topSubjects(limit = 10) {
  const arr = Object.entries(store.visitors).map(([id, v]) => ({ id, ...v }));
  arr.sort((a, b) => (b.words || 0) - (a.words || 0) || (b.requests || 0) - (a.requests || 0));
  return arr.slice(0, limit);
}

function renderPage(extra = {}) {
  const q = query();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cell = (k) => `<td>${esc(q.allTime[k] ?? 0)}</td><td>${esc(q.today[k] ?? 0)}</td>`;
  const b = (v) => (v ? "yes" : "no");

  const top = topSubjects(10).map((s, i) =>
    `<tr><td>#${i + 1}</td><td>${esc(s.id)}</td><td>${esc(s.requests)}</td><td>${esc(s.words)}</td><td>${esc(Math.round((Date.now() - s.last) / 1000))}s ago</td></tr>`).join("");
  const days = Object.entries(store.days).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14).map(([day, d]) =>
    `<tr><td>${esc(day)}</td><td>${esc(d.requests)}</td><td>${esc(d.tts)}</td><td>${esc(d.downloads)}</td><td>${esc(d.registers)}</td><td>${esc(d.words)}</td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30"><title>Koe — operator stats</title>
<style>
  body { background:#0f1115; color:#e8eaf0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; margin:24px; }
  h1 { font-size:20px; } h2 { font-size:15px; margin-top:28px; color:#9fb0ff; }
  table { border-collapse:collapse; width:100%; max-width:860px; }
  td, th { border:1px solid #262b36; padding:6px 10px; text-align:left; }
  th { color:#8b93a5; font-weight:600; }
  .grid { display:flex; gap:14px; flex-wrap:wrap; max-width:860px; }
  .card { background:#161a22; border:1px solid #262b36; border-radius:10px; padding:12px 16px; min-width:130px; }
  .card b { display:block; font-size:22px; color:#7ee6a2; }
  code { color:#9fb0ff; }
</style></head><body>
<h1>🎧 Koe — operator stats</h1>
<div class="grid">
  <div class="card"><b>${esc(q.allTime.requests)}</b>total requests</div>
  <div class="card"><b>${esc(q.today.requests)}</b>requests today</div>
  <div class="card"><b>${esc(q.windows["24h"].users)}</b>users (24h)</div>
  <div class="card"><b>${esc(q.windows["1h"].users)}</b>users (1h)</div>
  <div class="card"><b>${esc(q.windows["5m"].users)}</b>users (5m)</div>
  <div class="card"><b>${esc(extra.wordsToday ?? q.today.words)}</b>words today</div>
</div>

<h2>Requests: all-time / today</h2>
<table><tr><th>Metric</th><th>All-time</th><th>Today</th></tr>
<tr><td>Every HTTP request</td>${cell("requests")}</tr>
<tr><td>TTS jobs (POST /tts)</td>${cell("tts")}</tr>
<tr><td>MCP calls (POST /mcp)</td>${cell("mcp")}</tr>
<tr><td>Previews</td>${cell("previews")}</tr>
<tr><td>Downloads / audio</td>${cell("downloads")}</tr>
<tr><td>Key registrations</td>${cell("registers")}</tr></table>

<h2>Cards from job ledger (jobs.json)</h2>
<div class="grid">
  ${extra.jobsTotal !== undefined ? `<div class="card"><b>${esc(extra.jobsTotal)}</b>jobs on disk</div>` : ""}
  ${extra.jobsToday !== undefined ? `<div class="card"><b>${esc(extra.jobsToday)}</b>jobs today</div>` : ""}
  ${extra.jobs24h !== undefined ? `<div class="card"><b>${esc(extra.jobs24h)}</b>jobs (24h)</div>` : ""}
  ${extra.byStatus ? Object.entries(extra.byStatus).map(([k, v]) => `<div class="card"><b>${esc(v)}</b>${esc(k)}</div>`).join("") : ""}
</div>

<h2>Capacity (live)</h2>
<table><tr><th>Slot</th><th>Value</th></tr>
<tr><td>Workers active</td><td>${esc(extra.slots?.active ?? "?")}</td></tr>
<tr><td>Waiting in queue</td><td>${esc(extra.slots?.queued ?? "?")}</td></tr>
<tr><td>Concurrency limit</td><td>${esc(extra.slots?.concurrency ?? "?")}</td></tr>
<tr><td>Queue capacity</td><td>${esc(extra.slots?.queueMax ?? "?")}</td></tr>
<tr><td>Uptime</td><td>${esc(extra.uptimeSec ? `${Math.floor(extra.uptimeSec / 3600)}h ${Math.floor((extra.uptimeSec % 3600) / 60)}m` : "?")}</td></tr></table>

<h2>Top subjects (privacy-safe ids)</h2>
<table><tr><th></th><th>Subject</th><th>Requests</th><th>Words</th><th>Last seen</th></tr>${top || '<tr><td colspan="5">No visitors yet</td></tr>'}</table>

<h2>Daily totals (last 14 days kept)</h2>
<table><tr><th>Day</th><th>Requests</th><th>TTS</th><th>Downloads</th><th>Registers</th><th>Words</th></tr>${days || '<tr><td colspan="6">No data yet</td></tr>'}</table>

<p style="color:#8b93a5">Auto-refreshes every 30 s · counters persist to disk · ids are subject hashes, not identities</p>
</body></html>`;
}

module.exports = { observe, markWords, query, topSubjects, renderPage };
