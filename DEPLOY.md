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
  └── /data  →  state.json, stats.json, koe.db (jobs + counters)
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

# Amazon Linux 2023 ships Docker without a compose plugin, and `docker compose`
# is what §8 uses to run the Kokoro sidecar. Install it as a *user* CLI plugin:
# no sudo, no extra package repo.
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version          # → Docker Compose version v2.29.7

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
KOE_DB_PATH=/data/koe.db   # must stay on the mounted volume
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
5. Recreates the `koe` container on `127.0.0.1:8080` with the `/data` volume, pointing `KOE_DB_PATH`, `KOE_STATS_FILE` and `KOE_STATE_FILE` at it.

### More throughput without a bigger box

The job queue is in `koe.db`, so extra capacity is extra worker processes on the
same volume, not a new instance:

```bash
KOE_EMBED_WORKER=false node server.js        # HTTP only
KOE_WORKERS=6 node worker.js > /var/log/koe-worker.log 2>&1 &
```

The synthesis cache lives in `/data/output/cache` and is capped by
`KOE_CACHE_MAX_MB` (default 256 MB), pruned oldest-first on write — it cannot fill
the volume. Job scripts are kept under `/data/output/work/` (never in the
database), so a job claimed when the process is killed is re-queued on the next
boot from its own file.

Any number of `worker.js` processes can run beside the server: claims are atomic,
the concurrency limit is shared, and a crashed worker's jobs are reaped and
refunded after `KOE_JOB_DEADLINE_SEC`. Keep `KOE_GLOBAL_CONCURRENCY` honest for
the whole set (6 workers across two processes is still six, not twelve) and watch
the log for upstream 403/429s before raising it.

   Before removing the old container it preserves the issued-key database: if `/data` has no database yet, it stops the container, copies `KOE_DB_PATH` (or `/app/koe.db` on an image that stored it inside the container) onto the volume, checks that the copy really is SQLite, and carries on. It never overwrites a database already on the volume — that one is newer — and never aborts the deploy: a failed copy prints the manual `docker cp` command and lets the rebuild finish, because clients re-mint on a `401`.
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

### Automatic deploys (optional)

`.github/workflows/test.yml` ends with a `deploy` job that runs the same
`rebuild.sh` — but over **Systems Manager**, not SSH, so the instance needs no
open inbound port and no deploy key, and it can also be started by hand from
**Actions → ci → Run workflow** (choose `main`). It runs when `npm test` **and**
the Docker build have passed on a push to `main`, and pull requests never deploy.

The job authenticates with GitHub's OIDC identity provider, so no AWS
credential is stored in GitHub. Set this up once, with your AWS credentials
(CloudShell is fine):

1. Register GitHub as an OIDC provider. If it answers `EntityAlreadyExists`, the
   provider is already there — continue.

   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

2. Create a role only this repository's `main` and the `production` environment
   can assume. Note the `@id` parts in the subject: repositories created or
   renamed after **15 July 2026** emit an immutable `sub` claim such as
   `repo:Azeru548@312097779/koe@1320227600:ref:refs/heads/main`, and a policy
   written with bare names never matches it (`Not authorized to perform
   sts:AssumeRoleWithWebIdentity`). The numbers below are this repository's —
   `owner_id` and `repo_id` from `https://api.github.com/repos/Azeru548/koe`.

   ```bash
   ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

   cat > /tmp/koe-trust.json <<JSON
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": {
           "token.actions.githubusercontent.com:sub": [
             "repo:Azeru548@312097779/koe@1320227600:ref:refs/heads/main",
             "repo:Azeru548@312097779/koe@1320227600:environment:production"
           ]
         }
       }
     }]
   }
   JSON

   aws iam create-role --role-name koe-deploy \
     --assume-role-policy-document file:///tmp/koe-trust.json

   cat > /tmp/koe-ssm.json <<'JSON'
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": [
         "ssm:SendCommand",
         "ssm:GetCommandInvocation",
         "ssm:DescribeInstanceInformation"
       ],
       "Resource": "*"
     }]
   }
   JSON

   aws iam put-role-policy --role-name koe-deploy \
     --policy-name koe-deploy-ssm --policy-document file:///tmp/koe-ssm.json
   ```

   The role can run commands and read their output — it cannot read the database
   or anything else on the box.

