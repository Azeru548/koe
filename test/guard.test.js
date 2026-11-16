"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_FILE = path.join(os.tmpdir(), `koe-guard-test-${process.pid}.json`);
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `koe-guard-db-${process.pid}-`));
process.env.KOE_SECRET = "guard-test-secret";
process.env.KOE_STATE_FILE = STATE_FILE;
process.env.KOE_DB_PATH = path.join(DB_DIR, "koe.db");
process.env.KOE_REGISTER_IP_DAY = "2";

const guard = require("../guard");

test.after(() => {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
  try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
});

test("mintKey issues a server-side key that only resolves through the keys table", () => {
  const { tid, key } = guard.mintKey();
  assert.match(key, /^koe_sk_[0-9a-f]{32}$/);
  assert.equal(guard.verifyKey(key), tid);
  // Flip the last hex digit: no row matches, so the key dies.
  const mutated = key.slice(0, -1) + (key.endsWith("f") ? "0" : "f");
  assert.equal(guard.verifyKey(mutated), null);
  assert.equal(guard.verifyKey("not-a-key"), null);
  // Pre-v3 HMAC keys are not records — they are rejected outright.
  assert.equal(guard.verifyKey("koe_sk_deadbeefdeadbeef_aaaaaaaaaaaaaaaaaaaaaaaa"), null);
  assert.equal(guard.isValidKey(key), true);
  assert.equal(guard.isValidKey(mutated), false);
  assert.equal(guard.keyPrefix(key).length, 11);
});

test("anonymous subjects are stable but never expose the raw IP", () => {
  const a = guard.anonSubject("203.0.113.7");
  assert.equal(a, guard.anonSubject("203.0.113.7"));
  assert.notEqual(a, guard.anonSubject("203.0.113.8"));
  assert.match(a, /^anon:[A-Za-z0-9_-]{12}$/);
  assert.ok(!a.includes("203.0.113.7"));
});

test("registration is capped per IP per day", () => {
  guard.cfg.registerIpDay = 2;
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  assert.ok(guard.registerFromIp("198.51.100.1", now).key);
  assert.ok(guard.registerFromIp("198.51.100.1", now).key);
  assert.throws(
    () => guard.registerFromIp("198.51.100.1", now),
    (err) => err.status === 429 && /Registration limit/.test(err.message)
  );
  // New day resets the counter.
  assert.ok(guard.registerFromIp("198.51.100.1", now + 24 * 3600 * 1000).key);
});

test("charge enforces hourly request, word, daily, and global limits", () => {
  const now = Date.UTC(2026, 0, 3, 12, 0, 0);
  guard.cfg.keyReqHour = 2;
  guard.cfg.keyWordsHour = 100;
  guard.cfg.keyWordsDay = 1000;
  guard.cfg.globalWordsDay = 100000;

  const id = "key:reqtest";
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 5, now }).ok, true);
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 5, now }).ok, true);
  const third = guard.charge({ subjectId: id, kind: "key", words: 5, now });
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.match(third.error, /request limit/);

  const wordId = "key:wordtest";
  assert.equal(guard.charge({ subjectId: wordId, kind: "key", words: 101, now }).ok, false);

  guard.cfg.keyWordsHour = 100;
  guard.cfg.keyWordsDay = 10;
  const dayId = "key:daytest";
  assert.equal(guard.charge({ subjectId: dayId, kind: "key", words: 6, now }).ok, true);
  const day = guard.charge({ subjectId: dayId, kind: "key", words: 6, now });
  assert.equal(day.ok, false);
  assert.match(day.error, /Daily word limit/);

  const globalId = "key:globaltest";
  guard.cfg.globalWordsDay = 3;
  const global = guard.charge({ subjectId: globalId, kind: "key", words: 10, now });
  assert.equal(global.ok, false);
  assert.match(global.error, /global daily capacity/);
});

test("refund returns words and optionally the request slot", () => {
  const now = Date.UTC(2026, 0, 4, 12, 0, 0);
  guard.cfg.keyReqHour = 10;
  guard.cfg.keyWordsHour = 100;
  guard.cfg.keyWordsDay = 1000;
  guard.cfg.globalWordsDay = 100000;
  const id = "key:refundtest";
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 7, now }).ok, true);
  let snap = guard.usageSnapshot(id, "key", now);
  assert.equal(snap.hour.words, 7);

  guard.refund({ subjectId: id, words: 7, requests: true, now });
  snap = guard.usageSnapshot(id, "key", now);
  assert.equal(snap.hour.words, 0);
  assert.equal(snap.hour.requests, 0);
});

