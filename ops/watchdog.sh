#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="${KOE_OPS_DIR:-/home/ec2-user/koe-ops}"
LOG="$OPS_DIR/koe-watchdog.log"
ENV_FILE="$OPS_DIR/koe.env"
HEALTH_URL="http://127.0.0.1:8080/health"

mkdir -p "$OPS_DIR"
ts() { date '+%F %T'; }

if ! curl -fsS -m 10 "$HEALTH_URL" >/dev/null 2>&1; then
  echo "$(ts) koe unhealthy -> restart" >> "$LOG"
  sudo docker restart koe >/dev/null 2>&1 || true
  sleep 3
  if ! curl -fsS -m 10 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "$(ts) still unhealthy -> rebuild" >> "$LOG"
    if [ -f "$ENV_FILE" ]; then
      # shellcheck disable=SC1090
      source "$ENV_FILE"
    fi
    bash "$OPS_DIR/rebuild.sh" >> "$LOG" 2>&1 || true
  fi
fi

if [ "$(sudo docker inspect -f '{{.State.Running}}' caddy 2>/dev/null)" != "true" ]; then
  echo "$(ts) caddy not running -> recreate" >> "$LOG"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
  fi
  : "${KOE_DOMAIN:?KOE_DOMAIN is missing from $ENV_FILE}"
  sudo docker rm -f caddy >/dev/null 2>&1 || true
  mkdir -p /home/ec2-user/caddy/data /home/ec2-user/caddy/config
  sudo docker run -d --name caddy --restart unless-stopped --network host \
    -e KOE_DOMAIN="$KOE_DOMAIN" \
    -v "$OPS_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v /home/ec2-user/caddy/data:/data \
    -v /home/ec2-user/caddy/config:/config \
    caddy:2-alpine >/dev/null
fi

if ! curl -fsS -m 10 "https://${KOE_DOMAIN:-koe.example.com}/health" >/dev/null 2>&1; then
  echo "$(ts) WARN: external https /health failed" >> "$LOG"
fi
echo "$(ts) ok" >> "$LOG"
