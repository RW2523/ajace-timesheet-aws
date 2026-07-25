#!/usr/bin/env bash
# Promote a user to admin (updates BOTH auth_users and ts_profiles).
#   deploy/scripts/make-admin.sh you@ajace.com
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HERE/../.env.production"; set +a
EMAIL="${1:?usage: make-admin.sh <email>}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "update public.auth_users set role='admin' where lower(email)=lower('${EMAIL}');" \
  -c "update public.ts_profiles set role='admin' where lower(email)=lower('${EMAIL}');" \
  -c "select email, role from public.ts_profiles where lower(email)=lower('${EMAIL}');"
