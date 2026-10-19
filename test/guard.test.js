"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_FILE = path.join(os.tmpdir(), `koe-guard-test-${process.pid}.json`);
process.env.KOE_SECRET = "guard-test-secret";
process.env.KOE_STATE_FILE = STATE_FILE;
process.env.KOE_REGISTER_IP_DAY = "2";

const guard = require("../guard");

test.after(() => {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
});

test("mintKey produces a verifiable stateless key", () => {
  const { tid, key } = guard.mintKey();
  assert.match(key, /^koe_sk_[0-9a-f]{12}_[A-Za-z0-9_-]+$/);
  assert.equal(guard.verifyKey(key), tid);
  assert.equal(guard.verifyKey(key.slice(0, -1) + "x"), null);
  assert.equal(guard.verifyKey("not-a-key"), null);
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

test("slot semaphore bounds concurrency and queue depth", async () => {
  guard.cfg.globalConcurrency = 1;
  guard.cfg.globalQueue = 1;

  const first = guard.tryAcquireSlot();
  assert.ok(first);
  await first;

  const queued = guard.tryAcquireSlot();
  assert.ok(queued);
  assert.equal(guard.tryAcquireSlot(), null, "queue must be bounded");
  assert.equal(guard.queueFull(), true, "busy worker + full queue");

  let queuedRan = false;
  queued.then(() => { queuedRan = true; });
  guard.releaseSlot();
  await queued;
  assert.equal(queuedRan, true);
  guard.releaseSlot();

  assert.equal(guard.slotStats().active, 0);

  // A zero-length queue must still admit work while a worker is free.
  guard.cfg.globalQueue = 0;
  assert.equal(guard.queueFull(), false);
  const immediate = guard.tryAcquireSlot();
  assert.ok(immediate);
  await immediate;
  assert.equal(guard.queueFull(), true);
  guard.releaseSlot();
});