3. Add repository **variables** (Settings → Secrets and variables → Actions →
   Variables):

   | Variable | Value |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | the ARN returned by `create-role` |
   | `KOE_INSTANCE_ID` | the instance id, e.g. `i-022095021f7a993a7` |
   | `AWS_REGION` | optional, default `eu-north-1` |
   | `KOE_SITE_URL` | optional, default `https://koe.kennedyazeru.space` |

4. The instance must be visible to Systems Manager: Amazon Linux 2023 ships the
   agent, it only needs an instance profile carrying
   `AmazonSSMManagedInstanceCore`:

   ```bash
   aws ec2 associate-iam-instance-profile --region eu-north-1 \
     --instance-id "$KOE_INSTANCE_ID" \
     --iam-instance-profile Name=koe-ssm
   ```

   Confirm before relying on it — the list must show the instance as `Online`:

   ```bash
   aws ssm describe-instance-information --region eu-north-1 --output table
   ```

5. Automatic deploys stay off until you opt in:

   ```bash
   gh variable set KOE_AUTO_DEPLOY --body true
   ```

On each push to `main` (or each manual run) the job then: runs the tests and the
Docker build, waits for the instance to report `Online`, sends `rebuild.sh`
through `AWS-RunShellScript`, **prints the script's log in the run**, fails if its
status is not `Success`, then re-checks `/health` and **fails the build if
`db.path` is not under `/data`** — the invariant that keeps issued keys alive
across recreates. If the image build fails, `rebuild.sh` exits before touching the
running container, so the site keeps serving the previous version.

The job runs the script as `ec2-user`. Systems Manager executes commands as root,
and `git` refuses to operate on a checkout owned by another user (`detected
dubious ownership`), so the command it sends is:

```
sudo -u ec2-user -H env KOE_OPS_DIR=/home/ec2-user/koe-ops bash /home/ec2-user/koe-ops/rebuild.sh
```

Keep both parts if you run it by hand for the same reason — and keep
`KOE_OPS_DIR`, which is what makes the script read `~/koe-ops/koe.env`.

The job uses the `production` environment, so you can later require a reviewer
(one click per deploy) without editing the workflow. The trust policy above
allow-lists both `refs/heads/main` and the `production` environment: if you
rename the environment, update the policy or the role will refuse to be assumed.

Turn automatic deploys off with `gh variable set KOE_AUTO_DEPLOY --body false`, or
delete the variable. Manual runs from the Actions tab keep working either way.

## 7. Analytics

`/stats.html` is a public shell. Enter `API_KEY` once; the key is kept in that browser's local storage. The page calls the admin-only `/stats.json` and shows:

- traffic and product actions, all-time and today
- product users (real actions) versus all visitors (including bots)
- top voiceover users by words and top request sources by HTTP requests
- live capacity and the 14-day daily ledger

Counters persist to `/data/stats.json` (`KOE_STATS_FILE`). Anonymous ids are keyed HMACs via `guard.anonSubject()`; raw IPs are never stored. Existing raw-IP records are migrated on load.

The older server-rendered `/stats?key=...` report remains available as a fallback.

## 8. Operations

### Kitten sidecar (optional, 512 MB)

A second local engine that fits where Kokoro does not. The image is built from
this repo (`ops/kitten/` — a stdlib HTTP wrapper around the ONNX model), not
pulled from a registry, so `rebuild.sh` needs the checkout that has it.

```bash
cd ~/koe
docker compose up -d --build kitten   # serves 127.0.0.1:8881
docker compose logs -f kitten        # first boot downloads the weights (~25 MB)
docker compose down kitten           # stop it
```

- `KITTEN_MODEL` (default `KittenML/kitten-tts-nano-0.8-int8`), `KITTEN_MEM_LIMIT`
  (default `512m`), `KITTEN_BASE_URL` for the app (default `http://127.0.0.1:8881`).
- Output is WAV, one synthesis at a time inside the container.
- Measured on the reference build: RSS **~155 MB** after a synthesis, image
  **~300 MB**, ~6× faster than realtime for short text. `512m` therefore has real
  headroom; the first `--build` still needs network and ~300 MB of disk.
- The Dockerfile installs `kittenml` with `--no-deps` plus the modules the int8
  ONNX path actually uses. The stock install pulls torch, torchaudio, diffusers,
  transformers, spacy and 24 CUDA wheels — 6.5 GB, and `torch` is never even
  imported during a generate(). Do not "simplify" that back to a plain
  `pip install kittenml`.
