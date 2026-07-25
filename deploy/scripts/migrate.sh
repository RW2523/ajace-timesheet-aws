#!/usr/bin/env bash
# Create the schema in RDS.  DATABASE_URL comes from app/.env.production.
#   deploy/scripts/migrate.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$HERE/../.env.production"
[ -f "$ENVF" ] || { echo "missing app/.env.production (copy from env.production.example)"; exit 1; }
set -a; . "$ENVF"; set +a
: "${DATABASE_URL:?DATABASE_URL not set}"

echo "== applying schema.sql to RDS =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/db/schema.sql"
echo "Schema applied. auth_users + ts_* tables + ai_flow=direct_serverless are ready."
