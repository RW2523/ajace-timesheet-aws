#!/usr/bin/env bash
# Optional extra backup: pg_dump RDS -> S3. (RDS already keeps automated
# backups/snapshots; this is a convenience export.)  Run via cron.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HERE/../.env.production"; set +a
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="/tmp/ts-db-${STAMP}.sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$OUT"
aws s3 cp "$OUT" "s3://${STORAGE_S3_BUCKET}/db-backups/ts-db-${STAMP}.sql.gz"
rm -f "$OUT"
echo "Backup -> s3://${STORAGE_S3_BUCKET}/db-backups/ts-db-${STAMP}.sql.gz"