test("kill switch answers 503 before anything is counted", () => {
  const now = Date.UTC(2026, 0, 6, 12, 0, 0);
  const id = "key:killtest";
  guard.cfg.killSwitch = true;
  try {
    const verdict = guard.charge({ subjectId: id, kind: "key", words: 1, now });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 503);
    assert.equal(verdict.error, "temporarily_disabled");
    assert.equal(verdict.reason, "kill_switch");
    assert.equal(guard.usageSnapshot(id, "key", now).hour.words, 0);
  } finally {
    guard.cfg.killSwitch = false;
  }
});

test("a single job over the word cap is a 400 before counting", () => {
  const now = Date.UTC(2026, 0, 7, 12, 0, 0);
  const id = "key:captest";
  const verdict = guard.charge({ subjectId: id, kind: "key", words: guard.cfg.maxWordsPerJob + 1, now });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 400);
  assert.equal(verdict.reason, "job_too_long");
  assert.equal(guard.usageSnapshot(id, "key", now).hour.words, 0);
});

test("counters are read back from the database, not from process memory", () => {
  const now = Date.UTC(2026, 0, 8, 12, 0, 0);
  guard.cfg.keyReqHour = 60;
  guard.cfg.keyWordsHour = 1000;
  guard.cfg.keyWordsDay = 100000;
  guard.cfg.globalWordsDay = 1000000;
  const id = "key:persisttest";
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 5, now }).ok, true);

  const stored = guard.db.readUsage(id, guard.hourWindow(now), guard.dayWindow(now));
  assert.equal(stored.hour.words, 5);
  assert.equal(stored.hour.requests, 1);
  assert.equal(stored.day.words, 5);
  assert.equal(guard.db.readGlobal(guard.dayWindow(now)).words > 0, true);

  // Rows are keyed exactly as the spec requires.
  assert.match(guard.hourWindow(now), /^hour:\d{4}-\d{2}-\d{2}T\d{2}$/);
  assert.match(guard.dayWindow(now), /^day:\d{4}-\d{2}-\d{2}$/);
});

test("hour and day windows reset with time", () => {
  guard.cfg.keyReqHour = 1;
  guard.cfg.keyWordsHour = 100;
  guard.cfg.keyWordsDay = 1000;
  guard.cfg.globalWordsDay = 100000;
  const id = "key:windowtest";
  const t0 = Date.UTC(2026, 0, 5, 10, 30, 0);
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 1, now: t0 }).ok, true);
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 1, now: t0 + 1000 }).ok, false);
  assert.equal(guard.charge({ subjectId: id, kind: "key", words: 1, now: t0 + 3600 * 1000 }).ok, true);
});

test("circuit breaker ignores bad input and opens on transient upstream errors", () => {
  guard.cfg.cooldownSec = 10;
  guard.recordUpstreamSuccess();

  const bad = guard.recordUpstreamFailure(new Error("Invalid voice id"));
  assert.equal(bad.opened, false);
  assert.equal(guard.checkCircuit().open, false);

  const transient = guard.recordUpstreamFailure(new Error("403 Forbidden from upstream"));
  assert.equal(transient.opened, true);
  const open = guard.checkCircuit();
  assert.equal(open.open, true);
  assert.ok(open.retryAfterSec > 0);

  guard.recordUpstreamSuccess();
  assert.equal(guard.checkCircuit().open, false);
});

// Job admission moved from process memory to the job store, so several
// processes can share one limit. This asserts the new contract: the count that
// bounds concurrency is the count of claimed rows in the database.
test("admission is bounded by the shared job store, not by process memory", () => {
  const jobsStore = require("../jobs");
  guard.cfg.globalConcurrency = 1;
  guard.cfg.globalQueue = 1;

  const row = (id) => ({
    id, status: "queued", voice: "en-US-GuyNeural", engine: "edge", rate: 1, pitch: 0,
    parts: 1, wordCount: 1, words: 1, tenant: null, progress: 0,
    createdAt: new Date().toISOString(), partsText: ["hello"],
  });

  jobsStore.create(row("admit-a"));
  jobsStore.create(row("admit-b"));

  assert.equal(guard.queueFull(), false, "one running + one queued still fits");

  const first = jobsStore.claimNext(guard.cfg.globalConcurrency);
  assert.equal(first.id, "admit-a");
  assert.equal(
    jobsStore.claimNext(guard.cfg.globalConcurrency),
    null,
    "the concurrency limit is enforced inside the claim"
  );

  assert.equal(guard.slotStats().active, 1);
  assert.equal(guard.slotStats().queued, 1);
  assert.equal(guard.queueFull(), true, "busy worker + full waiting room");

  // Finishing a job frees the slot for the next queued one.
  first.status = "done";
  jobsStore.update(first);
  const second = jobsStore.claimNext(guard.cfg.globalConcurrency);
  assert.equal(second.id, "admit-b");

  second.status = "done";
  jobsStore.update(second);
  assert.equal(guard.slotStats().active, 0);
  assert.equal(guard.slotStats().load, "idle");

  jobsStore.remove("admit-a");
  jobsStore.remove("admit-b");
});