- `engine: "kitten"` answers `503 {"error":"tts_unavailable","engine":"kitten"}`
  while the sidecar is down — nothing else is affected and no quota is spent.
- Voice ids: `bella` `jasper` `luna` `bruno` `rosie` `hugo` `kiki` `leo`.
- **Licence:** the KittenTTS code is Apache-2.0, but the weights are licensed
  separately per model repository — check the card of the checkpoint you set in
  `KITTEN_MODEL` before shipping it commercially.

Reaching it from the app container follows the same rule as Kokoro (§8): the
`koe` container is bridge-networked, so use `KITTEN_BASE_URL=http://kitten:8881`
on the compose network rather than `127.0.0.1`.

### Kokoro sidecar (optional)

The Kokoro engine runs in its **own container**. The app is fully functional without it — edge and piper are unaffected, and only `engine: "kokoro"` requests answer `503 {"error":"tts_unavailable","engine":"kokoro"}` (within 10s, before any quota is charged).

```bash
cd ~/koe                     # the checkout that holds docker-compose.yml
docker compose up -d          # start the sidecar
docker compose logs -f        # first boot downloads the model + warms up
docker compose ps             # health: healthy / starting
docker compose down           # stop it
docker compose pull && docker compose up -d   # after bumping tag + digest
```

The image is pinned by **digest** (`msgflux/fastkokoro:0.7-cpu@sha256:35b4…`, never `:latest`), bound to `127.0.0.1:8880` only, and capped at `cpus: "2.0"` / `mem_limit: ${KOKORO_MEM_LIMIT:-1g}` so it can never starve the app container. The healthcheck probes `GET /health` inside the container with a 180s start period for the first-boot model download.

**Pick the instance for the engine mix.** The app itself is small (Node plus a
few `edge-tts` subprocesses, all network-bound); the sidecars decide the memory
bill:

| Host | RAM | Kokoro (MP3, 82M) | Kitten (WAV, 15–80M) | `KOE_GLOBAL_CONCURRENCY` |
| --- | --- | --- | --- | --- |
| t3.micro | 1 GiB | **Don't run it.** `engine: "kokoro"` stays a clean 503. | Only if you accept ~512 MB for it | 3–4 |
| t3.small | 2 GiB | Yes, `KOKORO_MEM_LIMIT=1g` (default) | **Or** Kitten, `KITTEN_MEM_LIMIT=512m` — not both | 3–4 |
| t3.medium | 4 GiB | Yes, `KOKORO_MEM_LIMIT=2g` | Yes, `512m` | 6 |

Two rules that matter:

- **On 2 GiB, keep the sidecar at 1 GB.** The container limit protects Node only
  if the host has the memory to honour it; a 2 GB `mem_limit` on a 2 GB box means
  the kernel picks a victim, and that victim is usually the app container — jobs
  die mid-synthesis with no error in `docker logs`.
- **Keep concurrency at 3–4, not 6.** Each in-flight part is an `edge-tts`
  process (~100 MB) on top of Node, so six of them is the one default that can
  push a 2 GB host into swap.
- **Each sidecar engine is capped at 1 job in flight** (`KOE_ENGINE_CONCURRENCY`,
  default `kokoro=1,kitten=1`). A sidecar serialises inside its own container, so
  extra Kokoro/Kitten jobs would only occupy global slots while making no
  progress — with the cap they stay queued and edge jobs get the worker. Raise
  it (`kokoro=2,kitten=1`) only if you have sized the host for it.

Set both in `~/koe-ops/koe.env` and re-run `rebuild.sh` — the values are baked
into `docker run`, so a restart alone will not pick them up:

```bash
# ~/koe-ops/koe.env — rebuild.sh sources this file and forwards these three
KOE_GLOBAL_CONCURRENCY=4
KOE_PART_CONCURRENCY=1
KOE_ENGINE_CONCURRENCY=kokoro=1,kitten=1

# Compose-only ceilings (not app settings); pass the same file to compose
KOKORO_MEM_LIMIT=1g
KITTEN_MEM_LIMIT=512m
```

> `rebuild.sh` used to hardcode `-e KOE_GLOBAL_CONCURRENCY=2`, so editing the
> value in `koe.env` changed nothing — the container always came up with 2. It
> now reads the file (defaults `4` / `1` / `kokoro=1,kitten=1`) and also forwards
> `KITTEN_BASE_URL`. If a limit looks applied but `/api/limits` disagrees, check
> that the instance copy of the script is current:
> `sudo -u ec2-user cp /home/ec2-user/koe/ops/rebuild.sh /home/ec2-user/koe-ops/`.
>
> The two `*_MEM_LIMIT` values are read by docker-compose, not by the app, so
> compose needs to be pointed at the same file:
> `cd ~/koe && sudo docker compose --env-file ~/koe-ops/koe.env up -d`.

