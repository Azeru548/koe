#!/usr/bin/env bash
# Nightly backup of the issued-key / usage-counter database.
#
# That one file is the only state Koe cannot regenerate: a lost volume forces
# every client to re-mint a key and wipes the usage history. Copying a live
# SQLite file can capture a torn write, so this uses SQLite's own online backup
# API (inside the app image, which already ships python3) and verifies the copy
# before pruning old ones.
#
#   ./backup.sh                          # uses the defaults below
#   KOE_BACKUP_S3=s3://my-bucket/koe ./backup.sh   # also upload (needs aws cli)
#
# Suggested cron entry (see DEPLOY.md §Backups):
#   0 3 * * * ec2-user /home/ec2-user/koe-ops/backup.sh >> /home/ec2-user/koe-ops/backup.log 2>&1
set -euo pipefail

DATA_DIR="${KOE_DATA_DIR:-/home/ec2-user/koe-data}"
DB_NAME="${KOE_DB_NAME:-koe.db}"
KEEP_DAYS="${KOE_BACKUP_DAYS:-14}"
IMAGE="${KOE_IMAGE:-koe}"

DEST_DIR="$DATA_DIR/backups"
# The runner mounts DATA_DIR at /data, so the destination has to live there too.
OUT_NAME="koe-$(date -u +%Y%m%d-%H%M%S).db"

if [ ! -f "$DATA_DIR/$DB_NAME" ]; then
  echo "backup: no database at $DATA_DIR/$DB_NAME — nothing to back up"
  exit 1
fi

mkdir -p "$DEST_DIR" 2>/dev/null || sudo mkdir -p "$DEST_DIR"

echo "backup: $DATA_DIR/$DB_NAME -> $DEST_DIR/$OUT_NAME"
# --user 0: the image runs as the unprivileged `node` user, but the volume may
# still be root-owned (e.g. a first run before rebuild.sh hands it over).
# -i is required: the Python program arrives on stdin.
sudo docker run --rm -i --user 0:0 -v "$DATA_DIR":/data "$IMAGE" \
  python3 - "$DB_NAME" "/data/backups/$OUT_NAME" <<'PY'
import sqlite3
import sys

source, target = "/data/" + sys.argv[1], sys.argv[2]
with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
    src.backup(dst)          # consistent snapshot, even while the app writes
with sqlite3.connect(target) as check:
    result = check.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        sys.exit(f"backup FAILED integrity check: {result}")
    print("backup: integrity ok,", check.execute("PRAGMA page_count").fetchone()[0], "pages")
PY

sudo chown "$(id -u):$(id -g)" "$DEST_DIR/$OUT_NAME" 2>/dev/null || true

if [ -n "${KOE_BACKUP_S3:-}" ]; then
  echo "backup: uploading to ${KOE_BACKUP_S3%/}/$OUT_NAME"
  # Loud on failure: a silent backup that stopped uploading is worse than none.
  aws s3 cp "$DEST_DIR/$OUT_NAME" "${KOE_BACKUP_S3%/}/$OUT_NAME"
fi

echo "backup: pruning copies older than ${KEEP_DAYS} days"
find "$DEST_DIR" -maxdepth 1 -name 'koe-*.db' -type f -mtime "+$KEEP_DAYS" -print -delete

echo "backup: done — $(find "$DEST_DIR" -maxdepth 1 -name 'koe-*.db' -type f | wc -l) copy(ies) kept in $DEST_DIR"
