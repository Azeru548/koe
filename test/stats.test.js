"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koe-stats-test-"));
const STORE = path.join(TMP, "stats.json");
const RAW_IP = "203.0.113.9";
const NOW = Date.now();

// Seed a pre-fix store: anonymous visitors were keyed by raw IP. The module
// must migrate this on load, before any dashboard can read it.
fs.writeFileSync(STORE, JSON.stringify({
  allTime: { requests: 5, tts: 2, previews: 0, downloads: 0, registers: 1, mcp: 0, words: 2 },
  days: {},
  visitors: {
    [`anon:${RAW_IP}`]: { last: NOW, requests: 5, words: 2 },
  },
}, null, 2));

process.env.KOE_STATS_FILE = STORE;
process.env.KOE_SECRET = "stats-test-secret";
process.env.KOE_DB_PATH = path.join(TMP, "koe.db");

const guard = require("../guard");
const stats = require("../stats");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("legacy raw-IP visitors are re-keyed through the guard hash", () => {
  const hashed = guard.anonSubject(RAW_IP);
  const row = stats.topSubjects(10, "requests").find((s) => s.id === hashed);
  assert.ok(row, "migrated row exists");
  assert.equal(row.requests, 5);
  assert.equal(row.words, 2);
  assert.ok(!JSON.stringify(stats.topSubjects(10, "requests")).includes(RAW_IP));
  assert.equal(stats.subjectLabel(hashed).includes(RAW_IP), false);
});

test("requests and words land on one anonymous subject", () => {
  const ip = "198.51.100.7";
  const id = guard.anonSubject(ip);
  stats.observe({ path: "/tts", method: "POST", ctx: { ip, tid: null, admin: false } });
  stats.markWords({ subject: { id }, words: 4 });

  const row = stats.topSubjects(20, "requests").find((s) => s.id === id);
  assert.ok(row);
  assert.equal(row.requests, 1);
  assert.equal(row.words, 4);
  assert.equal(row.actions, 1);
  assert.equal(row.id.includes(ip), false);
});

test("product users and all visitors are counted separately", () => {
  const before = stats.query().windows["5m"];
  stats.observe({ path: "/studio", method: "GET", ctx: { ip: "198.51.100.8", tid: null, admin: false } });
  const after = stats.query().windows["5m"];

  assert.equal(after.users, before.users, "a page view is not a product user");
  assert.equal(after.visitors, before.visitors + 1);
});

test("health, dashboard polling, and private IPs are not counted", () => {
  const before = stats.query();
  for (const pathname of ["/health", "/stats", "/stats.html", "/stats.json"]) {
    stats.observe({ path: pathname, method: "GET", ctx: { ip: "198.51.100.9", tid: null, admin: false } });
  }
  stats.observe({ path: "/tts", method: "POST", ctx: { ip: "127.0.0.1", tid: null, admin: false } });
  const after = stats.query();

  assert.equal(after.allTime.requests, before.allTime.requests);
  assert.deepEqual(after.windows, before.windows);
});

test("POST /keys counts as a new registration", () => {
  const before = stats.query();
  stats.observe({ path: "/keys", method: "POST", ctx: { ip: "198.51.100.11", tid: null, admin: false } });
  const after = stats.query();

  assert.equal(after.allTime.registers, before.allTime.registers + 1, "the canonical mint path is a registration");
  assert.equal(after.today.registers, before.today.registers + 1);
  const row = stats.topSubjects(50, "requests").find((s) => s.id === guard.anonSubject("198.51.100.11"));
  assert.ok(row, "the minting visitor is recorded");
  assert.equal(row.actions, 1, "registering makes the subject a product user");
});

test("the legacy /api/register alias still counts as a registration", () => {
  const before = stats.query();
  stats.observe({ path: "/api/register", method: "POST", ctx: { ip: "198.51.100.12", tid: null, admin: false } });
  assert.equal(stats.query().allTime.registers, before.allTime.registers + 1);
});

test("static assets count as HTTP hits but do not create visitors", () => {
  const before = stats.query();
  stats.observe({ path: "/favicon-32.png", method: "GET", ctx: { ip: "198.51.100.10", tid: null, admin: false } });
  const after = stats.query();

  assert.equal(after.allTime.requests, before.allTime.requests + 1);
  assert.deepEqual(after.windows, before.windows);
});

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

function pageView(pathname, ip, ua = BROWSER_UA) {
  return { path: pathname, method: "GET", headers: { accept: "text/html", "user-agent": ua }, ctx: { ip, tid: null, admin: false } };
}

