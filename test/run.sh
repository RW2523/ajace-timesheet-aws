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

run_suite() {  # $1 = connection string, $2 = "disable" for plaintext, else TLS
  export DATABASE_URL="$1"
  # Set explicitly from the argument. Do NOT write this as ${PGSSL:-disable}:
  # `:-` substitutes on EMPTY as well as unset, so passing PGSSL="" still
  # selected "disable" and node connected to RDS in the clear, which RDS
  # rejects with "no pg_hba.conf entry ... no encryption".
  if [ "${2:-}" = "disable" ]; then export PGSSL=disable; else unset PGSSL; fi
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
  run_suite "postgresql://postgres:postgres@127.0.0.1:$PORT/timesheet" disable
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
# Kept separate because run_suite re-exports DATABASE_URL to point at the
# scratch database: dropping it through that connection would fail with
# "cannot drop the currently open database" and leak the scratch DB on RDS.
ADMIN_URL="$DATABASE_URL"
echo "==> scratch database $SCRATCH on the same server (live '$LIVE_DB' untouched)"
drop_scratch() {
  psql "$ADMIN_URL" -q -c "drop database if exists $SCRATCH" >/dev/null 2>&1 || true
}
trap drop_scratch EXIT
# Sweep scratch databases left behind by an interrupted run. They are ours by
# name and always disposable, so a leak never accumulates on a shared RDS.
for old in $(psql "$ADMIN_URL" -tAc \
      "select datname from pg_database where datname like 'ts\\_test\\_%'" 2>/dev/null); do
  echo "    dropping orphaned $old"
  psql "$ADMIN_URL" -q -c "drop database if exists $old" >/dev/null 2>&1 || true
done

psql "$ADMIN_URL" -q -c "create database $SCRATCH" >/dev/null
psql "$BASE/$SCRATCH" -v ON_ERROR_STOP=1 -q -f "$ROOT/deploy/db/schema.sql"
# No second argument => TLS, which RDS requires.
run_suite "$BASE/$SCRATCH"
