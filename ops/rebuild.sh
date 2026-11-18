#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="${KOE_OPS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ENV_FILE="$OPS_DIR/koe.env"

[ -f "$ENV_FILE" ] || { echo "MISSING $ENV_FILE - copy ops/koe.env.example and fill it in"; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

REPO_DIR="${KOE_REPO_DIR:-/home/ec2-user/koe}"
BRANCH="${KOE_BRANCH:-main}"
REPO_URL="${KOE_REPO_URL:-https://github.com/Azeru548/koe.git}"
: "${KOE_DOMAIN:?KOE_DOMAIN is missing from $ENV_FILE}"
: "${KOE_SECRET:?KOE_SECRET is missing from $ENV_FILE}"
: "${API_KEY:?API_KEY is missing from $ENV_FILE}"

echo "=== [1/6] swap ==="
grep -q "/swapfile" /proc/swaps || {
  sudo fallocate -l 1024M /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=1024
  sudo chmod 600 /swapfile
  sudo mkswap -q /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
}
swapon --show

echo "=== [2/6] docker + git ==="
command -v docker >/dev/null || sudo dnf install -y docker git
sudo systemctl enable --now docker

echo "=== [3/6] repo ==="
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch --prune origin "$BRANCH"
# The instance is a deployment target, not a working copy: make it match Git.
git -C "$REPO_DIR" reset --hard "origin/$BRANCH"

echo "=== [4/6] image ==="
sudo docker build -t koe "$REPO_DIR" 2>&1 | tail -3

echo "=== [5/6] run koe (internal port) ==="
DATA_DIR="${KOE_DATA_DIR:-/home/ec2-user/koe-data}"
mkdir -p "$DATA_DIR"

# ── preserve the issued-key/usage database from the container being replaced ──
# Images built before KOE_DB_PATH was passed stored the database at
# /app/koe.db — INSIDE the container — so `docker rm -f` destroys every issued
# key, usage counter and mint cap. Before removing it, take that database out.
#
#   • a database already on the volume always wins: it is the newer one, and
#     this step never overwrites it;
#   • the old container is stopped first so the copy is not a torn snapshot;
#   • the copy is only accepted if it really is a SQLite file;
#   • a failure never aborts the deploy — it prints the manual command instead,
#     because keys are recoverable (clients re-mint on 401) and a half-deployed
#     box is not.
DB_IN_CONTAINER="${KOE_DB_PATH:-/data/koe.db}"
HOST_DB=""
case "$DB_IN_CONTAINER" in
  /data/*) HOST_DB="$DATA_DIR/${DB_IN_CONTAINER#/data/}" ;;
  *) echo "WARN: KOE_DB_PATH=$DB_IN_CONTAINER is not under /data — keys will not persist across recreates" ;;
esac

if [ -f "$HOST_DB" ]; then
  echo "keys: keeping the database already on the volume ($HOST_DB)"
elif [ -n "$HOST_DB" ] && sudo docker inspect koe >/dev/null 2>&1; then
  OLD_DB="$(sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' koe 2>/dev/null | sed -n 's/^KOE_DB_PATH=//p')"
  OLD_DB="$(printf '%s' "$OLD_DB" | tr -d '\r')"
  OLD_DB="${OLD_DB:-/app/koe.db}"
  if [ "$OLD_DB" = "$DB_IN_CONTAINER" ]; then
    echo "keys: the previous container already used the volume ($OLD_DB) — nothing to copy"
  else
    STAGE="$(mktemp -d)"
    sudo docker stop koe >/dev/null 2>&1 || true
    if sudo docker cp "koe:$OLD_DB" "$STAGE/$(basename "$HOST_DB")" >/dev/null 2>&1; then
      if [ "$(sudo head -c 15 "$STAGE/$(basename "$HOST_DB")" 2>/dev/null)" = "SQLite format 3" ]; then
        for suffix in -journal -wal -shm; do
          sudo docker cp "koe:$OLD_DB$suffix" "$STAGE/$(basename "$HOST_DB")$suffix" >/dev/null 2>&1 || true
        done
        sudo cp -a "$STAGE"/. "$DATA_DIR"/
        echo "keys: preserved $OLD_DB from the previous container → $HOST_DB"
      else
        echo "WARN: $OLD_DB in the previous container is not a SQLite database — left it alone."
        echo "      If that container held issued keys they are lost on recreate; clients re-mint on 401."
        echo "      Inspect it before deleting anything: sudo docker cp koe:$OLD_DB /tmp/koe-inspect.db"
      fi
    else
      echo "keys: no database at $OLD_DB in the previous container — starting with a fresh one."
      echo "      If it did hold issued keys, copy it out first: sudo docker cp koe:$OLD_DB $HOST_DB"
    fi
    rm -rf "$STAGE"
  fi
fi

sudo docker rm -f koe 2>/dev/null || true

# The app image runs as the unprivileged `node` user (uid 1000). Everything on
# the volume was created by the older root-running containers, so hand it over
# before starting; without this the new container cannot write its own database
# and every request answers 503 until someone notices.
if [ -d "$DATA_DIR" ] && ! sudo chown -R 1000:1000 "$DATA_DIR"; then
  echo "WARN: could not hand $DATA_DIR to uid 1000 — the container may fail to write its database"
fi

# `--init` puts a real PID 1 in front of Node, so SIGTERM from `docker stop`
# reaches the server's shutdown handler instead of being swallowed.
sudo docker run -d --name koe --restart unless-stopped --init \
  -p 127.0.0.1:8080:3000 \
  -e KOKORO_BASE_URL="${KOKORO_BASE_URL:-http://kokoro:8880}" \
  -e KITTEN_BASE_URL="${KITTEN_BASE_URL:-http://kitten:8881}" \
  -e TTS_BACKEND=native \
  -e KOE_PUBLIC_URL="https://${KOE_DOMAIN}" \
  -e KOE_SECRET="$KOE_SECRET" \
  -e KOE_REQUIRE_KEY=true \
  -e KOE_GLOBAL_CONCURRENCY="${KOE_GLOBAL_CONCURRENCY:-4}" \
  -e KOE_PART_CONCURRENCY="${KOE_PART_CONCURRENCY:-1}" \
  -e KOE_ENGINE_CONCURRENCY="${KOE_ENGINE_CONCURRENCY:-kokoro=1,kitten=1}" \
  -e KOE_MAX_JOB_WORDS="${KOE_MAX_JOB_WORDS:-2000}" \
  -e KOE_ENGINE_MAX_WORDS="${KOE_ENGINE_MAX_WORDS:-kitten=900}" \
  -e KOE_GLOBAL_QUEUE=20 \
  -e KOE_GLOBAL_WORDS_DAY=30000 \
  -e KOE_AUDIO_TTL_SEC=900 \
  -e KOE_JOB_TTL_SEC=3600 \
  -e API_KEY="$API_KEY" \
  -v "$DATA_DIR":/data \
  -e KOE_DB_PATH="${KOE_DB_PATH:-/data/koe.db}" \
  -e KOE_STATS_FILE=/data/stats.json \
  -e KOE_JOBS_FILE=/data/jobs.json \
  -e KOE_STATE_FILE=/data/state.json \
  koe

# Kokoro reachability — the sidecar publishes 127.0.0.1:8880 on the HOST, so a
# container can never reach it via host.docker.internal/host-gateway: that
# arrives on the bridge interface, not loopback, and is refused
# (ECONNREFUSED, verified on the live instance). Instead the studio joins the
# sidecar's own Docker network and reaches it by name, so the host port stays
# bound to loopback and is never exposed. MUST run after `docker run` above —
# the container has to exist first. Best-effort: with no sidecar deployed the
# network may not exist and the engine simply reports unavailable, which is the
# documented optional behaviour.
sudo docker network connect koe_default koe >/dev/null 2>&1 || true
echo "=== [6/6] caddy ==="
mkdir -p /home/ec2-user/caddy/data /home/ec2-user/caddy/config
[ -f "$OPS_DIR/Caddyfile" ] || cp "$REPO_DIR/ops/Caddyfile" "$OPS_DIR/Caddyfile"
sudo docker rm -f caddy 2>/dev/null || true
sudo docker run -d --name caddy --restart unless-stopped --network host \
  -e KOE_DOMAIN="$KOE_DOMAIN" \
  -v "$OPS_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v /home/ec2-user/caddy/data:/data \
  -v /home/ec2-user/caddy/config:/config \
  caddy:2-alpine >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS -m 10 "https://${KOE_DOMAIN}/health" >/dev/null 2>&1; then
    echo "REBUILD_OK"
    exit 0
  fi
  sleep 3
done

echo "REBUILD_INCOMPLETE - check: sudo docker logs koe; sudo docker logs caddy"
echo "If this is a new instance, update the DNS A record to: $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
exit 1
