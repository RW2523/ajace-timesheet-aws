#!/usr/bin/env bash
# Run the test suite against a throwaway database, then clean up.
#
# Two modes, picked automatically:
#   docker present  -> a disposable Postgres container (local dev)
#   no docker       -> a SCRATCH DATABASE on the server in DATABASE_URL (the
#                      EC2 box, which has RDS but deliberately no Docker — a
#                      2 GB box shared with payroll should not run a container
#                      engine just to test)
#
# The live database is never touched: the scratch DB has its own name and is
# dropped at the end, and the suite refuses to run without one.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUITE=(data-layer review-flow derived-totals derivation-escape)

run_suite() {  # $1 = connection string
  export DATABASE_URL="$1" PGSSL="${PGSSL:-disable}"
  local rc=0
  for t in "${SUITE[@]}"; do
    node "$ROOT/test/$t.test.mjs" || rc=1
  done
  return $rc
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  PORT="${PGPORT_TEST:-55432}"; NAME=ts-test-pg
  cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  echo "==> disposable Postgres container on :$PORT"
  cleanup
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=timesheet \
    -p "$PORT:5432" postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$NAME" pg_isready -U postgres -d timesheet >/dev/null 2>&1 && break
    sleep 1
  done
  PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PORT" -U postgres -d timesheet \
    -v ON_ERROR_STOP=1 -q -f "$ROOT/deploy/db/schema.sql"
  run_suite "postgresql://postgres:postgres@127.0.0.1:$PORT/timesheet"
  exit $?
fi

# ---- no docker: scratch database on the configured server --------------------
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env.production" ]; then
  set -a; . "$ROOT/.env.production"; set +a
fi
: "${DATABASE_URL:?no docker and no DATABASE_URL — cannot create a test database}"

BASE="${DATABASE_URL%/*}"                 # everything up to the db name
LIVE_DB="${DATABASE_URL##*/}"
SCRATCH="ts_test_$$"
echo "==> scratch database $SCRATCH on the same server (live '$LIVE_DB' untouched)"
drop_scratch() {
  psql "$DATABASE_URL" -q -c "drop database if exists $SCRATCH" >/dev/null 2>&1 || true
}
trap drop_scratch EXIT
psql "$DATABASE_URL" -q -c "create database $SCRATCH" >/dev/null
psql "$BASE/$SCRATCH" -v ON_ERROR_STOP=1 -q -f "$ROOT/deploy/db/schema.sql"
# RDS needs TLS; the schema/pool use the AWS CA chain, so don't force it off here.
PGSSL="${PGSSL:-}" run_suite "$BASE/$SCRATCH"
