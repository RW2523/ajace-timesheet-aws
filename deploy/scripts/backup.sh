#!/usr/bin/env bash
# Nightly logical backup: pg_dump RDS -> S3, verified, with retention.
# install.sh installs this as a cron job — previously the header said "run via
# cron" and nothing ever did, so there were no backups at all.
#
# Deliberately belt-and-braces alongside RDS automated backups: RDS retention is
# 7 days, shorter than a monthly payroll cycle, and a logical dump also survives
# someone deleting the RDS instance itself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HERE/../.env.production"; set +a
: "${DATABASE_URL:?}" ; : "${STORAGE_S3_BUCKET:?}"
KEEP_DAYS="${BACKUP_RETENTION_DAYS:-90}"
REGION="${STORAGE_S3_REGION:-us-east-1}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="/tmp/ts-db-${STAMP}.sql.gz"
KEY="db-backups/ts-db-${STAMP}.sql.gz"
trap 'rm -f "$OUT"' EXIT

pg_dump "$DATABASE_URL" | gzip > "$OUT"

# A backup you have not verified is not a backup: check the gzip stream is
# intact and the dump really contains our tables before shipping it.
gzip -t "$OUT"
if ! gzip -dc "$OUT" | grep -q "ts_employee_edits"; then
  echo "✗ dump does not mention ts_employee_edits — NOT uploading" >&2
  exit 1
fi
SIZE=$(wc -c < "$OUT")
[ "$SIZE" -gt 1024 ] || { echo "✗ dump suspiciously small ($SIZE bytes)" >&2; exit 1; }

aws s3 cp "$OUT" "s3://${STORAGE_S3_BUCKET}/${KEY}" --region "$REGION" >/dev/null
echo "✓ backup -> s3://${STORAGE_S3_BUCKET}/${KEY} ($((SIZE/1024)) KB)"

# Retention: drop dumps older than KEEP_DAYS.
CUTOFF=$(date -u -d "-${KEEP_DAYS} days" +%Y-%m-%d 2>/dev/null || date -u -v-"${KEEP_DAYS}"d +%Y-%m-%d)
aws s3 ls "s3://${STORAGE_S3_BUCKET}/db-backups/" --region "$REGION" 2>/dev/null | while read -r d _ _ f; do
  [ -n "${f:-}" ] || continue
  if [[ "$d" < "$CUTOFF" ]]; then
    aws s3 rm "s3://${STORAGE_S3_BUCKET}/db-backups/$f" --region "$REGION" >/dev/null && echo "  pruned $f"
  fi
done
exit 0
