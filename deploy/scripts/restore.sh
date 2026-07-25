#!/usr/bin/env bash
# Restore the database from an S3 backup. A backup with no tested restore path
# is a guess, so this is the other half of backup.sh.
#
#   deploy/scripts/restore.sh                 # list available backups
#   deploy/scripts/restore.sh <key>           # restore into a scratch DB and verify
#   deploy/scripts/restore.sh <key> --live    # DESTRUCTIVE: restore over the live DB
#
# Default behaviour is the safe one: it restores into a throwaway database and
# reports the row counts, which is how you rehearse a restore without risk.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HERE/../.env.production"; set +a
: "${DATABASE_URL:?}" ; : "${STORAGE_S3_BUCKET:?}"
REGION="${STORAGE_S3_REGION:-us-east-1}"

if [ $# -eq 0 ]; then
  echo "Available backups in s3://${STORAGE_S3_BUCKET}/db-backups/ :"
  aws s3 ls "s3://${STORAGE_S3_BUCKET}/db-backups/" --region "$REGION" | tail -20
  echo
  echo "Restore a rehearsal copy:  $0 ts-db-YYYYMMDD-HHMMSS.sql.gz"
  echo "Restore over LIVE data  :  $0 ts-db-YYYYMMDD-HHMMSS.sql.gz --live"
  exit 0
fi

FILE="$1"; LIVE="${2:-}"
TMP="/tmp/$FILE"
aws s3 cp "s3://${STORAGE_S3_BUCKET}/db-backups/${FILE}" "$TMP" --region "$REGION"
gzip -t "$TMP"

# Split the connection string so we can point at a different database name.
BASE="${DATABASE_URL%/*}"          # everything up to the db name
LIVE_DB="${DATABASE_URL##*/}"

if [ "$LIVE" = "--live" ]; then
  echo "⚠ THIS OVERWRITES THE LIVE DATABASE ($LIVE_DB). Every row not in the"
  echo "  backup will be gone. Take a fresh backup first if you have not."
  read -r -p "Type RESTORE to confirm: " c
  [ "$c" = "RESTORE" ] || { echo "aborted."; exit 1; }
  echo "==> stopping the app so nothing writes mid-restore"
  pm2 stop ajace-timesheet >/dev/null 2>&1 || true
  gzip -dc "$TMP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
  pm2 start ajace-timesheet >/dev/null 2>&1 || pm2 restart ajace-timesheet >/dev/null 2>&1 || true
  echo "✓ restored into $LIVE_DB and restarted the app"
  TARGET="$DATABASE_URL"
else
  SCRATCH="restore_check_$(date -u +%H%M%S)"
  echo "==> rehearsing into scratch database '$SCRATCH' (live data untouched)"
  psql "$DATABASE_URL" -q -c "create database $SCRATCH" >/dev/null
  gzip -dc "$TMP" | psql "$BASE/$SCRATCH" -v ON_ERROR_STOP=1 -q
  TARGET="$BASE/$SCRATCH"
fi

echo
echo "Row counts in the restored copy:"
psql "$TARGET" -q -c "select 'auth_users' t, count(*) from auth_users
  union all select 'ts_profiles', count(*) from ts_profiles
  union all select 'ts_employee_edits', count(*) from ts_employee_edits
  union all select 'ts_timesheets', count(*) from ts_timesheets
  union all select 'ts_files', count(*) from ts_files;"

if [ "$LIVE" != "--live" ]; then
  echo
  echo "Rehearsal complete. Drop the scratch copy when you're done:"
  echo "  psql \"\$DATABASE_URL\" -c 'drop database ${TARGET##*/}'"
fi
rm -f "$TMP"
