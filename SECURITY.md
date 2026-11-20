# Security policy

## Reporting a vulnerability

Email **pixelpro548@gmail.com** with the details. Please do not open a public
issue for anything that could be abused before it is fixed — a key bypass, a
quota bypass, a way to read another tenant's audio or job, or a way to reach the
host or the database.

Include what you did, what happened, and the smallest request that reproduces
it. A working `curl` is worth more than a paragraph.

You can expect an acknowledgement within a few days and a fix in the next
deploy. There is no bug bounty — this is one person's box, funded by malt
money — but credit in the commit and the release notes if you want it.

## Scope

In scope: the studio server (`server.js`, `guard.js`, `engines/`), the MCP
servers (`mcp/`, `hosted-mcp.js`), the key and quota system, and the public
instance at `https://koe.kennedyazeru.space`.

Out of scope: findings that need the operator's own `API_KEY`, upstream
`edge-tts` behaviour (Microsoft's consumer endpoint), missing hardening headers
with no demonstrated impact, and anything that only affects a self-hosted
instance you configured yourself.

## What the project already assumes

- Keys are bearer tokens. Anyone with a key can spend that tenant's quota; they
  are not passwords and are stored hashed in SQLite.
- The audio is deliberately short-lived (15 minutes) and the job list is
  tenant-isolated. Do not treat a `downloadUrl` as private once it is shared.
- The free tier is capped on purpose. A report that limits exist is not a
  vulnerability; a report that they can be bypassed is.
