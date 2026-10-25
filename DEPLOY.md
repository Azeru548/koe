# Deploy Koe on AWS

Production is one EC2 instance running two containers:

```
Internet
  │  :80 / :443
  ▼
Caddy (TLS, HTTP/2, gzip/zstd)
  │  127.0.0.1:8080
  ▼
koe container (Node 20 + edge-tts + Piper)
  │
  └── /data  →  jobs.json, state.json, stats.json, koe.db
```

- **Caddy** terminates TLS with a Let's Encrypt certificate and proxies to the app.
- **koe** listens on `127.0.0.1:8080` only; it is never exposed directly.
- The bind mount `/home/ec2-user/koe-data` keeps job metadata, signing state, analytics counters **and the issued-key/usage SQLite database (`KOE_DB_PATH=/data/koe.db`)** across container recreates.
- Generated audio is still ephemeral by design.
- `koe-watchdog.timer` checks every 2 minutes; `koe-diskguard.timer` runs daily.

The public instance is **<https://koe.kennedyazeru.space>**.

## 1. Prerequisites

- An EC2 instance (Amazon Linux 2023 or a compatible RPM distro).
- Security group inbound: `22` from your IP, `80` and `443` from anywhere.
- A DNS A record for the domain pointing at the instance's public IPv4.
- The repo available on GitHub (default: `https://github.com/Azeru548/koe.git`).

Do not open port `8080` or `3000` to the internet.

## 2. Bootstrap the instance

```bash
ssh -i ~/.ssh/koe-key.pem ec2-user@<public-ip>

sudo dnf install -y docker git curl
sudo systemctl enable --now docker

mkdir -p ~/koe-ops
```

Copy the ops kit from the repo:

```bash
# from your workstation
scp -i ~/.ssh/koe-key.pem ops/koe.env.example ops/rebuild.sh \
    ops/watchdog.sh ops/disk-guard.sh ops/Caddyfile \
    ec2-user@<public-ip>:~/koe-ops/
scp -i ~/.ssh/koe-key.pem ops/systemd/*.service ops/systemd/*.timer \
    ec2-user@<public-ip>:~/koe-ops/
```

On the instance:

```bash
cd ~/koe-ops
cp koe.env.example koe.env
chmod 600 koe.env
chmod +x rebuild.sh watchdog.sh disk-guard.sh
```

Edit `koe.env`:

```dotenv
KOE_DOMAIN=koe.yourdomain.com
KOE_SECRET=<long random secret>
API_KEY=<private admin key>
KOE_REPO_URL=https://github.com/Azeru548/koe.git
KOE_BRANCH=main
KOE_REPO_DIR=/home/ec2-user/koe
```

Generate secrets locally, then paste them in:

```bash
openssl rand -hex 32   # KOE_SECRET
openssl rand -hex 20   # API_KEY
```

**`KOE_SECRET` must stay stable.** It signs every free tenant key. Rotating it invalidates all existing keys; clients re-register automatically. **`API_KEY` is the operator key** used by `/stats`, `/stats.json`, and the analytics dashboard. Keep it private.

## 3. Install the timers

```bash
cd ~/koe-ops
sudo cp koe-watchdog.service koe-diskguard.service /etc/systemd/system/
sudo cp koe-watchdog.timer koe-diskguard.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now koe-watchdog.timer koe-diskguard.timer
```

## 4. First deploy

```bash
bash ~/koe-ops/rebuild.sh
```

The script:

1. Ensures a 1 GB swap file exists.
2. Installs/enables Docker and Git.
3. Clones `KOE_REPO_URL` to `KOE_REPO_DIR` or resets it to `origin/$KOE_BRANCH`.
4. Builds the `koe` image.
5. Recreates the `koe` container on `127.0.0.1:8080` with the `/data` volume.
6. Recreates Caddy with the `KOE_DOMAIN` from `koe.env`.
7. Polls `https://$KOE_DOMAIN/health` and prints `REBUILD_OK`.

The instance checkout is a **deployment artifact**. `rebuild.sh` uses `git reset --hard origin/main`; local edits on the server are discarded by design. Make changes in Git and redeploy.

## 5. Verify

```bash
curl -fsS https://koe.kennedyazeru.space/health
curl -I https://koe.kennedyazeru.space/
curl -I https://koe.kennedyazeru.space/studio
curl -I https://koe.kennedyazeru.space/mcp
curl -I https://koe.kennedyazeru.space/stats.html
```

Expected: `/health` is `200` with `backend:"native"`, `engines.edge:true`, `engines.piper:true`, `authRequired:true`, `keyRequired:true`. `/` is `302` to `/mcp`. `/studio`, `/mcp` (browser `Accept: text/html`), and `/stats.html` are `200`. `/stats.json` is `401` or `403` without `API_KEY` and `200` with it.

