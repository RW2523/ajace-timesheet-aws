#!/usr/bin/env bash
# Spin up a throwaway Postgres, apply the real schema, run the data-layer tests,
# then clean up. Needs Docker. Nothing here touches AWS or any real data.
#
#   bash test/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PGPORT_TEST:-55432}"
NAME=ts-test-pg

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting throwaway Postgres on :$PORT"
cleanup
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=timesheet \
  -p "$PORT:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d timesheet >/dev/null 2>&1 && break
  sleep 1
done

echo "==> applying deploy/db/schema.sql"
PGPASSWORD=postgres psql -h 127.0.0.1 -p "$PORT" -U postgres -d timesheet \
  -v ON_ERROR_STOP=1 -q -f "$ROOT/deploy/db/schema.sql"

echo "==> running tests"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$PORT/timesheet" PGSSL=disable \
  node "$ROOT/test/data-layer.test.mjs"
