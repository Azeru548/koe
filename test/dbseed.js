"use strict";
// Seed or inspect jobs directly in a studio database, for tests that used to
// write output/jobs.json. The store is SQLite now, so a running server reads
// these rows immediately.

const path = require("path");

function withStore(dbPath, fn) {
  process.env.KOE_DB_PATH = dbPath;
  const jobs = require("../jobs");
  // The server holds the same file open; retry briefly on a locked handle.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return fn(jobs);
    } catch (err) {
      if (!/busy|locked/i.test(String(err && err.message))) throw err;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief spin */ }
    }
  }
  throw new Error(`could not write ${path.basename(dbPath)} (locked)`);
}

function seedJob(dbPath, job) {
  return withStore(dbPath, (jobs) => jobs.create(job));
}

function readJob(dbPath, id) {
  return withStore(dbPath, (jobs) => jobs.get(id));
}

function removeJob(dbPath, id) {
  return withStore(dbPath, (jobs) => jobs.remove(id));
}

module.exports = { seedJob, readJob, removeJob };
