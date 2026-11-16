"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `koe-jobs-test-${process.pid}-`));
process.env.KOE_DB_PATH = path.join(TMP, "koe.db");
process.env.KOE_STATE_FILE = path.join(TMP, "state.json");
process.env.KOE_SECRET = "jobs-test-secret";

const jobs = require("../jobs");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const job = (id, extra = {}) => ({
  id, status: "queued", voice: "en-US-GuyNeural", engine: "edge", rate: 1, pitch: 0,
  parts: 1, wordCount: 3, words: 3, textChars: 20, tenant: null, progress: 0,
  createdAt: new Date().toISOString(), partsText: ["hello there"], ...extra,
});

test("a job round-trips through the store with its public shape intact", () => {
  const created = jobs.create(job("rt-1", { tenant: "key:abc" }));
  const back = jobs.get("rt-1");
  assert.equal(back.id, "rt-1");
  assert.equal(back.tenant, "key:abc");
  assert.deepEqual(back.partsText, ["hello there"]);
  assert.equal(created.status, "queued");
  jobs.remove("rt-1");
  assert.equal(jobs.get("rt-1"), null);
});

test("listing is per tenant and newest first", () => {
  jobs.create(job("list-old", { tenant: "key:a", createdAt: new Date(Date.now() - 5000).toISOString() }));
  jobs.create(job("list-new", { tenant: "key:a" }));
  jobs.create(job("list-other", { tenant: "key:b" }));

  const mine = jobs.list({ tenant: "key:a" }).map((j) => j.id);
  assert.deepEqual(mine, ["list-new", "list-old"]);
  assert.equal(jobs.list({ tenant: "key:b" }).length, 1);
  assert.ok(jobs.list({ limit: 100 }).length >= 3);
  for (const id of ["list-old", "list-new", "list-other"]) jobs.remove(id);
});

test("claimNext takes jobs in order and enforces the global limit", () => {
  jobs.create(job("claim-a", { createdAt: new Date(Date.now() - 3000).toISOString() }));
  jobs.create(job("claim-b", { createdAt: new Date(Date.now() - 2000).toISOString() }));
  jobs.create(job("claim-c", { createdAt: new Date(Date.now() - 1000).toISOString() }));

  const first = jobs.claimNext(1);
  assert.equal(first.id, "claim-a");
  assert.equal(jobs.countRunning(), 1);
  assert.equal(jobs.claimNext(1), null, "one running job already fills a limit of one");

  const second = jobs.claimNext(2);
  assert.equal(second.id, "claim-b");
  assert.equal(jobs.countQueued(), 1);

  // Second claim is marked running, so the row is exactly what claimNext returned.
  assert.equal(jobs.get(second.id).status, "starting");

  for (const id of ["claim-a", "claim-b", "claim-c"]) jobs.remove(id);
  assert.equal(jobs.countRunning(), 0);
});

test("a deleted job cannot be resurrected by a later update", () => {
  const j = jobs.create(job("gone-1"));
  jobs.update({ ...j, status: "generating (1/1)" });
  assert.equal(jobs.get("gone-1").status, "generating (1/1)");

  jobs.remove("gone-1");
  jobs.update({ ...j, status: "done" });
  assert.equal(jobs.get("gone-1"), null, "update is an UPDATE, never an insert");
});

test("reapStale only fails jobs that are past the deadline", () => {
  jobs.create(job("stale-old", {
    status: "generating (1/2)",
    createdAt: new Date(Date.now() - 600_000).toISOString(),
  }));
  jobs.create(job("stale-fresh", { status: "generating (1/2)" }));

  const reaped = jobs.reapStale(300).map((j) => j.id);
  assert.deepEqual(reaped, ["stale-old"]);
  assert.equal(jobs.get("stale-old").status, "failed");
  assert.match(jobs.get("stale-old").error, /deadline/);
  assert.equal(jobs.get("stale-fresh").status, "generating (1/2)");

  jobs.remove("stale-old");
  jobs.remove("stale-fresh");
});

test("failRunning fails everything a previous process left in flight", () => {
  jobs.create(job("boot-queued"));
  jobs.create(job("boot-running", { status: "starting" }));
  jobs.create(job("boot-gen", { status: "generating (2/3)" }));
  jobs.create(job("boot-done", { status: "done", completedAt: new Date().toISOString() }));

  const failed = jobs.failRunning("Server restarted before this job finished").map((j) => j.id);
  assert.deepEqual(failed.sort(), ["boot-gen", "boot-running"]);
  assert.equal(jobs.get("boot-queued").status, "queued", "queued work is picked up again");
  assert.equal(jobs.get("boot-done").status, "done");

  for (const id of ["boot-queued", "boot-running", "boot-gen", "boot-done"]) jobs.remove(id);
});

test("sweep prunes by job TTL and expires finished audio separately", () => {
  const now = Date.now();
  jobs.create(job("sweep-old", { createdAt: new Date(now - 7200 * 1000).toISOString() }));
  jobs.create(job("sweep-audio", {
    status: "done",
    file: "sweep-audio.zip",
    completedAt: new Date(now - 3600 * 1000).toISOString(),
  }));
  jobs.create(job("sweep-fresh"));

  const { removed, expired } = jobs.sweep({ jobTtlSec: 3600, audioTtlSec: 900 }, now);
  assert.ok(removed.includes("sweep-old"), "rows past the TTL are deleted");
  assert.deepEqual(expired, ["sweep-audio"]);
  assert.equal(jobs.get("sweep-audio").file, null);
  assert.ok(jobs.get("sweep-audio").audioDeletedAt, "expiry is recorded on the job");
  assert.equal(jobs.get("sweep-fresh").status, "queued");
});

test("a legacy jobs.json is imported once and keeps its ids", () => {
  const file = path.join(TMP, "jobs.json");
  fs.writeFileSync(file, JSON.stringify([
    { ...job("legacy-1"), status: "done", file: "legacy-1.zip" },
    { ...job("legacy-2"), status: "failed", error: "old failure" },
  ]));

  assert.equal(jobs.importLegacy(file), 2);
  assert.equal(jobs.get("legacy-1").status, "done");
  assert.equal(jobs.get("legacy-2").error, "old failure");

  assert.equal(jobs.importLegacy(file), 0, "a second boot does not duplicate rows");
  assert.equal(jobs.get("legacy-1").id, "legacy-1");
});
