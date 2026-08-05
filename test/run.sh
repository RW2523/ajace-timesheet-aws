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
SUITE=(data-layer review-flow derived-totals derivation-escape draft-resume corrected-grid fields-provenance)

# Syntax gate first: needs no database, so it runs even when the DB checks
# below would abort. Do NOT replace this with `node --check`: on Node >= 20 a
# file containing import/export is treated as ESM and `--check` exits 0 without
# reporting parse errors, so it is green on every file in app/, components/ and
# lib/ no matter how broken they are. See the header of test/syntax.test.mjs.
echo "==> syntax gate"
node "$ROOT/test/syntax.test.mjs"

# Pure-function checks that need no database either, so they also run on a box
# with no DATABASE_URL. bulk-fill asserts what the SERVER derives from a
# bulk-filled `days` array, so it must not be skippable.
echo "==> pure checks"
node "$ROOT/test/bulk-fill.test.mjs"
# holiday-toggle asserts what the SERVER derives after the US-holiday
# Worked / Not-worked clicks, so it must not be skippable either.
node "$ROOT/test/holiday-toggle.test.mjs"
# questionnaire-contract compares DashboardClient's <Questionnaire> call against
# Questionnaire's own parameter list. React drops unknown props and defaults
# missing ones in silence, so a mismatch here is invisible to the syntax gate
# and to every behavioural test — it shipped once, and it disabled the holiday
# toggles (hours stayed in `days` and were still paid) and the manager-approval
# seeding (every employee asked to attest "not approved"). Needs no database.
node "$ROOT/test/questionnaire-contract.test.mjs"
# preview asserts that the file picker refuses exactly what /api/storage/upload
# refuses, and that every accepted extension has a defined preview outcome. A
# regression here detaches a document from a payroll submission with only an
# amber note. Needs no database.
node "$ROOT/test/preview.test.mjs"

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

# Is there a USABLE docker? The probe is bounded on purpose. With the Docker
# CLI installed but the daemon stopped (Docker Desktop quit, colima down),
# `docker info` does not fail — it blocks indefinitely waiting for a socket
# that will never answer. Unbounded, that hung this script before a single
# test ran, so the suite looked like it was working when nothing had executed.
# A timeout is treated as "no docker", which falls through to the scratch
# database path below: the safe direction, because that path still runs every
# test rather than skipping any.
docker_usable() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 &
  local probe=$! waited=0
  while [ "$waited" -lt "${DOCKER_PROBE_TIMEOUT:-10}" ]; do
    if ! kill -0 "$probe" 2>/dev/null; then
      wait "$probe"; return $?          # daemon answered: its own exit code decides
    fi
    sleep 1; waited=$((waited + 1))
  done
  kill -9 "$probe" 2>/dev/null || true
  wait "$probe" 2>/dev/null || true
  echo "    docker CLI present but the daemon did not answer in ${DOCKER_PROBE_TIMEOUT:-10}s — using the scratch database instead" >&2
  return 1
}

if docker_usable; then
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
# This path defaults to TLS because the server it was written for is RDS, which
# refuses plaintext. A caller pointing it at a LOCAL plaintext cluster opts out
# with PGSSL=disable in the environment. Read once, HERE, because run_suite
# rewrites PGSSL on every call. Note the `-` not `:-`: an empty PGSSL must NOT
# count as "disable", for the reason spelled out inside run_suite.
CALLER_PGSSL="${PGSSL-}"
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
# Empty second argument => TLS, which RDS requires. Only a literal "disable",
# set by the caller before this script ran, selects plaintext.
run_suite "$BASE/$SCRATCH" "$CALLER_PGSSL"