**On 2 GiB, run one sidecar, not two.** Kokoro's fp32 ONNX peaks around
1.2 GB RSS; Kitten's int8 nano around 250–400 MB. 1g + 512m + Node + Docker does
not fit in 2 GiB, and the host OOM-killer does not respect either `mem_limit`.
Kitten is the one to pick if you want a local engine on t3.small.

Resizing does not change any of this by itself: after a resize, run
`bash ~/koe-ops/rebuild.sh` so the container is recreated with the new limits.

> **First boot needs more RAM than a 1 GB instance has.** After downloading the
> model (~236 MB) the sidecar rewrites it —
> `Simplifying ONNX model for CPU: ... -> /models/onnx/*.sim.<hash>.onnx` — and
> that step never completed on the reference box (913 MB RAM, 2 vCPU, 1 GB swap):
> 10 restarts, `/models/onnx` still empty, load average 28, SSH unresponsive.
> A `mem_limit` does not save you there, because the **host** OOM-kills before
> the container's own 2 GB cgroup limit is reached — `docker inspect` then shows
> `OOMKilled=false` with `ExitCode=137`, which is misleading. On a 2-vCPU host
> `cpus: "2.0"` is not a cap at all. Once the `.sim.*` file lands it persists in
> the `kokoro-models` volume and later boots skip the step, so the options are a
> one-time pass on a larger box or an instance with more memory. **Never run
> `docker compose up -d` unattended on a 1 GB host.**

Verify from the app's side:

```bash
curl -s localhost:3000/healthz | jq '.engines'
# → { "edge": true, "piper": true, "kokoro": true, "kitten": false }
```

`kokoro: false` / `kitten: false` means that sidecar is down or still warming up — a normal state, not a fault. `GET /healthz` stays `200` either way, because a missing optional engine must never fail the watchdog.

The `koe` container is bridge-networked, so `127.0.0.1:8880` is the container's own loopback and never reaches the sidecar. The obvious-looking fix does **not** work: `--add-host=host.docker.internal:host-gateway` with `KOKORO_BASE_URL=http://host.docker.internal:8880` gets `ECONNREFUSED`, because the sidecar's port is bound to `127.0.0.1` on the host and a container arriving over the bridge gateway lands on a non-loopback interface. Verified directly on the live instance — do not reintroduce it.

Put the studio on the sidecar's Docker network instead. The sidecar listens on `0.0.0.0:8880` *inside* its own container, so a peer container on the same user-defined network reaches it by name, while the published host port stays bound to loopback and is never exposed:

```bash
docker network connect koe_default koe   # best-effort; rebuild.sh does this
KOKORO_BASE_URL=http://kokoro:8880       # compose service name (the container name
                                         # koe-kokoro resolves on that network too)
```

Leave `-p 127.0.0.1:8880:8880` exactly as `docker-compose.yml` has it. Point `KOKORO_BASE_URL` somewhere else only if the sidecar lives on a different machine (the default inside the studio process is `http://127.0.0.1:8880`, correct when the studio is not containerised).

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
| Keys/counters reset on every restart | `KOE_DB_PATH` not on the volume. `rebuild.sh` passes `KOE_DB_PATH` (default `/data/koe.db`) to the container; if you changed it, set the same value in `~/koe-ops/koe.env` and re-run `rebuild.sh` so the new `docker run` picks it up |
| Every key returns `401 {"error":"invalid_key"}` | The running image predates the v3 key store (older HMAC keys are no longer records); rebuild, and clients/pages re-mint automatically |
| `503 {"error":"temporarily_disabled"}` | `KOE_KILL_SWITCH=true` in `~/koe-ops/koe.env` — unset it and recreate the container |
| Queue stays full | Check upstream edge-tts health; the circuit breaker cools down after failures |
| Out of memory during build | Confirm the swap file exists (`swapon --show`) |

## 10. Legacy Render blueprint

`render.yaml` is kept for reference. It is not the production target and is not maintained as part of the AWS deployment. Leave the Render service alone unless you are deliberately decommissioning it.