test("waitForSlot gives up at the deadline instead of queueing forever", async () => {
  guard.cfg.globalConcurrency = 1;
  guard.cfg.globalQueue = 2;

  const held = guard.tryAcquireSlot();
  await held;                       // one worker busy for the whole test
  const waiting = guard.tryAcquireSlot();
  assert.ok(waiting);

  const started = Date.now();
  const grant = await guard.waitForSlot(waiting, Date.now() + 120);
  assert.equal(grant.granted, false);
  assert.equal(grant.reason, "wait_timeout");
  assert.ok(Date.now() - started >= 100, "it waited roughly the budget before giving up");

  // Walking away must also leave the queue: a timed-out waiter is not still
  // occupying a place, and it must not swallow the worker when one frees up.
  assert.equal(guard.slotStats().previewWaiters, 0, "timed-out waiter left the queue");
  guard.releaseSlot();               // frees the held worker
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(guard.slotStats().previews, 0, "late grant returned to the pool");
  assert.equal(guard.slotStats().previewWaiters, 0);

  // And the pool is genuinely free again.
  guard.cfg.globalQueue = 1;
  const next = guard.tryAcquireSlot();
  assert.ok(next);
  await next;
  assert.equal(guard.slotStats().previews, 1);
  guard.releaseSlot();
  assert.equal(guard.slotStats().previews, 0);
});

test("queue state reports saturation honestly, not just an idle-looking ok", () => {
  const jobsStore = require("../jobs");
  guard.cfg.globalConcurrency = 1;
  guard.cfg.globalQueue = 2;

  const row = (id, status) => ({
    id, status, voice: "en-US-GuyNeural", engine: "edge", rate: 1, pitch: 0,
    parts: 1, wordCount: 1, words: 1, tenant: null, progress: 0,
    createdAt: new Date().toISOString(), partsText: ["hello"],
  });

  jobsStore.create(row("sat-a", "queued"));
  jobsStore.create(row("sat-b", "queued"));

  jobsStore.claimNext(guard.cfg.globalConcurrency);
  assert.equal(guard.slotStats().load, "busy", "a worker is busy, room in the queue");
  assert.equal(guard.slotStats().saturated, false);

  assert.equal(guard.slotStats().queued, 1);
  guard.cfg.globalQueue = 1;                       // the waiting room is now full
  assert.equal(guard.slotStats().saturated, true, "busy worker and a full waiting room");
  assert.equal(guard.slotStats().load, "saturated");

  jobsStore.remove("sat-a");
  jobsStore.remove("sat-b");
  assert.equal(guard.slotStats().load, "idle");
  assert.equal(guard.slotStats().queued, 0);
});

test("refunds land in the window that was charged, not in the current one", () => {
  // Earlier tests lower these to prove the limits bite; set what this one needs.
  guard.cfg.keyReqHour = 60;
  guard.cfg.keyWordsHour = 2000;
  guard.cfg.keyWordsDay = 20000;
  guard.cfg.globalWordsDay = 1000000;
  const subjectId = "key:refund-window-test";
  const t0 = Date.UTC(2026, 0, 5, 10, 59, 0);      // just before an hour boundary
  const charged = guard.charge({ subjectId, kind: "key", words: 120, now: t0 });
  assert.equal(charged.ok, true);
  const hour1 = guard.hourWindow(t0);
  const day1 = guard.dayWindow(t0);

  const t1 = t0 + 3 * 60 * 1000;                   // the job finishes in the next hour
  assert.notEqual(guard.hourWindow(t1), hour1, "the two times are in different windows");

  guard.refund({ subjectId, words: 120, requests: true, windows: charged.windows, now: t1 });

  const old = guard.db.readUsage(subjectId, hour1, day1);
  assert.equal(old.hour.words, 0, "the hour that was charged is clean again");
  assert.equal(old.hour.requests, 0);

  const current = guard.db.readUsage(subjectId, guard.hourWindow(t1), guard.dayWindow(t1));
  assert.equal(current.hour.words, 0, "the new hour is not credited with usage it never had");
  assert.equal(current.hour.requests, 0);
});

test("a full queue is reported immediately, not after the wait", async () => {
  guard.cfg.globalConcurrency = 1;
  guard.cfg.globalQueue = 0;
  const held = guard.tryAcquireSlot();
  await held;
  assert.equal(guard.tryAcquireSlot(), null);
  const grant = await guard.waitForSlot(null, Date.now() + 5000);
  assert.equal(grant.granted, false);
  assert.equal(grant.reason, "queue_full");
  guard.releaseSlot();
});
