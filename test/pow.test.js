"use strict";

// ─────────────────────────────────────────────────────────────
//  Regression: the browser proof-of-work helpers inlined in the two pages.
//
//  `++b[i]` on a Uint8Array evaluates to the UNWRAPPED value — 255 + 1 stores
//  0 but the expression is 256 — so a carry written as
//
//      if (++b[i] !== 0) break;
//
//  never leaves the last byte. The nonce then cycles through exactly 256
//  values, and a 4-zero proof-of-work essentially never finds a solution: the
//  page sits on "Creating your key…" and finally reports "proof-of-work timed
//  out". This test pulls the real functions out of both pages, runs them, and
//  checks a nonce is actually found and really solves the challenge.
// ─────────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PAGES = ["mcp.html", "index.html"];

function source(page) {
  return fs.readFileSync(path.join(__dirname, "..", page), "utf8");
}

// Pull one declaration out of the page by brace counting.
function extract(src, name) {
  let i = src.indexOf(`async function ${name}`);
  if (i === -1) i = src.indexOf(`function ${name}`);
  assert.ok(i !== -1, `the page must define ${name}()`);
  let depth = 0;
  let started = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function extractHexBytes(src) {
  const m = src.match(/const hexBytes = [^;]+;/);
  assert.ok(m, "the page must define hexBytes");
  return m[0];
}

// Rebuild the page's helper chain exactly as the browser runs it.
function buildPow(src) {
  const code = [
    extractHexBytes(src),
    extract(src, "bumpBytes"),
    extract(src, "sha256Hex"),
    extract(src, "solvePow"),
    "return { solvePow, sha256Hex, bumpBytes };",
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

for (const page of PAGES) {
  test(`${page}: bumpBytes carries across byte boundaries`, () => {
    const src = source(page);
    const { bumpBytes } = buildPow(src);

    const allFF = new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
    bumpBytes(allFF);
    assert.deepEqual([...allFF], [0, 0, 0, 0, 0, 1, 0, 0], "carry must propagate past two 0xff bytes");

    const zero = new Uint8Array(8);
    bumpBytes(zero);
    assert.deepEqual([...zero], [0, 0, 0, 0, 0, 0, 0, 1], "a plain increment touches only the last byte");

    const stop = new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xfe]);
    bumpBytes(stop);
    assert.deepEqual([...stop], [0, 0, 0, 0, 0, 0, 0xff, 0xff], "no carry when the last byte does not wrap");
  });

  test(`${page}: the unwrapped ++b[i] carry is gone`, () => {
    const src = source(page);
    assert.ok(
      !/if \(\+\+b\[i\] !== 0\) break/.test(src),
      "++b[i] on a Uint8Array returns 256, not 0 — that form never carries"
    );
    assert.ok(
      !/for \(let i = b\.length - 1; i >= 0; i--\) \{ b\[i\]\+\+/.test(src),
      "b[i]++ has the same unwrapped-value problem"
    );
  });

  test(`${page}: solvePow finds a nonce that really solves the challenge`, async () => {
    const { solvePow, sha256Hex } = buildPow(source(page));
    const challenge = "0123456789abcdef0123456789abcdef";

    const nonce = await solvePow(challenge, 4);

    assert.equal(typeof nonce, "string");
    assert.match(nonce, /^[0-9a-f]{16}$/, "the nonce is the 8-byte counter in hex");

    const hash = await sha256Hex(challenge + nonce);
    assert.ok(hash.startsWith("0000"), `${nonce} must hash to ${hash} with four leading zeros`);
  }, { timeout: 60000 });
}
