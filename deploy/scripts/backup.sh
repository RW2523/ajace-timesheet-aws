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
KEY="db-backups/ts-db-${STAMP}.sql.gz"

# ---------------------------------------------- the dump is 0600 from birth
# What is about to be written here is the ENTIRE payroll database — every
# employee row and every password hash. It used to be created as
# /tmp/ts-db-<stamp>.sql.gz by a plain `> "$OUT"` under the default umask (022),
# i.e. mode 0644: readable by every account on the box for the whole dump +
# verify + upload window, in a world-WRITABLE directory whose name was
# predictable to the second. That is the one place the repo's own "secrets are
# 0600" rule (install.sh's harden_env and its `(umask 077; … )` wrappers) had
# not been applied.
#
# Both halves of that are closed here:
#   · `mktemp -d` makes an unguessable 0700 directory, so no other account can
#     read what lands in it — and cannot pre-create the dump's path as a symlink
#     either, which a fixed name in /tmp always allowed;
#   · `umask 077` scopes to the SUBSHELL that performs the redirect. It has to
#     be there and not a later chmod: `> "$OUT"` is done by the shell BEFORE
#     pg_dump runs, so a chmod afterwards only narrows a file that already spent
#     the whole dump readable.
# Under `set -o pipefail` the subshell's status is still the pipeline's status,
# so a pg_dump failure aborts the run exactly as it did before.
#
# The S3 object name is unchanged ($KEY still uses $STAMP) — restore.sh and the
# retention sweep below are unaffected by the local file moving.
#
# PRE-EXISTING, deliberately NOT changed here: $DATABASE_URL is passed as an
# argv, so the RDS password is visible to any local account via `ps aux` for the
# life of the dump. Every psql/pg_dump call in this repo does that (install.sh,
# enable-https.sh, migrate.sh, restore.sh, set-password.sh); it wants fixing in
# all of them at once, and it matters the moment this box gains a second user.
DUMPDIR="$(umask 077; mktemp -d /tmp/ts-backup.XXXXXX)"
OUT="$DUMPDIR/ts-db-${STAMP}.sql.gz"
trap 'rm -rf "$DUMPDIR"' EXIT

(umask 077; pg_dump "$DATABASE_URL" | gzip > "$OUT")

# A backup you have not verified is not a backup: check the gzip stream is
# intact and the dump really contains our tables before shipping it.
gzip -t "$OUT"
# `grep -c … >/dev/null`, NOT `grep -q`. This line runs under `set -o pipefail`,
# and -q makes grep exit at the FIRST match — which SIGPIPEs the gzip still
# writing behind it. gzip dies on 141, pipefail promotes that to the pipeline's
# status, and this check reports "the dump does not mention ts_employee_edits"
# for a dump that plainly does. It only shows up once the dump is bigger than a
# pipe buffer, i.e. on every real payroll dump and on none of the small ones you
# would test with — so the nightly cron backup uploads nothing, and the cutover
# dies at [4b] ("Pre-cutover database backup FAILED", enable-https.sh) blaming
# AWS credentials. Reproduced off-box, under bash, with a stub pg_dump: a 202 KB
# dump gives `grep -q` status 141 and PIPESTATUS "141 0" while the pattern is
# plainly present; a one-line dump gives 0. Nothing here is macOS-specific —
# gzip installs no SIGPIPE handler, so the same holds for bash + GNU gzip on the
# box. -c reads the stream to the end, so the pipeline's status is grep's own:
# 0 when it matched, 1 when it did not.
if ! gzip -dc "$OUT" | grep -c "ts_employee_edits" >/dev/null; then
  echo "✗ dump does not mention ts_employee_edits — NOT uploading" >&2
  exit 1
fi
SIZE=$(wc -c < "$OUT")
[ "$SIZE" -gt 1024 ] || { echo "✗ dump suspiciously small ($SIZE bytes)" >&2; exit 1; }

aws s3 cp "$OUT" "s3://${STORAGE_S3_BUCKET}/${KEY}" --region "$REGION" >/dev/null
echo "✓ backup -> s3://${STORAGE_S3_BUCKET}/${KEY} ($((SIZE/1024)) KB)"

# ── the hostname this box serves ─────────────────────────────────────────────
# deploy/site.env is git-ignored and lives ONLY on this box, so it is the single
# piece of the HTTPS cutover that a box rebuild, a fresh clone or `git clean
# -xdf` destroys with no way back. Losing it is not cosmetic: install.sh then
# renders a plain ':80' Caddyfile while a restored .env.production still says
# COOKIE_SECURE=true, i.e. a Secure cookie over http, i.e. nobody can log in to
# payroll. install.sh now refuses that combination and points here for the fix.
#
# Safe to store: this file holds a hostname, an ACME email and the old public IP
# — no credentials. Deliberately NOT backing up .env.production alongside it,
# which holds the database password and AUTH_JWT_SECRET.
#
# One stable key, overwritten each night, so it needs no retention sweep and
# cannot drift out of sync with the box.
SITE_ENV="$HERE/site.env"
if [ -f "$SITE_ENV" ]; then
  if aws s3 cp "$SITE_ENV" "s3://${STORAGE_S3_BUCKET}/site-config/site.env" \
       --region "$REGION" >/dev/null 2>&1; then
    echo "✓ site config -> s3://${STORAGE_S3_BUCKET}/site-config/site.env"
  else
    # Never abort the run over this: the database dump above already succeeded
    # and uploaded, and the retention sweep below still needs to happen.
    echo "✗ could not upload deploy/site.env — the HTTPS hostname is UNBACKED UP" >&2
  fi
fi

# The cutover progress record travels WITH site.env, and losing it is worse than
# losing site.env alone.
#
# site.env says the box serves a hostname. The progress record says whether the
# pre-HTTPS sessions were ever revoked. Backing up only the first means the
# documented recovery — restore site.env from S3 — rebuilds a box that LOOKS
# already cut over while the record proving [8b] is still outstanding is gone.
# enable-https.sh then reports "no session has ever crossed plain HTTP" about a
# box whose old cookies are still valid. Recovering both keeps that honest.
PROGRESS_FILE="$HERE/.https-cutover-progress"
if [ -f "$PROGRESS_FILE" ]; then
  if aws s3 cp "$PROGRESS_FILE" \
       "s3://${STORAGE_S3_BUCKET}/site-config/https-cutover-progress" \
       --region "$REGION" >/dev/null 2>&1; then
    echo "✓ cutover record -> s3://${STORAGE_S3_BUCKET}/site-config/https-cutover-progress"
  else
    echo "✗ could not upload deploy/.https-cutover-progress — session-revocation" >&2
    echo "  state is UNBACKED UP; restoring site.env alone would look already-revoked" >&2
  fi
fi

# Retention: drop dumps older than KEEP_DAYS.
CUTOFF=$(date -u -d "-${KEEP_DAYS} days" +%Y-%m-%d 2>/dev/null || date -u -v-"${KEEP_DAYS}"d +%Y-%m-%d)
aws s3 ls "s3://${STORAGE_S3_BUCKET}/db-backups/" --region "$REGION" 2>/dev/null | while read -r d _ _ f; do
  [ -n "${f:-}" ] || continue
  if [[ "$d" < "$CUTOFF" ]]; then
    aws s3 rm "s3://${STORAGE_S3_BUCKET}/db-backups/$f" --region "$REGION" >/dev/null && echo "  pruned $f"
  fi
done
exit 0