On the instance:

```bash
docker ps
systemctl list-timers --all | grep koe
df -h /
free -m
docker exec koe sha256sum /app/server.js /app/stats.js /app/stats.html
```

## 6. Update production

```bash
# from your workstation
git push origin main

# on the instance
bash ~/koe-ops/rebuild.sh
```

Because the script hard-resets the instance checkout, do not keep uncommitted fixes on the server. Commit and push first.

## 7. Analytics

`/stats.html` is a public shell. Enter `API_KEY` once; the key is kept in that browser's local storage. The page calls the admin-only `/stats.json` and shows:

- traffic and product actions, all-time and today
- product users (real actions) versus all visitors (including bots)
- top voiceover users by words and top request sources by HTTP requests
- live capacity and the 14-day daily ledger

Counters persist to `/data/stats.json` (`KOE_STATS_FILE`). Anonymous ids are keyed HMACs via `guard.anonSubject()`; raw IPs are never stored. Existing raw-IP records are migrated on load.

The older server-rendered `/stats?key=...` report remains available as a fallback.

## 8. Operations

### Kokoro sidecar (optional)

The third engine runs in its **own container**. The app is fully functional without it — edge and piper are unaffected, and only `engine: "kokoro"` requests answer `503 {"error":"tts_unavailable","engine":"kokoro"}` (within 10s, before any quota is charged).

```bash
cd ~/koe                     # the checkout that holds docker-compose.yml
docker compose up -d          # start the sidecar
docker compose logs -f        # first boot downloads the model + warms up
docker compose ps             # health: healthy / starting
docker compose down           # stop it
docker compose pull && docker compose up -d   # after bumping tag + digest
```

The image is pinned by **digest** (`msgflux/fastkokoro:0.7-cpu@sha256:35b4…`, never `:latest`), bound to `127.0.0.1:8880` only, and capped at `cpus: "2.0"` / `mem_limit: 2g` so it can never starve the app container. The healthcheck probes `GET /health` inside the container with a 180s start period for the first-boot model download.

Verify from the app's side:

```bash
curl -s localhost:3000/healthz | jq '.engines'
# → { "edge": true, "piper": true, "kokoro": true }
```

`kokoro: false` means the sidecar is down or still warming up — a normal state, not a fault. `GET /healthz` stays `200` either way, because a missing optional engine must never fail the watchdog.

If the sidecar lives on another host, set `KOKORO_BASE_URL` for the app container (default `http://127.0.0.1:8880`).

Logs:

```bash
docker logs --tail 100 koe
docker logs --tail 100 caddy
tail -n 50 ~/koe-ops/koe-watchdog.log
tail -n 20 ~/koe-ops/koe-diskguard.log
```

Restart the app without rebuilding:

```bash
docker restart koe
```

Check the watchdog and disk guard:

```bash
systemctl status koe-watchdog.timer koe-diskguard.timer
systemctl start koe-watchdog.service
systemctl start koe-diskguard.service
```

Disk pressure: the guard prunes Docker at 85% root usage. Check `df -h /` first; if the image or logs are growing unexpectedly, inspect before pruning.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| `502` / `503` from Caddy | `docker ps`; `docker logs koe`; `curl http://127.0.0.1:8080/health` |
| Certificate not issued | DNS A record, port 80/443 security group, `docker logs caddy` |
| Analytics page says key rejected | `API_KEY` in `~/koe-ops/koe.env` matches what you pasted |
| `/stats.html` returns 401 | The running image predates the analytics commit; rebuild |
| Counters reset after deploy | `/data` volume missing or `KOE_STATS_FILE` not `/data/stats.json` |
| Keys/counters reset on every restart | `KOE_DB_PATH` not on the volume — set `KOE_DB_PATH=/data/koe.db` in `~/koe-ops/koe.env` |
| Every key returns `401 {"error":"invalid_key"}` | The running image predates the v3 key store (older HMAC keys are no longer records); rebuild, and clients/pages re-mint automatically |
| `503 {"error":"temporarily_disabled"}` | `KOE_KILL_SWITCH=true` in `~/koe-ops/koe.env` — unset it and recreate the container |
| Queue stays full | Check upstream edge-tts health; the circuit breaker cools down after failures |
| Out of memory during build | Confirm the swap file exists (`swapon --show`) |

## 10. Legacy Render blueprint

`render.yaml` is kept for reference. It is not the production target and is not maintained as part of the AWS deployment. Leave the Render service alone unless you are deliberately decommissioning it.
