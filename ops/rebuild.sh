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
mkdir -p /home/ec2-user/koe-data
sudo docker rm -f koe 2>/dev/null || true
sudo docker run -d --name koe --restart unless-stopped \
  -p 127.0.0.1:8080:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e KOKORO_BASE_URL="http://host.docker.internal:8880" \
  -e TTS_BACKEND=native \
  -e KOE_PUBLIC_URL="https://${KOE_DOMAIN}" \
  -e KOE_SECRET="$KOE_SECRET" \
  -e KOE_REQUIRE_KEY=true \
  -e KOE_GLOBAL_CONCURRENCY=2 \
  -e KOE_GLOBAL_QUEUE=20 \
  -e KOE_GLOBAL_WORDS_DAY=30000 \
  -e KOE_AUDIO_TTL_SEC=900 \
  -e KOE_JOB_TTL_SEC=3600 \
  -e API_KEY="$API_KEY" \
  -v /home/ec2-user/koe-data:/data \
  -e KOE_STATS_FILE=/data/stats.json \
  -e KOE_JOBS_FILE=/data/jobs.json \
  -e KOE_STATE_FILE=/data/state.json \
  koe

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
