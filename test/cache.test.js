"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cache = require("../cache");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `koe-cache-test-${process.pid}-`));

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

function put(name, size, ageSeconds) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  const at = (Date.now() - ageSeconds * 1000) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}

test("a cache under its budget is left alone", () => {
  const dir = fs.mkdtempSync(path.join(DIR, "under-"));
  put(path.join(path.basename(dir), "a.mp3"), 100, 10);
  const file = path.join(dir, "a.mp3");
  fs.writeFileSync(file, Buffer.alloc(100, 1));

  const result = cache.prune(dir, 1000);
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(file), "nothing is deleted while there is room");
});

test("pruning deletes oldest first until the budget is met", () => {
  const dir = fs.mkdtempSync(path.join(DIR, "over-"));
  const oldest = path.join(dir, "oldest.mp3");
  const middle = path.join(dir, "middle.mp3");
  const newest = path.join(dir, "newest.mp3");
  for (const [file, age] of [[oldest, 300], [middle, 200], [newest, 100]]) {
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    const at = (Date.now() - age * 1000) / 1000;
    fs.utimesSync(file, at, at);
  }

  const result = cache.prune(dir, 2500);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(oldest), false, "the oldest entry goes first");
  assert.ok(fs.existsSync(middle) && fs.existsSync(newest));
  assert.ok(cache.totalBytes(dir) <= 2500);

  // Under pressure the rest go too, still oldest-first.
  const harder = cache.prune(dir, 1000);
  assert.equal(harder.removed, 1);
  assert.equal(fs.existsSync(middle), false);
  assert.ok(fs.existsSync(newest), "the newest entry is the last to go");
});

test("a write prunes the directory it lands in", () => {
  const dir = fs.mkdtempSync(path.join(DIR, "write-"));
  const old = path.join(dir, "old.mp3");
  fs.writeFileSync(old, Buffer.alloc(900, 1));
  const at = (Date.now() - 5000) / 1000;
  fs.utimesSync(old, at, at);

  const { pruned } = cache.write(dir, "new.mp3", Buffer.alloc(900, 1), 1200);
  assert.equal(pruned.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(dir, "new.mp3")));
  assert.ok(cache.totalBytes(dir) <= 1200);
});

test("reading a missing entry is a miss, not an error", () => {
  assert.equal(cache.read(DIR, "nothing-here.mp3"), null);
});
