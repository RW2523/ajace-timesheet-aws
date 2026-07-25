#!/usr/bin/env bash
# Set (or reset) a user's password from the box, and sign out their existing
# sessions. Run ON the EC2 host.
#
#   deploy/scripts/set-password.sh employee@ajace.com
#
# Why this exists: password-reset email needs SES to be verified and out of the
# sandbox, which takes ~a day. Until then "forgot password" delivers nothing, so
# a forgotten password would lock an employee out permanently. With ~20
# non-technical users logging in once a month, that is the single most likely
# support request.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
set -a; . "$ROOT/.env.production"; set +a
EMAIL="${1:-}"
[ -n "$EMAIL" ] || { echo "usage: $0 <email>"; exit 1; }

read -r -s -p "New password for $EMAIL (min ${PASSWORD_MIN_LENGTH:-10} chars): " PW; echo
read -r -s -p "Repeat: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "✗ passwords don't match"; exit 1; }
[ "${#PW}" -ge "${PASSWORD_MIN_LENGTH:-10}" ] || { echo "✗ too short"; exit 1; }

HASH=$(cd "$ROOT" && PW="$PW" node -e \
  'console.log(require("bcryptjs").hashSync(process.env.PW, 10))')

# Bumping session_version signs out every existing session for this user, which
# is the point when you are resetting a password you think may be compromised.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "update public.auth_users
      set password_hash='$HASH', reset_token=null, reset_expires=null,
          session_version = session_version + 1
    where lower(email)=lower('$EMAIL')" \
  && echo "✓ password set for $EMAIL — all their existing sessions are now signed out"

psql "$DATABASE_URL" -tAc \
  "select case when count(*)=0 then '⚠ no such user — nothing changed' else '' end
     from public.auth_users where lower(email)=lower('$EMAIL')"