test("only real HTML documents count as page views", () => {
  const before = stats.query();
  stats.observe(pageView("/", "198.51.100.20"));
  // GET /mcp without an HTML Accept is the plain-text MCP hint, not a page.
  stats.observe({ path: "/mcp", method: "GET", headers: { accept: "text/plain" }, ctx: { ip: "198.51.100.21", tid: null, admin: false } });
  // API calls are not page views.
  stats.observe({ path: "/voices", method: "GET", headers: { accept: "*/*" }, ctx: { ip: "198.51.100.22", tid: null, admin: false } });

  const after = stats.query();
  assert.equal(after.allTime.pageviews, before.allTime.pageviews + 1);
  const root = after.paths.find((p) => p.path === "/");
  assert.ok(root && root.views >= 1, "the landing hit is attributed to /");
});

test("crawler page views are traffic, never visitors or page views", () => {
  const before = stats.query();
  stats.observe(pageView("/", "198.51.100.30", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"));
  const after = stats.query();

  assert.equal(after.allTime.requests, before.allTime.requests + 1);
  assert.equal(after.allTime.bots, before.allTime.bots + 1);
  assert.equal(after.allTime.pageviews, before.allTime.pageviews, "a crawl is not a read");
  assert.deepEqual(after.windows, before.windows);
});

test("a missing user agent is a person, not a bot", () => {
  const before = stats.query();
  stats.observe({ path: "/docs", method: "GET", headers: { accept: "text/html" }, ctx: { ip: "198.51.100.31", tid: null, admin: false } });
  const after = stats.query();

  assert.equal(after.allTime.bots, before.allTime.bots);
  assert.equal(after.allTime.pageviews, before.allTime.pageviews + 1);
});

test("the funnel counts each visitor once per stage", () => {
  const ip = "198.51.100.40";
  const before = stats.query().funnel;

  stats.observe(pageView("/mcp", ip));
  stats.observe(pageView("/mcp", ip)); // a reload is the same person

  const mid = stats.query().funnel;
  assert.equal(mid.visited, before.visited + 1, "two loads are one visitor");
  assert.equal(mid.setup, before.setup + 1);

  const id = guard.anonSubject(ip);
  stats.markWords({ subject: { id }, words: 9, engine: "edge" });
  stats.observe({ path: "/tts", method: "POST", headers: {}, ctx: { ip, tid: null, admin: false } });
  const gen = stats.query().funnel;
  assert.equal(gen.generated, mid.generated + 1);

  stats.observe({ path: "/download/abc123", method: "GET", headers: {}, ctx: { ip, tid: null, admin: false } });
  assert.equal(stats.query().funnel.downloaded, gen.downloaded + 1);
});

test("daily uniques and the daily ledger carry the new fields", () => {
  const q = stats.query();
  assert.ok(q.uniques.today >= 1, "today's unique visitors are counted");
  assert.ok(q.uniques.d7 >= q.uniques.today, "the 7-day window is at least today");

  const days = stats.recentDays(14);
  assert.ok(days.length >= 1);
  assert.equal(typeof days[0].uniques, "number");
  assert.equal(typeof days[0].pageviews, "number");
  assert.equal(typeof days[0].paths, "object");
  assert.equal(typeof days[0].engines, "object");
});

test("word accounting records the engine mix", () => {
  const before = stats.query().engines.edge || 0;
  stats.markWords({ subject: { id: "key:enginemix0001" }, words: 5, engine: "edge" });
  stats.markWords({ subject: { id: "key:enginemix0001" }, words: 5 });
  assert.equal(stats.query().engines.edge, before + 1, "an engine-less mark does not touch the mix");
});

test("signals are always derivable, never empty", () => {
  const list = stats.query().signals;
  assert.ok(Array.isArray(list) && list.length >= 6);
  for (const s of list) {
    assert.ok(s.key, "signal key");
    assert.ok(s.headline, "signal headline");
    assert.ok(["ok", "warn", "bad"].includes(s.level), `valid level on ${s.key}`);
  }
});

test("MCP discovery is not a tool call", () => {
  const before = stats.query();
  stats.observe({ path: "/mcp", method: "POST", headers: {}, body: { jsonrpc: "2.0", id: 1, method: "initialize" }, ctx: { ip: "198.51.100.50", tid: null, admin: false } });
  stats.observe({ path: "/mcp", method: "POST", headers: {}, body: { jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx: { ip: "198.51.100.50", tid: null, admin: false } });
  const after = stats.query();
  assert.equal(after.allTime.mcp, before.allTime.mcp, "a handshake is not usage");
});
