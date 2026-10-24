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

test("static assets count as HTTP hits but do not create visitors", () => {
  const before = stats.query();
  stats.observe({ path: "/favicon-32.png", method: "GET", ctx: { ip: "198.51.100.10", tid: null, admin: false } });
  const after = stats.query();

  assert.equal(after.allTime.requests, before.allTime.requests + 1);
  assert.deepEqual(after.windows, before.windows);
});
