"use strict";
// Shared helpers for the HTTP test suites: proof-of-work solving + key minting.
// (Not a test file — it is not listed in `npm test`.)

const crypto = require("crypto");

// sha256(challenge + nonce) must start with `zeros` '0' hex chars.
function solvePow(challenge, zeros = 4) {
  const target = "0".repeat(zeros);
  for (let i = 0; i < 5_000_000; i++) {
    const nonce = i.toString(16).padStart(4, "0");
    const hash = crypto.createHash("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hash.startsWith(target)) return nonce;
  }
  throw new Error("proof-of-work did not converge");
}

async function json(base, pathname, { method = "GET", key, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// GET /keys/challenge, solve the PoW, POST /keys → { status, data }.
async function mintKey(base) {
  const ch = await json(base, "/keys/challenge");
  if (ch.status !== 200 || !ch.data.challenge) {
    return { status: ch.status, data: ch.data };
  }
  const nonce = solvePow(ch.data.challenge, (ch.data.pow && ch.data.pow.leadingZeroHexChars) || 4);
  return json(base, "/keys", { method: "POST", body: { challenge: ch.data.challenge, nonce } });
}

module.exports = { solvePow, json, mintKey };
