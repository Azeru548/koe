# Migration note — v3 keys, SQLite counters, kill switch

This release changes **where keys and counters live**. Nothing else about the
product moves: same endpoints, same tools, same limits.

| | Before (pre-v3) | After |
| --- | --- | --- |
| Keys | Stateless HMAC blobs (`koe_sk_<tid>_<signature>`), valid as long as `KOE_SECRET` stood still | Random `koe_sk_<32 hex>` **records in SQLite** (`keys` table) |
| Counters | In-memory maps + a JSON snapshot every 30 s | Rows in the same file (`usage`, `mint_ips`, `global_usage`) |
| Revocation | Not possible without rotating `KOE_SECRET` (which killed every key) | Delete the row — that one key dies on its next request |
| Issuance | `POST /api/register` with an empty body | `GET /keys/challenge` + `POST /keys` behind proof-of-work (or Turnstile). `POST /api/register` stays as an alias with **the same gate** |
| `/mcp` auth | Fell back to anonymous traffic when no key was presented | `POST /mcp` always needs a live key (or the admin key) |
| Oversized job | `413` | `400` for > `KOE_MAX_JOB_WORDS` (6,000 words); `413` remains for > 40,000 characters |
| Health | `GET /health` | `GET /healthz` (adds `db`, `killSwitch`); `GET /health` kept as an alias |
| Emergency stop | None | `KOE_KILL_SWITCH=true` → `503 {"error":"temporarily_disabled"}` on every generation endpoint |

## If you are a user of the hosted instance

1. **Any key you pasted before this upgrade is invalid.** It was never stored
   server-side, so there is nothing to look up and it now answers
   `401 {"error":"invalid_key"}`.
2. **The pages fix themselves.** <https://koe.kennedyazeru.space/mcp> and
   `/studio` clear a stored key the moment they see a `401` and mint a new one
   automatically — you do not have to do anything.
3. **Agents fix themselves too.** The stdio MCP checks `~/.koe/credentials.json`;
   on a `401` it drops the stale entry and re-mints through the proof-of-work
   gate, then saves the new key.
4. **If you use curl / a script**, mint a fresh key yourself:

   ```bash
   CH=$(curl -s https://koe.kennedyazeru.space/keys/challenge | jq -r .challenge)
   # find a nonce with sha256($CH$nonce) starting with 4 zero hex chars (~65k tries)
   curl -s -X POST https://koe.kennedyazeru.space/keys \
        -H "Content-Type: application/json" \
        -d "{\"challenge\":\"$CH\",\"nonce\":\"$NONCE\"}"
   # → 201 { "key": "koe_sk_…", "tenant": "…", "limits": {…} }
   ```

## If you operate a deployment

- **Back up / mount `KOE_DB_PATH`** (default `./koe.db`; set
  `KOE_DB_PATH=/data/koe.db` next to the other `/data` paths). If it is lost,
  every key and every counter starts from zero — that is the whole revocation
  story, and also the reason not to put it on an ephemeral layer.
- **No data migration runs.** Pre-v3 keys are deliberately not imported (they
  were never stored anywhere). The in-memory hour/day counters from the previous
  build are simply gone; the new hour/day windows start empty. That is a one-time
  reset of *counts*, not of access.
- **`.koe-state.json` shrank.** It now only carries the generated `KOE_SECRET`
  fallback. Old `registrations`/`usage` keys in it are ignored and stop being
  rewritten. Deleting the file is safe if `KOE_SECRET` is an env var.
- **Env names.** The new names are `KOE_HOURLY_REQUESTS`, `KOE_HOURLY_WORDS`,
  `KOE_DAILY_WORDS`, `KOE_MAX_JOB_WORDS`, `KOE_GLOBAL_DAILY_WORDS`. The old
  names (`KOE_KEY_REQ_HOUR`, `KOE_KEY_WORDS_HOUR`, `KOE_KEY_WORDS_DAY`,
  `KOE_MAX_WORDS_PER_JOB`, `KOE_GLOBAL_WORDS_DAY`) still work as fallbacks, so
  nothing needs editing to keep today's tuning.
- **Storage engine note.** `node-sqlite3-wasm` performs real
  `INSERT … ON CONFLICT DO UPDATE` upserts inside `BEGIN IMMEDIATE`
  transactions, but its WASM file layer has no shared-memory support, so
  `PRAGMA journal_mode=WAL` silently falls back to `delete`. Durability comes
  from `synchronous=FULL` plus immediate transactions, and there is exactly one
  connection per process (no per-request opens). `GET /healthz` reports the
  journal mode it actually got in `db.journalMode`.
- **Turnstile.** Set `TURNSTILE_SITEKEY` *and* `TURNSTILE_SECRET` to swap the
  proof-of-work gate for Cloudflare Turnstile. Headless MCP clients cannot solve
  a widget, so when Turnstile is on they need `TTS_API_KEY` (the page still
  works). Unset both to fall back to proof-of-work.
- **Rollback.** Deploy the previous image; pre-v3 clients keep working because
  the old code ignores `koe.db`. Keep the file — rolling forward again restores
  every key minted since.
