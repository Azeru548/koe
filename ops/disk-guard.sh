#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="${KOE_OPS_DIR:-/home/ec2-user/koe-ops}"
LOG="$OPS_DIR/koe-diskguard.log"
mkdir -p "$OPS_DIR"

USE=$(df --output=pcent / | tail -1 | tr -d ' %')
echo "$(date '+%F %T') root usage ${USE}%" >> "$LOG"

if [ "$USE" -ge 85 ]; then
  echo "at or above threshold -> docker prune" >> "$LOG"
  sudo docker system prune -f >> "$LOG" 2>&1
  USE2=$(df --output=pcent / | tail -1 | tr -d ' %')
  echo "after prune: ${USE2}%" >> "$LOG"
fi

find /tmp -type f -mtime +7 -user ec2-user -delete 2>/dev/null || true
