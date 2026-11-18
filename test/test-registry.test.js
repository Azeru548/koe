"use strict";
// `npm test` runs an explicit file list — directory and glob arguments to
// `node --test` behave differently across the Node versions this project
// supports and across shells — so a newly added test file is silently invisible
// to CI until someone remembers to add it. This test fails when that happens,
// in either direction (a missing file or a stale entry).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("every test file is in the npm test list, and nothing stale is left", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const listed = String(pkg.scripts.test)
    .split(/\s+/)
    .filter((arg) => arg.startsWith("test/"))
    .sort();
  const present = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith(".test.js"))
    .map((file) => `test/${file}`)
    .sort();

  assert.deepEqual([...new Set(listed)], present);
});
