# Koe AWS ops

Canonical copies of the scripts and systemd units used on the production EC2
instance. The full runbook is [../DEPLOY.md](../DEPLOY.md).

| File | Purpose |
| --- | --- |
| `rebuild.sh` | Pull the deployment branch, build the image, recreate `koe` and `caddy`. |
| `watchdog.sh` | Every 2 minutes: restart an unhealthy `koe`; rebuild if it stays down; recreate `caddy` if needed. |
| `disk-guard.sh` | Daily: log root usage; `docker system prune` at 85%; clean old `/tmp` files. |
| `Caddyfile` | TLS reverse proxy. Set `KOE_DOMAIN` in `koe.env`; Caddy obtains the certificate. |
| `koe.env.example` | Secret-bearing deploy env. Copy to `~/koe-ops/koe.env` and fill in. |
| `systemd/` | Unit and timer files for the watchdog and disk guard. |

Install on the instance:

```bash
mkdir -p ~/koe-ops
cp ops/koe.env.example ~/koe-ops/koe.env
cp ops/rebuild.sh ops/watchdog.sh ops/disk-guard.sh ops/Caddyfile ~/koe-ops/
chmod +x ~/koe-ops/*.sh
# edit ~/koe-ops/koe.env, then:
sudo cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now koe-watchdog.timer koe-diskguard.timer
bash ~/koe-ops/rebuild.sh
```

`rebuild.sh` runs `git reset --hard origin/main` in `/home/ec2-user/koe`.
Treat the instance checkout as a deployment artifact, not a working tree.
