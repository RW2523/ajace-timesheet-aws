#!/usr/bin/env bash
# =============================================================================
# HTTPS CUTOVER — run this ON THE BOX, from the timesheet repo root:
#
#   bash deploy/scripts/enable-https.sh apps.yourdomain.com [you@yourdomain.com]
#
# Moves both apps from http://<raw-EC2-IP>/ to https://<hostname>/ , keeping
# ONE origin (timesheet at /, procurement at /procurement) so the shared
# ts_session cookie still reaches both. Cookie scoping and procurement's
# basePath are deliberately NOT changed.
#
# THE ORDER IS THE WHOLE POINT, and it is not negotiable:
#
#   1. DNS must already point here          — free to check, everything depends on it
#   2. Caddy serves the hostname, cert issued and PROVEN with a real handshake
#      AGAINST THIS BOX — every probe is --resolve-pinned to this box's own
#      public IP, so no other server on the internet can satisfy the gate
#   3. ONLY THEN COOKIE_SECURE=true + the https:// URLs + rebuild
#
# Doing 3 before 2 sets `Secure` on the login cookie (lib/aws/auth.js:20-22)
# while the site is still plain HTTP. The browser then refuses to send it back
# and NOBODY CAN LOG IN TO PAYROLL — including you.
#
# THE SITE STAYS UP THROUGHOUT. Step 2 is deliberately split in two, because
# switching Caddy to the hostname in one move deletes the plain-HTTP catch-all
# at the exact moment there is still no certificate — http:// then only
# redirects and https:// cannot answer, so every URL is dead until Let's Encrypt
# replies (or for the whole timeout, if it never does):
#
#   2a. render-caddyfile.sh --staging  — keeps the pre-cutover :80 catch-all AND
#       adds https://<hostname> beside it. Caddy gets its certificate while
#       plain HTTP keeps serving both apps. Nothing redirects yet.
#   2b. once the certificate is proven, render the final config. The cert
#       already exists, so this reload is an ordinary zero-downtime one.
#
# Interrupting during 2a is therefore safe, which matters because it is the one
# step with a visible wait. An EXIT/INT/TERM/HUP trap undoes the half-applied
# config anyway — Ctrl-C, a dropped SSH, or the OOM killer no longer leaves the
# box in a state nothing recovers from. See CUTOVER_STATE and cleanup().
#
# Re-runnable. Every file it touches is backed up first, and it writes a single
# rollback script whose path it prints at the end.
#
# RE-RUNNABLE MEANS RESUMABLE, and that needs memory. What a run COMPLETED is
# recorded in deploy/.https-cutover-progress and read by the next run — because
# the alternative, inferring progress from the config files this script itself
# writes, gets step [8b] exactly backwards: site.env names the hostname from
# step [6] onwards, i.e. BEFORE the rebuild that is the likeliest thing to fail,
# so a re-run would read its own unfinished work back as "already on HTTPS,
# nothing to revoke". SESSIONS_NEED_REVOKE in that file is set by observation
# and cleared ONLY by a session revocation that actually returned a row count.
# Machine-local; keep it while a cutover is unfinished, and it costs nothing to
# keep afterwards.
#
# THIS IS NOT ONLY A TLS CHANGE. Step [8] runs install.sh, which rebuilds both
# apps FROM THE CURRENT CHECKOUT and applies deploy/db/schema.sql to the LIVE
# PAYROLL DATABASE. The runbook has you `git pull` just before running this, so
# step [4] reports exactly what code and what DDL that pull is carrying, makes
# you confirm any schema change, and takes a pg_dump first. The rollback script
# restores config AND the checkout — it can NEVER un-migrate the database.
#
# LEAVING PLAIN HTTP BEHIND IS PART OF THE JOB, not a side effect:
#   · the old http://<IP> URL STOPS REACHING the apps — it becomes a dead end
#     (Caddy's blanket 308 to https://<IP>, which has no certificate). A
#     working redirect there cannot be made safe: the browser attaches the old,
#     non-Secure session cookie to the cleartext request before any redirect
#     happens. CUTOVER_LEGACY_HTTP_REDIRECT=1 keeps it anyway, with a warning.
#   · step [8b] bumps auth_users.session_version, which invalidates every
#     session minted while this box was on plain HTTP. Those tokens are 7-day
#     JWTs with no origin binding; moving to HTTPS does not retire one of them.
#     EVERYONE LOGS IN AGAIN. That is the point.
#   · a zone APEX is refused: HSTS ships with includeSubDomains, so on an apex
#     it commits every host in the domain to HTTPS for a year, irreversibly.
#
# Env knobs, all optional: TLS_TIMEOUT, ROLLBACK_TO_COMMIT, SKIP_DB_BACKUP,
# CUTOVER_ACCEPT_MIGRATIONS, CUTOVER_LEGACY_HTTP_REDIRECT, CUTOVER_ALLOW_APEX_HSTS.
#
# Exit codes: 0 clean · 1 stopped, site left untouched or rolled back · 2 usage
#             3 CUTOVER SUCCEEDED but a post-cutover security step did not pass
#               (see the block it prints — fix forward, do not roll back).
# =============================================================================
set -euo pipefail

HOSTNAME_ARG="${1:-}"
ACME_EMAIL_ARG="${2:-}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # deploy/
ROOT="$(cd "$HERE/.." && pwd)"                    # timesheet repo root
PROC="$(cd "$ROOT/.." && pwd)/procurement-intelligence-platform"
TS_ENV="$ROOT/.env.production"
PROC_ENV="$PROC/.env.production"
SITE_ENV="$HERE/site.env"
TS="$(date -u '+%Y%m%d-%H%M%S')"
ROLLBACK="$HERE/.https-rollback-$TS.sh"
# WHAT THIS RUN ACTUALLY DID — see "cutover progress" at step [5]. Machine-local,
# never committed, and the one thing that survives a failed run: site.env cannot
# answer "has a session cookie ever crossed plain HTTP on this box?", because
# this script writes site.env at step [6], BEFORE the rebuild that can fail.
PROGRESS="$HERE/.https-cutover-progress"
# How long to wait for Let's Encrypt to issue and for the first real handshake.
TLS_TIMEOUT="${TLS_TIMEOUT:-240}"

die() { echo; echo "✗ $*" >&2; exit 1; }
hr()  { echo "───────────────────────────────────────────────────────────────"; }

# Printed on EVERY path that ends with step [8b] still outstanding, so the
# instruction is written once and cannot drift between the places that give it.
manual_revoke_hint() {
  cat >&2 <<EOF
        cd $ROOT
        ( set -a; . .env.production; set +a; \\
          psql "\$DATABASE_URL" -c \\
            'update public.auth_users set session_version = session_version + 1' )
EOF
}

# ══════════════════════════════════════════════════════ crash safety
# Every recovery path in this script used to depend on the script REACHING it.
# Ctrl-C during the "waiting for the certificate" dots, an SSH drop without tmux
# (SIGHUP), or the OOM killer does none of that: the script dies mid-cutover and
# whatever half-state it was in becomes permanent, with no message and no undo.
# On a box that runs payroll that is not acceptable, so the same recovery now
# runs from a trap, and the trap is armed before anything is touched.
#
# Defensive defaults: the trap can fire before these are assigned for real.
CUTOVER_STATE=clean
CADDY_BAK=""
HAD_SITE_ENV=0

# undo_tls() — which puts the Caddyfile and deploy/site.env back and REPORTS what
# it actually left behind — is defined further down, immediately before the first
# point at which it could be needed. cleanup() only calls it in states that are
# reached after that definition, so the ordering is safe.

cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP          # never re-enter
  case "$CUTOVER_STATE" in
    clean|done) ;;                  # nothing was changed, or everything finished
    caddy_staged)
      echo >&2
      echo "!! Interrupted (exit $rc) while the certificate was still being issued." >&2
      echo "   The site kept answering the whole time: the staging config leaves the" >&2
      echo "   plain :80 catch-all in place precisely so an interrupt here is tidy-up" >&2
      echo "   rather than an outage. Restoring the pre-cutover Caddyfile." >&2
      undo_tls                      # prints its own, accurate state report
      echo >&2
      echo "   Re-run this script when you are ready." >&2
      ;;
    tls_live)
      echo >&2
      echo "!! Interrupted (exit $rc) after the certificate was issued but before" >&2
      echo "   the apps were switched over. THE SITE IS UP: https://$HOST serves" >&2
      echo "   both apps and http:// redirects to it." >&2
      if [ "${PREV_SECURE_IS_ON:-0}" = "1" ]; then
        echo "   COOKIE_SECURE was ALREADY true before this run, and it still is, so" >&2
        echo "   the cookie carries Secure and logins work over the new https origin." >&2
      else
        echo "   COOKIE_SECURE is still false, so logins keep working — the session" >&2
        echo "   cookie is just being sent without the Secure flag for now." >&2
      fi
      echo "   Do not leave it here: re-run this script to finish (it is idempotent)," >&2
      echo "   or undo it with:  bash $ROLLBACK" >&2
      ;;
    env_flipped)
      echo >&2
      echo "!! Interrupted (exit $rc) AFTER the env files were switched to https," >&2
      echo "   during or before the rebuild. TLS is live so the site is reachable," >&2
      echo "   but the running bundles may still carry the OLD http:// URLs." >&2
      echo "   Check what is actually running:   pm2 status" >&2
      echo "   Then re-run this script to finish, or undo the whole cutover:" >&2
      echo "       bash $ROLLBACK" >&2
      if [ "${REVOKE_NEEDED:-0}" = "1" ] && [ "${REVOKE_STATE:-}" != "ok" ]; then
        echo >&2
        echo "   ⚠ STEP [8b] DID NOT RUN. Every session issued while this box was on" >&2
        echo "     plain HTTP is still valid — 7-day JWTs, no origin binding, accepted" >&2
        echo "     by both apps. $PROGRESS records that it is" >&2
        echo "     outstanding, so the next run of this script that gets past the" >&2
        echo "     rebuild will do it. If that is not going to be soon, do it by hand:" >&2
        manual_revoke_hint
      fi
      ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
# Signals do not run the EXIT trap on their own in every bash build; route them
# through exit so there is exactly ONE recovery path. 130/143/129 = 128+signal.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ─────────────────────────────────────────────────────────────── 0. arguments
if [ -z "$HOSTNAME_ARG" ]; then
  cat >&2 <<EOF
usage: bash deploy/scripts/enable-https.sh <hostname> [acme-email]

  <hostname>    the FQDN this box will serve, e.g. apps.yourdomain.com
                It must ALREADY have a DNS A record pointing at this box,
                with the Cloudflare proxy OFF (grey cloud).
  [acme-email]  optional, but you want it: Let's Encrypt mails it if renewal
                starts failing. Silence for 60 days is how certs expire.

Read deploy/docs/HTTPS-CUTOVER.md first. This changes payroll's URL.
EOF
  exit 2
fi
HOST="$HOSTNAME_ARG"
echo "$HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' \
  || die "'$HOST' is not a hostname. Pass a bare FQDN — no scheme, no port, no path."
if echo "$HOST" | grep -Eq '^[0-9.]+$'; then
  die "'$HOST' is an IP address. Let's Encrypt does not issue certificates for IPs."
fi
if echo "$HOST" | grep -Eq '^https?://'; then
  die "Drop the scheme: pass '$HOST' as a bare hostname."
fi

# ────────────────────────────────── 0b. the hostname decides HSTS's BLAST RADIUS
# As soon as COOKIE_SECURE=true, BOTH apps send
#     Strict-Transport-Security: max-age=31536000; includeSubDomains
# (next.config.js:34-38, procurement next.config.ts:81-84). `includeSubDomains`
# is scoped to THE NAME IN THE ADDRESS BAR:
#
#   apps.example.com  -> covers apps.example.com and anything under it. Nothing
#                        else in the zone is affected. This is what you want.
#   example.com       -> covers EVERY host in that zone: www, mail, staging,
#                        vpn, the marketing site someone else hosts, and every
#                        subdomain that does not exist yet. Any browser that has
#                        loaded the payroll app REFUSES plain HTTP to all of
#                        them for a year.
#
# There is no server-side undo. Dropping the header later does not clear what
# browsers already stored; it expires per browser, per user, when the max-age
# runs out (or by hand in chrome://net-internals/#hsts). A single visit to
# payroll can therefore take down an unrelated http-only host in the same zone
# for a year, and the person who has to fix it will not connect the two.
#
# This script cannot make an apex safe. The header is emitted by the two Next
# configs at BUILD time, neither is parameterised by hostname, and neither file
# is written by this script — so there is no "apex mode" to fall back to and no
# way to drop includeSubDomains from here. Refusing is the only honest option.
#
# The domain is unknown when this script is written, which is exactly why this
# has to be a guard rather than a sentence in the runbook.
#
# Heuristic, and it is only a heuristic: two labels is always a registrable
# domain, and three labels is one too when the last two are a known multi-label
# public suffix. There is no Public Suffix List on this box, so the list below
# is the common cases. A false NEGATIVE (an apex we let through) is possible for
# an exotic suffix; a false POSITIVE just means the operator confirms.
MULTI_LABEL_SUFFIXES="co.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk ac.uk gov.uk nhs.uk
com.au net.au org.au edu.au gov.au id.au
co.nz net.nz org.nz govt.nz ac.nz
co.za org.za net.za web.za
co.in net.in org.in firm.in gen.in ind.in
com.br net.br org.br
com.mx com.ar com.co com.pe com.uy com.ve com.ec com.bo
com.sg com.my com.ph com.hk com.tw com.cn net.cn org.cn
co.jp ne.jp or.jp ac.jp go.jp
co.kr or.kr
co.il org.il net.il ac.il
com.tr com.ua com.pl net.pl org.pl
com.ng co.ke co.tz co.ug com.gh
com.sa com.eg com.qa com.kw com.bh com.om
co.th in.th com.vn com.pk com.bd com.np com.lk com.kh
co.id or.id web.id"

host_is_apex() {
  local h n last2 s
  h="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  n="$(printf '%s' "$h" | awk -F. '{print NF}')"
  if [ "$n" -le 2 ]; then return 0; fi
  if [ "$n" -eq 3 ]; then
    last2="$(printf '%s' "$h" | awk -F. '{print $(NF-1)"."$NF}')"
    # Deliberately unquoted: this is a word-split over the whitespace-separated
    # list above, not a single string.
    # shellcheck disable=SC2086
    for s in $MULTI_LABEL_SUFFIXES; do
      if [ "$last2" = "$s" ]; then return 0; fi
    done
  fi
  return 1
}

if host_is_apex "$HOST"; then
  cat >&2 <<EOF

✗ '$HOST' is a whole domain (a zone apex), not a host inside one.

  This is refused because of HSTS, not because of DNS or certificates — both of
  those would work fine, which is what makes it dangerous.

  Cutting over here makes both apps send, to every visitor:

      Strict-Transport-Security: max-age=31536000; includeSubDomains

  On an apex, "includeSubDomains" means EVERY host in the $HOST zone —
  www, mail, staging, vpn, anything a colleague runs, anything you add later.
  Every browser that has loaded payroll will refuse plain HTTP to all of them
  for a year. Nothing on the server takes that back: it is stored in the
  browser, and it expires when it expires.

  Use a subdomain instead. One extra DNS record, and the blast radius is that
  one name:

      bash deploy/scripts/enable-https.sh apps.$HOST ${ACME_EMAIL_ARG:-you@$HOST}

EOF
  if [ "${CUTOVER_ALLOW_APEX_HSTS:-0}" = "1" ]; then
    echo "  CUTOVER_ALLOW_APEX_HSTS=1 is set." >&2
    if [ -t 0 ]; then
      # Same shape as the MIGRATE prompt below: EOF/Ctrl-D fails CLOSED, and
      # only the exact word is accepted.
      _ans=""
      read -r -p "  Type APEX if EVERY host under $HOST can serve HTTPS: " _ans || true
      _ans="$(printf '%s' "$_ans" | tr -d '[:space:]')"
      [ "$_ans" = "APEX" ] || die "Aborted. Nothing has been changed."
    fi
    echo "  Continuing on the apex. This is the one decision here that nothing" >&2
    echo "  in this script — or any later one — can undo." >&2
  else
    die "Refusing to put HSTS across the whole $HOST zone.
       Re-run with a subdomain (apps.$HOST is the usual answer).
       If you have genuinely checked every host under $HOST — the ones that
       exist today AND the ones you will add in the next year — and they can
       all serve HTTPS, re-run with CUTOVER_ALLOW_APEX_HSTS=1.
       Nothing has been changed."
  fi
fi

# ─────────────────────────────────────────────────────────── 1. am I the box?
[ -d /etc/caddy ] || die "No /etc/caddy — run this ON the EC2 box, not on your laptop."
command -v caddy >/dev/null 2>&1 || die "caddy is not installed. Run deploy/scripts/install.sh first."
[ -f "$TS_ENV" ] || die "No $TS_ENV — this is not a deployed timesheet checkout."
sudo -n true 2>/dev/null || echo "(you will be asked for sudo)"

echo
hr
echo "HTTPS cutover -> https://$HOST"
hr

# ─────────────────────────────────────────────── 2. DNS — the free hard gate
echo "==> [1/8] DNS"
MY_IP=""
TOKEN="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' \
          -H 'X-aws-ec2-metadata-token-ttl-seconds: 120' --max-time 3 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  MY_IP="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" --max-time 3 \
            http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
fi
[ -n "$MY_IP" ] || MY_IP="$(curl -sS --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
[ -n "$MY_IP" ] || MY_IP="$(curl -sS --max-time 6 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$MY_IP" ] || die "Could not determine this box's public IP (IMDS and checkip both failed).
       Find it in the EC2 console and re-run once you can confirm DNS by hand."
echo "    this box is $MY_IP"

# EVERY probe in this script is pinned to THIS BOX. Without --resolve, curl uses
# the box's own resolver (systemd-resolved, which caches) and the TLS gate is
# satisfied by whatever answers for $HOST on the internet — Cloudflare Universal
# SSL presents a genuinely valid certificate, so `curl https://$HOST/` succeeds
# while THIS box holds no certificate at all. The script would then read that as
# "TLS is live" and set COOKIE_SECURE=true: the exact payroll lockout the whole
# ordering exists to prevent. The gate must prove THIS box's TLS, nobody else's.
PIN80=(--resolve "$HOST:80:$MY_IP")
PIN443=(--resolve "$HOST:443:$MY_IP")

command -v dig >/dev/null 2>&1 || sudo apt-get install -y -qq dnsutils >/dev/null 2>&1 || true

# Ask a PUBLIC resolver, not the box's cache: systemd-resolved will happily
# serve a stale NXDOMAIN from before the record was created — or, worse, a stale
# Cloudflare proxy address from before the orange cloud was turned off.
public_a_record() {
  local h="$1" out=""
  if command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=3 +tries=2 A "$h" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' || true)"
    [ -n "$out" ] || out="$(dig +short +time=3 +tries=2 A "$h" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' || true)"
  else
    out="$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  fi
  printf '%s' "$out"
}

resolved="$(public_a_record "$HOST")"

if [ -z "$resolved" ]; then
  cat >&2 <<EOF

✗ $HOST does not resolve to anything.
    expected: $MY_IP
    got:      (no A record)

  Create the A record in Cloudflare first:
      Type A · Name <the subdomain> · IPv4 $MY_IP · Proxy status DNS only (grey cloud)
  Then wait a minute and re-run this script. Nothing has been changed.
EOF
  exit 1
fi

# -F, not a regex: the dots in an IPv4 address are metacharacters, and without
# it "1.2.3.4" would happily match "1x2x3x4".
if ! echo "$resolved" | grep -Fqx "$MY_IP"; then
  echo >&2
  echo "✗ $HOST points somewhere else." >&2
  echo "    expected: $MY_IP   (this box)" >&2
  echo "    got:      $(echo "$resolved" | tr '\n' ' ')" >&2
  # Hint, not a proof — Cloudflare's ranges change; see cloudflare.com/ips.
  if echo "$resolved" | grep -qE '^(104\.1[6-9]|104\.2[0-7]|172\.6[4-9]|172\.7[01]|162\.15[89]|188\.114|190\.93|197\.234|198\.41|173\.245|141\.101|108\.162|103\.2[123]|131\.0)\.'; then
    cat >&2 <<EOF

  That looks like a CLOUDFLARE PROXY address — the orange cloud is ON.
  Turn it OFF (set the record to "DNS only", grey cloud) and re-run.
  With the proxy on, Let's Encrypt's HTTP-01 challenge is answered by
  Cloudflare rather than by this box, so no certificate is ever issued here.
EOF
  fi
  echo >&2
  echo "  Nothing has been changed. Fix DNS, wait for the TTL, re-run." >&2
  exit 1
fi
if [ "$(echo "$resolved" | wc -l | tr -d ' ')" != "1" ]; then
  cat >&2 <<EOF

✗ $HOST has MORE THAN ONE A record:
      $(echo "$resolved" | tr '\n' ' ')
  One of them is this box; the rest are not. Traffic — and Let's Encrypt's
  validation request — would land on whichever the client picks, so issuance is
  a coin flip and users would intermittently hit the wrong server.
  Delete the extra records and re-run. Nothing has been changed.
EOF
  exit 1
fi
echo "    $HOST -> $MY_IP ✓ (single A record, not behind a proxy)"

# ────────────────────────────────────────── 3. can the internet reach port 80?
echo "==> [2/8] reachability"
CODE80="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "${PIN80[@]}" "http://$HOST/" 2>/dev/null || echo 000)"
if [ "$CODE80" = "000" ]; then
  cat >&2 <<EOF

✗ Nothing answered on http://$HOST/ (port 80) at $MY_IP.

  This probe is pinned to THIS box ($MY_IP) rather than to whatever DNS happens
  to return, so it is asking the one machine Let's Encrypt will have to reach.

  Let's Encrypt validates over port 80. If it is closed, no certificate is
  issued today AND renewal fails silently in ~60 days. Open it in the security
  group (see deploy/docs/HTTPS-CUTOVER.md) and re-run. Nothing has been changed.

  If port 80 is definitely open to the world, the box may simply not be able to
  reach its own public IP. Check from your laptop instead:
      curl -sS -o /dev/null -w '%{http_code}\\n' http://$MY_IP/
EOF
  exit 1
fi
echo "    http://$HOST/ answers at $MY_IP (HTTP $CODE80) — port 80 is open"

# ─────────────────────────────────── 4. can this box survive the rebuild? Gate
# early: the hostname is compiled into procurement's bundle (NEXT_PUBLIC_LOGIN_URL
# reaches NextResponse.redirect(), which demands an absolute URL), so this
# cutover REQUIRES a full Next build on a 2 GB box. Finding out after TLS is
# live is survivable; finding out after the env flip is not.
echo "==> [3/8] build headroom"
FREE_MB="$(df -Pm "$ROOT" | awk 'NR==2{print $4}')"
if [ "$FREE_MB" -lt 4000 ]; then
  cat >&2 <<EOF

✗ Only ${FREE_MB}MB free on this volume — install.sh refuses to build under 4000MB,
  and this cutover cannot finish without rebuilding BOTH apps.

  Free space first:  npm cache clean --force
  A stale .next.build in either repo is a partial build left by an interrupted
  run and is safe to delete. Do NOT delete .next in either repo — that is the
  build the live app is serving right now.
  Nothing has been changed.
EOF
  exit 1
fi
echo "    ${FREE_MB}MB free ✓"

# ──────────────────────────── 4b. THIS IS ALSO A CODE DEPLOY AND A MIGRATION
# Step [8] runs install.sh, which rebuilds both apps FROM THE CURRENT CHECKOUT
# and applies deploy/db/schema.sql (and procurement's) to the LIVE PAYROLL
# DATABASE. The runbook has you `git pull` immediately before running this, so
# both of those can carry changes that have nothing to do with HTTPS.
#
# The rollback script written at step [5] restores .env.production, site.env and
# the Caddyfile. That is config only. It cannot un-migrate a database, and it can
# only put the CODE back if it knows which commit was previously built — so work
# that out here, while nothing has been changed yet and aborting is still free.
echo "==> [4/8] what else this deploy carries"
GIT_OK=0
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 && GIT_OK=1
HEAD_SHA=""
[ "$GIT_OK" = "1" ] && HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"

# The commit the box last BUILT AND STARTED, recorded by install.sh step [6].
# ROLLBACK_TO_COMMIT overrides it, and is the escape hatch for the FIRST cutover:
# on a box that has not run the new install.sh yet the file does not exist, so
# capture `git rev-parse HEAD` BEFORE you pull and pass it in.
PREV_SHA="${ROLLBACK_TO_COMMIT:-}"
PREV_SRC="ROLLBACK_TO_COMMIT"
if [ -z "$PREV_SHA" ] && [ -f "$HERE/.deployed-commits" ]; then
  # shellcheck source=/dev/null
  . "$HERE/.deployed-commits"
  PREV_SHA="${TS_COMMIT:-}"
  PREV_SRC="deploy/.deployed-commits"
fi
if [ -n "$PREV_SHA" ] && [ "$GIT_OK" = "1" ]; then
  if git -C "$ROOT" rev-parse --verify -q "${PREV_SHA}^{commit}" >/dev/null 2>&1; then
    # Normalise: a short sha in ROLLBACK_TO_COMMIT must still compare equal to HEAD.
    PREV_SHA="$(git -C "$ROOT" rev-parse "${PREV_SHA}^{commit}")"
  else
    echo "    ⚠ $PREV_SRC names $PREV_SHA, which is not a commit in this repo —"
    echo "      ignoring it. Rollback will not be able to restore the code."
    PREV_SHA=""
  fi
fi

DIRTY=0
if [ "$GIT_OK" = "1" ] && ! git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then DIRTY=1; fi
SCHEMA_CHANGED=0

if [ "$GIT_OK" != "1" ]; then
  echo "    ⚠ $ROOT is not a git checkout — rollback cannot restore the code."
elif [ -z "$PREV_SHA" ]; then
  cat <<EOF
    ⚠ This box has no record of which commit it last built, so the rollback
      script CANNOT put the code back. It would restore the config and then
      rebuild from whatever is checked out right now (${HEAD_SHA:0:12}).

      If you just ran 'git pull', press Ctrl-C and re-run as:
          ROLLBACK_TO_COMMIT=<the sha you were on BEFORE the pull> \\
            bash deploy/scripts/enable-https.sh $HOST $ACME_EMAIL_ARG

      install.sh records this from now on, so it is a one-time gap.
EOF
elif [ "$PREV_SHA" = "$HEAD_SHA" ]; then
  echo "    checkout unchanged since the last build (${HEAD_SHA:0:12}) — no new code ships ✓"
else
  echo "    ⚠ the checkout has MOVED since this box was last built:"
  echo "        was ${PREV_SHA:0:12}  ->  now ${HEAD_SHA:0:12}   (per $PREV_SRC)"
  git -C "$ROOT" log --oneline --no-decorate "$PREV_SHA..$HEAD_SHA" 2>/dev/null \
    | sed 's/^/          /' || true
  echo "      Every one of those ships with this cutover. Rollback will return the"
  echo "      code to ${PREV_SHA:0:12} — but not the database. See below."
  git -C "$ROOT" diff --quiet "$PREV_SHA" -- deploy/db 2>/dev/null || SCHEMA_CHANGED=1
fi

if [ "$DIRTY" = "1" ]; then
  echo "    ⚠ uncommitted changes in $ROOT — rollback's 'git checkout' refuses to"
  echo "      clobber them. Commit or stash them before you rely on rollback."
  git -C "$ROOT" diff --quiet HEAD -- deploy/db 2>/dev/null || SCHEMA_CHANGED=1
fi

# ── the part no rollback can undo
if [ "$SCHEMA_CHANGED" = "1" ]; then
  cat >&2 <<EOF

  ⚠ deploy/db HAS CHANGED, so this cutover is also a MIGRATION.

    install.sh applies deploy/db/schema.sql to the live payroll database, and
    NOTHING here undoes DDL — not the rollback script, not restoring the old
    commit. Rolling back to older code re-runs the OLDER schema file, which can
    fail outright (a re-added CHECK cannot validate rows the new code wrote).

    schema.sql also contains drop-then-add CONSTRAINT and drop-then-create
    TRIGGER pairs. Each takes ACCESS EXCLUSIVE on a payroll table and queues
    ahead of every read and write behind it, so run this when staff are NOT
    submitting timesheets.

    Read the diff before you continue:
        git -C $ROOT diff ${PREV_SHA:-HEAD} -- deploy/db

EOF
  if [ "${CUTOVER_ACCEPT_MIGRATIONS:-0}" = "1" ]; then
    echo "    CUTOVER_ACCEPT_MIGRATIONS=1 — proceeding with the migration."
  elif [ -t 0 ]; then
    # `|| true` and the empty default matter: on EOF (a closed SSH, a stray
    # Ctrl-D) read returns non-zero with nothing set, and under `set -e` that
    # would abort anyway — but explicitly, and in the FAIL-CLOSED direction.
    # Trailing \r/space is stripped because some SSH and terminal clients send
    # it; nothing else is accepted, so this cannot widen what counts as consent.
    _ans=""
    read -r -p "  Type MIGRATE to run this DDL against live payroll: " _ans || true
    _ans="$(printf '%s' "$_ans" | tr -d '[:space:]')"
    [ "$_ans" = "MIGRATE" ] || die "Aborted. Nothing has been changed.
       To do the TLS change WITHOUT the migration, go back to the code this box
       already runs and re-run this script:
           git -C $ROOT checkout ${PREV_SHA:-<sha>}"
  else
    die "Refusing to migrate the live payroll database unattended.
       Re-run in a terminal, or set CUTOVER_ACCEPT_MIGRATIONS=1 once you have
       read the diff above. Nothing has been changed."
  fi
fi

# ── a dump taken while "nothing has been changed" is still true
DB_BACKUP_KEY=""
if [ "${SKIP_DB_BACKUP:-0}" = "1" ]; then
  echo "    ⚠ SKIP_DB_BACKUP=1 — no pre-cutover database backup taken."
else
  echo "    taking a pre-cutover database backup (the DDL below is not reversible)"
  if BK_OUT="$(bash "$HERE/scripts/backup.sh" 2>&1)"; then
    DB_BACKUP_KEY="$(printf '%s\n' "$BK_OUT" | grep -o 's3://[^ ]*' | head -1 || true)"
    echo "    ✓ ${DB_BACKUP_KEY:-backup taken}"
  else
    printf '%s\n' "$BK_OUT" >&2
    die "Pre-cutover database backup FAILED (output above).
       This cutover runs DDL against the live payroll database and nothing can
       undo that without a dump to restore from. Fix the backup (AWS credentials,
       STORAGE_S3_BUCKET in .env.production) and re-run.
       SKIP_DB_BACKUP=1 overrides this — only if you have a fresh dump elsewhere.
       Nothing has been changed."
  fi
fi

# ───────────────────────────────────────────────── 5. back up, then turn on TLS
echo "==> [5/8] backups + rollback script"
backup() {
  if [ -f "$1" ]; then
    cp -p "$1" "$1.pre-https.$TS"
    echo "    $1 -> $1.pre-https.$TS"
  fi
}
backup "$TS_ENV"
HAD_PROC_ENV=0
if [ -f "$PROC_ENV" ]; then HAD_PROC_ENV=1; backup "$PROC_ENV"; fi
HAD_SITE_ENV=0
if [ -f "$SITE_ENV" ]; then HAD_SITE_ENV=1; backup "$SITE_ENV"; fi
CADDY_BAK="/etc/caddy/Caddyfile.pre-https.$TS"
# Whether this actually succeeded decides what the rollback script may CLAIM to
# restore. Not knowing is how a rollback ends up promising more than it does.
if sudo cp -p /etc/caddy/Caddyfile "$CADDY_BAK" 2>/dev/null; then
  echo "    /etc/caddy/Caddyfile -> $CADDY_BAK"
else
  CADDY_BAK=""
  echo "    ⚠ could not back up /etc/caddy/Caddyfile — rollback will regenerate it instead."
fi

# The rollback restores the state as it was IMMEDIATELY BEFORE THIS RUN — which,
# on a re-run over an already-HTTPS box, is not "back to HTTP". Say which it is
# rather than promising something that would be a lie the second time.
#
# Read the pre-run state out of the files NOW, before this run overwrites them:
# site.env is rewritten at step [6] and COOKIE_SECURE at step [8]. Two facts,
# kept separate on purpose, because they fail independently:
#   PREV_HOST         — decides what the restored Caddyfile SERVES (empty = :80)
#   PREV_SECURE_IS_ON — decides whether a login cookie can survive plain HTTP
#   PREV_ACME_EMAIL   — must SURVIVE a re-run that omits the optional argument
#   PREV_TLS_UPSTREAM — whether something in FRONT of this box terminates TLS
kv_of() {
  # `|| true`: a grep that matches nothing exits 1, and under `set -o pipefail`
  # that would abort the cutover here instead of yielding an empty value.
  grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' \t\r" || true
}
PREV_HOST=""
PREV_ACME_EMAIL=""
PREV_TLS_UPSTREAM=""
if [ "$HAD_SITE_ENV" = "1" ]; then
  PREV_HOST="$(kv_of "$SITE_ENV" SITE_HOSTNAME)"
  PREV_ACME_EMAIL="$(kv_of "$SITE_ENV" ACME_EMAIL)"
  PREV_TLS_UPSTREAM="$(kv_of "$SITE_ENV" TLS_TERMINATES_UPSTREAM)"
fi
PREV_SECURE_RAW="$(grep -E '^COOKIE_SECURE=' "$TS_ENV" | tail -1 | cut -d= -f2- | awk '{print $1}' || true)"
# An EMPTY value is NOT neutral: lib/aws/auth.js:20-22 falls back to
# NODE_ENV === "production", which is true here. Unset therefore means Secure.
if [ -z "$PREV_SECURE_RAW" ]; then
  PREV_SECURE_DESC="unset — which still means Secure, it falls back to NODE_ENV=production"
  PREV_SECURE_IS_ON=1
elif [ "$PREV_SECURE_RAW" = "true" ]; then
  PREV_SECURE_DESC="true"
  PREV_SECURE_IS_ON=1
else
  PREV_SECURE_DESC="$PREV_SECURE_RAW"
  PREV_SECURE_IS_ON=0
fi

WAS_HTTPS=0
if [ -n "$PREV_HOST" ]; then WAS_HTTPS=1; fi
if [ "$WAS_HTTPS" = "1" ]; then
  UNDO_DESC="the previous HTTPS configuration — https://$PREV_HOST (this box was already on HTTPS before this run)"
else
  UNDO_DESC="plain HTTP on http://$MY_IP — everyone will have to log in again"
fi

# ── cutover progress: WHAT ACTUALLY HAPPENED, not what a file implies ────────
# WAS_HTTPS above is "was this box on HTTPS when THIS RUN started", read out of
# site.env. That is the right question for the rollback and for undo_tls, and it
# is the WRONG question for step [8b], which needs "has a session cookie of this
# box's making ever crossed plain HTTP?".
#
# The two diverge on the likeliest failure of the whole cutover. Step [6] writes
# SITE_HOSTNAME into site.env BEFORE step [8] runs install.sh — the longest and
# most failure-prone step on a 2 GB box. If the rebuild fails the script exits,
# and the env_flipped branch of cleanup() deliberately does NOT restore site.env
# (TLS is live and working; tearing it down would be the bigger outage). So on
# the re-run site.env names a hostname, WAS_HTTPS reads 1, and a script deriving
# [8b] from it would skip the revocation AND print "they do not need to be" —
# a false assurance about the one step that closes the plaintext-session window.
#
# So the fact is RECORDED, here, before anything is touched, and it is cleared
# in exactly one place: immediately after a revocation actually succeeds.
# SESSIONS_NEED_REVOKE only ever goes 0 -> 1 by observation and 1 -> 0 by a
# completed UPDATE, so no failure path can lose it. It is machine-local (like
# site.env and .deployed-commits) and deliberately outside git.
pg_get() { [ -f "$PROGRESS" ] && kv_of "$PROGRESS" "$1" || true; }
PG_NEED_PREV="$(pg_get SESSIONS_NEED_REVOKE)"
PG_REVOKED_AT="$(pg_get SESSIONS_REVOKED_AT)"
PG_REVOKED_N="$(pg_get SESSIONS_REVOKED_N)"
PG_REVOKED_HOST="$(pg_get SESSIONS_REVOKED_HOST)"
PG_COMPLETED="$(pg_get CUTOVER_COMPLETED_AT)"
PG_FIRST_RUN="$(pg_get CUTOVER_FIRST_RUN_AT)"
PG_RUNS="$(pg_get CUTOVER_RUNS)"
PG_PRE_HOST="$(pg_get PRE_CUTOVER_HOST)"

# Is the recorded cutover still unfinished? Unfinished means: it never reached a
# working HTTPS end state, or it did but [8b] is still outstanding. Only then do
# this run's messages inherit the earlier run's view of the pre-cutover world;
# otherwise this is a NEW cutover and site.env is the honest source again.
PG_RESUMING=0
if [ -f "$PROGRESS" ] && { [ -z "$PG_COMPLETED" ] || [ "$PG_NEED_PREV" = "1" ]; }; then
  PG_RESUMING=1
fi

# Did we INFER the pre-cutover world instead of reading it from the record?
# With no progress file we fall back to site.env, which says what the box serves
# NOW -- on a half-finished cutover that is the hostname an earlier run already
# wrote, which makes an un-revoked box look already-revoked. Step [5] used to be
# the only place that said so, ~1000 lines before the messages that assert it
# categorically; this flag carries the caveat to every one of them.
PG_INFERRED=0
if [ ! -f "$PROGRESS" ] && [ -n "$PREV_HOST" ]; then PG_INFERRED=1; fi
if [ "$PG_RESUMING" != "1" ]; then
  PG_PRE_HOST="$PREV_HOST"
  PG_FIRST_RUN="$TS"
  PG_RUNS=0
  # This run OPENS a new cutover, so it is unfinished until it says otherwise.
  # Leaving the previous cutover's completion stamp in place would make a retry
  # of THIS one look like a new cutover again, and it would then describe the
  # pre-cutover world using the hostname this run had already written.
  PG_COMPLETED=""
  # A finished cutover's revocation belongs to the finished cutover, not to this
  # one. Keep it only if it was for the host this run is (re-)establishing.
  if [ "$PG_REVOKED_HOST" != "$HOST" ]; then PG_REVOKED_AT=""; PG_REVOKED_N=""; PG_REVOKED_HOST=""; fi
fi
case "$PG_RUNS" in ''|*[!0-9]*) PG_RUNS=0 ;; esac
PG_RUNS=$(( PG_RUNS + 1 ))
[ -n "$PG_FIRST_RUN" ] || PG_FIRST_RUN="$TS"

# Monotone: 1 if a previous run recorded it outstanding, OR if what we can see
# right now says sessions are being minted over plain HTTP.
REVOKE_NEEDED=0
REVOKE_WHY=""
if [ "$PG_RESUMING" = "1" ] && [ "$PG_NEED_PREV" = "1" ]; then
  REVOKE_NEEDED=1
  REVOKE_WHY="an earlier run of this cutover (first attempt $PG_FIRST_RUN) recorded it outstanding"
elif [ -z "$PREV_HOST" ]; then
  REVOKE_NEEDED=1
  REVOKE_WHY="this box is on plain HTTP right now (no SITE_HOSTNAME in deploy/site.env)"
elif [ "$PREV_SECURE_IS_ON" != "1" ]; then
  # site.env names a hostname but the cookie is NOT Secure — a half-configured
  # box, which install.sh:262 also refuses to deploy. Sessions minted in that
  # state carry no Secure flag and go out over any http:// request to the name.
  REVOKE_NEEDED=1
  REVOKE_WHY="deploy/site.env names https://$PREV_HOST but COOKIE_SECURE is $PREV_SECURE_DESC, so sessions have been minted WITHOUT the Secure flag"
fi
if [ "$REVOKE_NEEDED" = "1" ]; then
  echo "    step [8b] will revoke pre-cutover sessions — $REVOKE_WHY"
elif [ -n "$PG_REVOKED_AT" ]; then
  echo "    step [8b] already done for this hostname on $PG_REVOKED_AT ($PG_REVOKED_N accounts)"
else
  echo "    step [8b] not applicable — this box was already serving https://$PG_PRE_HOST"
  if [ ! -f "$PROGRESS" ] && [ -n "$PREV_HOST" ]; then
    echo "      (no $PROGRESS on this box, so that"
    echo "       is read from deploy/site.env. If you are resuming a cutover that was"
    echo "       interrupted and you deleted that file, revoke by hand afterwards —"
    echo "       see deploy/docs/HTTPS-CUTOVER.md.)"
  fi
fi

# Written NOW, before step [6] touches site.env, so the record of the pre-cutover
# world cannot be overwritten by this run's own work.
pg_write() {
  ( umask 077
    {
      echo "# GENERATED by deploy/scripts/enable-https.sh — machine-local, not in git."
      echo "# It is the record of what the cutover ACTUALLY did. Do not delete it while"
      echo "# a cutover is unfinished: SESSIONS_NEED_REVOKE=1 is the only thing that"
      echo "# tells a re-run that step [8b] still has to happen."
      echo "PROGRESS_VERSION=1"
      echo "PRE_CUTOVER_HOST=$PG_PRE_HOST"
      echo "PRE_CUTOVER_COOKIE_SECURE=$PREV_SECURE_RAW"
      echo "CUTOVER_FIRST_RUN_AT=$PG_FIRST_RUN"
      echo "CUTOVER_LAST_RUN_AT=$TS"
      echo "CUTOVER_RUNS=$PG_RUNS"
      echo "CUTOVER_TARGET_HOST=$HOST"
      echo "CUTOVER_COMPLETED_AT=$PG_COMPLETED"
      echo "SESSIONS_NEED_REVOKE=$REVOKE_NEEDED"
      echo "SESSIONS_REVOKED_AT=$PG_REVOKED_AT"
      echo "SESSIONS_REVOKED_N=$PG_REVOKED_N"
      echo "SESSIONS_REVOKED_HOST=$PG_REVOKED_HOST"
    } > "$PROGRESS" )
}
pg_write

# ── the one pre-cutover state that CANNOT be restored verbatim ───────────────
# The rollback target is "the state from immediately before this run". If that
# state was plain HTTP (no SITE_HOSTNAME) with COOKIE_SECURE absent or EMPTY
# rather than the literal 'false', restoring it faithfully reproduces exactly
# the combination install.sh:203-240 refuses: EFFECTIVE_SECURE=1 with no
# hostname, because an empty value falls back to NODE_ENV=production.
#
# That matters because install.sh is the LAST thing the rollback runs. By then
# it has already put Caddy back on plain :80 and reloaded it, so the refusal
# lands with the site on http, both apps still serving the HTTPS-era bundles,
# nobody able to sign in — and the rollback's own "Rolled back to:" summary
# never printed, because `set -e` killed it first.
#
# And the state being restored was never a working one: a Secure cookie is not
# returned over http://, so no one could have signed in to that box either. So
# the rollback writes the value the plain-HTTP target actually requires, says
# so in its header, on the way past, and in its summary. Nothing is weakened —
# COOKIE_SECURE=false is what install.sh demands for a :80 box, and it is what
# the shipped template (deploy/env.production.example) already says.
PREV_SECURE_SHOW="$(printf '%s' "${PREV_SECURE_RAW:-<empty>}" | tr -d "\"'")"
RB_SECURE_FIX=0
if [ "$PREV_SECURE_IS_ON" = "1" ] && [ -z "$PREV_HOST" ] && [ "$PREV_TLS_UPSTREAM" != "1" ]; then
  RB_SECURE_FIX=1
  echo "    ⚠ pre-cutover COOKIE_SECURE is '$PREV_SECURE_SHOW' with no hostname in"
  echo "      deploy/site.env. Restoring that verbatim is a state install.sh refuses"
  echo "      to deploy (Secure cookie on a plain-HTTP box), so the rollback script"
  echo "      will write COOKIE_SECURE=false explicitly instead of copying it back."
fi

{
  echo "#!/usr/bin/env bash"
  echo "# Restores the state from immediately before the $TS cutover run:"
  echo "#   -> $UNDO_DESC"
  echo "# Rebuilds both apps, because the site URL is compiled into procurement's"
  echo "# bundle and a restart alone would not change it."
  echo "#"
  echo "# SCOPE — read this before you trust it:"
  echo "#   RESTORED: .env.production (both apps), deploy/site.env"
  if [ "$RB_SECURE_FIX" = "1" ]; then
    echo "#   CHANGED, NOT RESTORED: COOKIE_SECURE in both .env.production files is"
    echo "#                 written as 'false'. Before this cutover it was"
    echo "#                 '$PREV_SECURE_SHOW', and with no SITE_HOSTNAME that means a"
    echo "#                 Secure cookie on a plain-HTTP box: no one can sign in, and"
    echo "#                 install.sh at the end of this script REFUSES to deploy it."
    echo "#                 Copying it back verbatim would leave Caddy already on :80,"
    echo "#                 install.sh dead, and payroll unusable. Set it to something"
    echo "#                 else afterwards if you disagree — but not while this box"
    echo "#                 serves plain HTTP."
  fi
  if [ -n "$CADDY_BAK" ]; then
    echo "#   RESTORED: /etc/caddy/Caddyfile, from $CADDY_BAK"
  else
    echo "#   REGENERATED (not restored): /etc/caddy/Caddyfile — no backup was taken."
  fi
  if [ -n "$PREV_SHA" ]; then
    echo "#   RESTORED: the git checkout, back to $PREV_SHA"
  else
    echo "#   NOT RESTORED: the git checkout — no previous commit was known, so"
    echo "#                 install.sh below rebuilds from whatever is checked out."
  fi
  echo "#   NOT RESTORED: THE DATABASE. install.sh applied deploy/db/schema.sql"
  echo "#                 (and procurement's) to the live payroll database, and"
  echo "#                 DDL is not undone by re-running an older schema file."
  if [ -n "$DB_BACKUP_KEY" ]; then
    echo "#                 Pre-cutover dump: $DB_BACKUP_KEY"
    echo "#                 Rehearse a restore into a scratch database first:"
    echo "#                   bash '$HERE/scripts/restore.sh' $(basename "$DB_BACKUP_KEY")"
    echo "#                 Add --live only as a last resort — it discards every"
    echo "#                 row written since the dump, including submitted hours."
  else
    echo "#                 NO pre-cutover dump was taken (SKIP_DB_BACKUP was set)."
  fi
  echo "set -euo pipefail"
  echo "ROOT='$ROOT'"
  echo "RB_SHA='$PREV_SHA'"
  echo 'RESTORE_CODE="${RESTORE_CODE:-1}"'
  # Code first: everything below (install.sh above all) must run from the
  # restored checkout, not from the code this cutover brought in.
  cat <<'EOS'
if [ -n "$RB_SHA" ] && [ "$RESTORE_CODE" = "1" ]; then
  if [ "$(git -C "$ROOT" rev-parse HEAD)" = "$RB_SHA" ]; then
    echo "code already at $RB_SHA — nothing to restore"
  elif ! git -C "$ROOT" diff --quiet HEAD --; then
    echo "✗ Refusing to check out $RB_SHA: uncommitted changes in $ROOT." >&2
    echo "  Commit or stash them, or re-run with RESTORE_CODE=0 to roll back" >&2
    echo "  configuration ONLY (the code then stays where it is)." >&2
    exit 1
  else
    git -C "$ROOT" checkout --detach "$RB_SHA"
    echo "code -> $RB_SHA"
    echo "(detached HEAD — 'git -C $ROOT checkout main' once you are done)"
  fi
elif [ -z "$RB_SHA" ]; then
  echo "NOTE: the code is NOT being restored — this box had no record of the" >&2
  echo "      commit it previously built, so the rebuild below uses whatever is" >&2
  echo "      checked out now:  git -C $ROOT log --oneline -5" >&2
fi
EOS
  echo "cp -p '$TS_ENV.pre-https.$TS' '$TS_ENV'"
  if [ "$HAD_PROC_ENV" = "1" ]; then echo "cp -p '$PROC_ENV.pre-https.$TS' '$PROC_ENV'"; fi
  if [ "$HAD_SITE_ENV" = "1" ]; then
    echo "cp -p '$SITE_ENV.pre-https.$TS' '$SITE_ENV'"
  else
    echo "rm -f '$SITE_ENV'"
  fi
  # See the long note above RB_SECURE_FIX: this is the one field that must not
  # be restored verbatim, and it has to be fixed HERE — after the copies, before
  # Caddy and install.sh — or install.sh refuses with the site already on :80.
  if [ "$RB_SECURE_FIX" = "1" ]; then
    echo "RB_TS_ENV='$TS_ENV'"
    echo "RB_PROC_ENV='$PROC_ENV'"
    cat <<'EOS'
rb_sete() {
  local f="$1" k="$2" v="$3" t
  [ -f "$f" ] || return 0
  t="$(mktemp)"
  if grep -q "^${k}=" "$f"; then
    awk -v k="$k" -v v="$v" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$f" > "$t"
  else
    cat "$f" > "$t"
    printf '%s=%s\n' "$k" "$v" >> "$t"
  fi
  cat "$t" > "$f"          # back through the ORIGINAL inode: keeps owner + 0600
  rm -f "$t"
}
rb_sete "$RB_TS_ENV"   COOKIE_SECURE false
rb_sete "$RB_PROC_ENV" COOKIE_SECURE false
EOS
    echo "echo 'COOKIE_SECURE -> false in both .env.production. It was $PREV_SECURE_SHOW,'"
    echo "echo 'and this box is going back to plain HTTP, where a Secure cookie is'"
    echo "echo 'never returned and install.sh refuses to deploy at all.'"
  fi
  # Both recovery paths can be MISSING by the time this runs, so neither may be
  # the last word. The Caddyfile backup is taken tolerantly at step [5], and the
  # git checkout above may have rewound past render-caddyfile.sh — it does not
  # exist in any commit before this cutover work. Falling through to install.sh
  # is safe either way: the installer at that older commit copies deploy/Caddyfile
  # over /etc/caddy/Caddyfile itself, which is plain :80 — the rollback target.
  echo "CADDY_BAK='$CADDY_BAK'"
  echo "RENDER='$HERE/scripts/render-caddyfile.sh'"
  cat <<'EOS'
if [ -n "$CADDY_BAK" ] && sudo test -f "$CADDY_BAK"; then
  sudo cp -p "$CADDY_BAK" /etc/caddy/Caddyfile
elif [ -f "$RENDER" ]; then
  bash "$RENDER"
else
  echo "⚠ /etc/caddy/Caddyfile not restored here: no backup was taken and the" >&2
  echo "  generator is not in this checkout. install.sh below writes it." >&2
fi
sudo systemctl reload caddy || sudo systemctl restart caddy || true
EOS
  echo "bash '$HERE/scripts/install.sh'"
  echo "echo"
  echo "echo 'Rolled back to: $UNDO_DESC'"
  echo "echo 'That covers configuration${PREV_SHA:+ and code}. THE DATABASE WAS NOT ROLLED BACK —'"
  echo "echo 'the schema is still the migrated one. See the header of this script.'"
  if [ "$RB_SECURE_FIX" = "1" ]; then
    echo "echo"
    echo "echo 'ONE FIELD WAS NOT RESTORED: COOKIE_SECURE is false in both'"
    echo "echo '.env.production files, not the pre-cutover value ($PREV_SECURE_SHOW).'"
    echo "echo 'On a plain-HTTP box that value means nobody can sign in, and'"
    echo "echo 'install.sh refuses to deploy it. See the header of this script.'"
  fi
} > "$ROLLBACK"
chmod +x "$ROLLBACK"
echo "    rollback script: $ROLLBACK"

# ── recovery helpers, DEFINED BEFORE THE FIRST THING THAT CAN NEED THEM ───────
# Nothing above this point has modified the box. Everything below can, and the
# EXIT trap calls undo_tls, so it has to exist by the time the first change is
# made. That is the only reason these sit here rather than next to their callers.

# Undo just the TLS half: put the Caddyfile and site.env back the way they were
# minutes ago. Safe to call any time before the env files are touched.
#
# It restores THE STATE FROM BEFORE THIS RUN, which is only "back to plain HTTP"
# on a FIRST cutover. On a re-run over a box that was already on HTTPS — exactly
# what an operator does when the certificate broke and the site is already down
# — the backups taken at the top of this run ARE the HTTPS configuration, and
# COOKIE_SECURE was already true before we started. So undo_tls REPORTS what it
# actually left behind instead of each caller asserting "logins keep working":
# that sentence is false in the emergency case, and it is printed to someone
# whose payroll app is down.
undo_tls() {
  if [ "$HAD_SITE_ENV" = "1" ]; then cp -p "$SITE_ENV.pre-https.$TS" "$SITE_ENV" 2>/dev/null || true; else rm -f "$SITE_ENV" || true; fi
  sudo cp -p "$CADDY_BAK" /etc/caddy/Caddyfile 2>/dev/null || bash "$HERE/scripts/render-caddyfile.sh" || true
  sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy || true
  # Whatever brought us here, the half-applied state is now gone. Say so, so the
  # EXIT trap cannot run this twice if a later step also fails.
  CUTOVER_STATE=clean

  if [ "$WAS_HTTPS" = "1" ]; then
    cat >&2 <<EOF

  ⚠ THIS DID NOT PUT THE SITE BACK ON PLAIN HTTP, and it did not restore logins.
    This box was ALREADY serving https://$PREV_HOST before this run, so the
    configuration just restored is also an HTTPS one:
      · deploy/site.env is back to SITE_HOSTNAME=$PREV_HOST
      · /etc/caddy/Caddyfile is back to the HTTPS config
      · COOKIE_SECURE in $TS_ENV is $PREV_SECURE_DESC
        — this run never reached step [8], so that was already its value

    Whether the site is reachable right now therefore depends entirely on
    whether THAT configuration still works. (It does after a plain interrupt.
    It does not if you got here because the certificate stopped working — see
    below in that case.)
EOF
  else
    echo "    The site is back on plain HTTP at http://$MY_IP/." >&2
    if [ "$PREV_SECURE_IS_ON" = "1" ]; then
      cat >&2 <<EOF
    ⚠ But COOKIE_SECURE in $TS_ENV is $PREV_SECURE_DESC
      while the site serves plain HTTP. This run did not change that — it was
      already so — but in that state the browser never returns the login cookie
      and NOBODY CAN SIGN IN to either app. Set COOKIE_SECURE=false in both
      .env.production files and run deploy/scripts/install.sh, or finish this
      cutover.
EOF
    else
      echo "    COOKIE_SECURE was never touched, so logins keep working." >&2
    fi
  fi
}

# Only meaningful when this box was ALREADY on HTTPS: there a failed cutover is
# an outage, not a no-op, and "fix the certificate" may not be fast enough for
# people who have to submit timesheets today. HSTS is pinned to the HOSTNAME and
# an IP address can never be an HSTS host, so http://$MY_IP/ is the one URL
# still usable — but only after COOKIE_SECURE goes false and BOTH bundles are
# rebuilt, because that variable gates the HSTS header at build time in both
# next configs and the https:// redirect targets are baked into procurement.
emergency_hint() {
  [ "$WAS_HTTPS" = "1" ] || return 0
  EMERG="$HERE/.https-emergency-plain-http-$TS.sh"
  {
    cat <<EOS
#!/usr/bin/env bash
# EMERGENCY DOWNGRADE — written by enable-https.sh on $TS, after TLS for
# $HOST failed on a box that was already serving https://$PREV_HOST.
#
# Puts both apps back on plain HTTP at http://$MY_IP/ so staff can work while
# the certificate is broken. FULL REBUILD; everyone must log in again. Re-run
# deploy/scripts/enable-https.sh once the certificate problem is fixed.
set -euo pipefail
TS_ENV='$TS_ENV'
PROC_ENV='$PROC_ENV'
SITE_ENV='$SITE_ENV'
INSTALL='$HERE/scripts/install.sh'
MY_IP='$MY_IP'
EOS
    cat <<'EOS'
sete() {
  local f="$1" k="$2" v="$3" t
  [ -f "$f" ] || return 0
  t="$(mktemp)"
  if grep -q "^${k}=" "$f"; then
    awk -v k="$k" -v v="$v" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$f" > "$t"
  else
    cat "$f" > "$t"
    printf '%s=%s\n' "$k" "$v" >> "$t"
  fi
  cat "$t" > "$f"
  rm -f "$t"
}
# Caddy back to :80. render-caddyfile.sh ignores LEGACY_HTTP_HOST when there is
# no SITE_HOSTNAME, so blanking both leaves exactly one :80 site.
sete "$SITE_ENV" SITE_HOSTNAME ""
sete "$SITE_ENV" LEGACY_HTTP_HOST ""
# Drops the Secure flag, and — because both next configs gate HSTS on this same
# variable at BUILD time — stops either app sending Strict-Transport-Security.
sete "$TS_ENV"   COOKIE_SECURE false
sete "$PROC_ENV" COOKIE_SECURE false
# Otherwise password-reset emails and procurement's redirects keep pointing at
# the hostname that is currently dead.
sete "$TS_ENV"   SITE_URL "http://$MY_IP"
sete "$PROC_ENV" NEXT_PUBLIC_LOGIN_URL  "http://$MY_IP/login"
sete "$PROC_ENV" NEXT_PUBLIC_LOGOUT_URL "http://$MY_IP/login"
bash "$INSTALL"
echo
echo "Back on plain HTTP:  http://$MY_IP/   and   http://$MY_IP/procurement"
echo "Everyone must log in again."
echo "Browsers still refuse plain http for the HOSTNAME (HSTS, up to a year),"
echo "so use the IP until the certificate is fixed."
EOS
  } > "$EMERG"
  chmod +x "$EMERG"
  if [ "$PREV_HOST" = "$HOST" ]; then
    cat >&2 <<EOF

  ⚠ AND IT IS NOT: this run was re-establishing TLS for the SAME hostname the
    box was already serving, and that is exactly what failed. The site is DOWN
    until the certificate (or the DNS record) works, and there is no http://
    escape for $PREV_HOST — HSTS max-age=31536000 was already served for that
    name, so browsers refuse plain HTTP to it for up to a year.
EOF
  else
    cat >&2 <<EOF

  Note this run was MOVING the box from https://$PREV_HOST to https://$HOST,
  and only the new hostname failed. The old one was restored untouched, so
  check whether it is still serving before treating this as an outage:

      curl -sS -o /dev/null -w '%{http_code}\n' \\
        --resolve $PREV_HOST:443:$MY_IP https://$PREV_HOST/

  If that answers, staff can keep using https://$PREV_HOST and nothing here is
  urgent. The downgrade below is only for when it does not.
EOF
  fi
  cat >&2 <<EOF

  IF STAFF NEED PAYROLL BEFORE YOU CAN FIX IT:

      bash $EMERG

    Puts both apps back on http://$MY_IP/ — the one URL HSTS cannot block,
    because an IP address can never be an HSTS host. It blanks SITE_HOSTNAME,
    sets COOKIE_SECURE=false in both env files (which also drops the HSTS
    header from both bundles), points the reset and redirect URLs back at the
    IP, and rebuilds. Budget a full build; everyone logs in again.

    Do NOT expect $ROLLBACK
    to do this for you. It restores the state from before this run, and on this
    box that state is an HTTPS configuration — not plain HTTP.
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
echo "==> [6/8] Caddy: serve $HOST with automatic TLS"
# Persisted so install.sh renders the SAME config on every future deploy.
# Without this, the next `bash deploy/scripts/install.sh` would put the box back
# on plain :80 and TLS would vanish with it.
#
# ARM THE TRAP FIRST. From the moment site.env names the hostname, an unattended
# `install.sh` would render the HTTPS config — so site.env alone, with no
# certificate, is already a state that has to be undone if this run dies.
CUTOVER_STATE=caddy_staged

# ── the old http://<IP> URL: OFF by default. ─────────────────────────────────
# This used to write LEGACY_HTTP_HOST=$MY_IP unconditionally, which kept
# http://$MY_IP/<anything> answering after the cutover as a 301 to https. That
# was meant to soften old bookmarks. It cannot be made safe, for three reasons:
#
#  1. A redirect does not stop the request. By the time Caddy answers, the
#     browser has ALREADY put the pre-cutover ts_session cookie on the wire in
#     cleartext — it is host-scoped to the raw IP and was issued WITHOUT Secure
#     (lib/aws/auth.js:20-22, COOKIE_SECURE=false pre-cutover), so it is
#     attached to that plain-HTTP request like any other. The JWT is valid for
#     7 days, carries no origin or audience binding (lib/aws/jwt.js:29-35), and
#     both apps accept it anywhere. Whoever is on the same wifi replays it
#     against https://$HOST.
#  2. render-caddyfile.sh redirects with {uri}, so the full path AND query is
#     preserved — an already-emailed http://$MY_IP/reset?token=... sends a live
#     password-reset token in the clear, and it still works at the target.
#  3. The redirect's whole purpose is to keep old links working, i.e. to
#     MAXIMISE how many browsers make that cleartext request. It is not a
#     leftover; it is an invitation.
#
# With it empty, the final Caddyfile has ONE site block — $HOST — and nothing
# in it matches the raw IP. What actually happens then (measured against Caddy
# 2.11.4 with this exact generated config, not assumed):
#
#   http://<IP>/reset?token=…  -> 308 to https://<IP>/reset?token=…
#                                 Caddy's automatic-HTTPS redirect is a BLANKET
#                                 one on :80: it preserves whatever Host it was
#                                 given rather than 404ing. It does not proxy.
#   https://<IP>/…             -> TLS handshake FAILS. No certificate exists for
#                                 an IP address, and none can be issued.
#   the two backends           -> receive nothing at all. Verified: zero hits on
#                                 3009 and 3002 for every raw-IP request.
#
# So the raw IP becomes a DEAD END rather than a 404 page: it never reaches
# payroll and it cannot forward anyone to somewhere that does. What is LOST is
# real and the operator should know it: the raw-IP bookmark stops working, and
# what the user sees is a browser TLS error, not a redirect and not a tidy
# message. Everyone must be told the new URL before the cutover, not after.
#
# Nothing on this box can stop that FIRST cleartext request — the browser sends
# it before any server sees it. What closes the hole is step [8b] below, which
# bumps session_version so every cookie that could have been captured is already
# dead. The two go together: the dead end removes the reason to keep hitting the
# old URL, the bump removes the value of anything captured on the way there.
#
# CUTOVER_LEGACY_HTTP_REDIRECT=1 restores the old behaviour. It is a real trade-
# off — see deploy/docs/HTTPS-CUTOVER.md, "The raw-IP URL after the cutover".
if [ "${CUTOVER_LEGACY_HTTP_REDIRECT:-0}" = "1" ]; then
  LEGACY_VALUE="$MY_IP"
else
  LEGACY_VALUE=""
fi

# ── the ACME email SURVIVES a re-run that omits the optional argument ────────
# This write is a truncating rewrite of the whole file from argv, and re-running
# is what this script tells you to do after every failure. So
#     bash deploy/scripts/enable-https.sh apps.example.com
# used to write ACME_EMAIL= and silently delete the address the first run set.
# render-caddyfile.sh:109 then drops the global { email … } block entirely and
# Caddy re-registers with no contact — removing the only warning channel for
# silent renewal failure, on a name that HSTS has made http-unreachable. The
# argument is OPTIONAL; omitting it means "leave it alone", never "clear it".
if [ -n "$ACME_EMAIL_ARG" ]; then
  ACME_EMAIL_VALUE="$ACME_EMAIL_ARG"
else
  ACME_EMAIL_VALUE="$PREV_ACME_EMAIL"
fi

umask 077
{
  echo "# Written by deploy/scripts/enable-https.sh on $TS. See deploy/site.env.example."
  echo "SITE_HOSTNAME=$HOST"
  echo "ACME_EMAIL=$ACME_EMAIL_VALUE"
  echo "LEGACY_HTTP_HOST=$LEGACY_VALUE"
} > "$SITE_ENV"
umask 022
if [ -z "$ACME_EMAIL_VALUE" ]; then
  echo "    ⚠ no ACME email — Let's Encrypt cannot warn you if renewal breaks."
  echo "      Pass one as the second argument to set it:"
  echo "          bash deploy/scripts/enable-https.sh $HOST you@yourdomain.com"
elif [ -z "$ACME_EMAIL_ARG" ]; then
  echo "    ACME email kept as $ACME_EMAIL_VALUE (from the previous deploy/site.env —"
  echo "      no second argument was given, so it is preserved rather than cleared)."
elif [ -z "$PREV_ACME_EMAIL" ]; then
  echo "    ACME email set to $ACME_EMAIL_VALUE — Let's Encrypt warns this address if"
  echo "      renewal starts failing."
elif [ "$PREV_ACME_EMAIL" != "$ACME_EMAIL_VALUE" ]; then
  echo "    ⚠ ACME email CHANGED: was $PREV_ACME_EMAIL -> now $ACME_EMAIL_VALUE."
  echo "      Renewal warnings stop going to the old address. If that was not"
  echo "      intended, re-run with $PREV_ACME_EMAIL as the second argument."
else
  echo "    ACME email unchanged ($ACME_EMAIL_VALUE)."
fi
if [ "$PREV_TLS_UPSTREAM" = "1" ]; then
  echo "    ⚠ the previous deploy/site.env had TLS_TERMINATES_UPSTREAM=1 and this"
  echo "      rewrite DROPS it. That is deliberate: Caddy on this box terminates TLS"
  echo "      itself from now on, and a stale flag would disable install.sh's"
  echo "      lockout gate if SITE_HOSTNAME were ever blanked again. If something in"
  echo "      front of this box really does terminate TLS, add the line back."
fi
if [ -n "$LEGACY_VALUE" ]; then
  cat <<EOF
    ⚠ CUTOVER_LEGACY_HTTP_REDIRECT=1 — http://$MY_IP/ will KEEP ANSWERING after
      the cutover, as a 301 to https://$HOST. Understand what that is:
      every browser that still has the old bookmark sends its pre-cutover
      session cookie — issued without Secure — over plain HTTP before the
      redirect can happen, and the same is true of any already-emailed
      http://$MY_IP/reset?token=... link, token and all.
      Step [8b] invalidates every pre-cutover session, so what leaks is dead on
      arrival; but the redirect keeps people using a plaintext URL. Blank
      LEGACY_HTTP_HOST in deploy/site.env and re-run install.sh the moment the
      bookmarks are updated — days, not months.
EOF
else
  cat <<EOF
    http://$MY_IP/ will STOP REACHING these apps. It becomes a dead end: Caddy's
    blanket :80 redirect sends it to https://$MY_IP/, which has no certificate
    and never will, so the browser shows a TLS error. Nothing is proxied to
    either app. That is deliberate — a WORKING redirect there cannot be made
    safe, because the browser attaches the old, non-Secure session cookie to the
    plaintext request before any redirect can happen.
    The cost is real: the raw-IP bookmark breaks with an error page rather than
    forwarding anyone. Tell people the new URL BEFORE you cut over.
    CUTOVER_LEGACY_HTTP_REDIRECT=1 keeps the old redirect if you must.
EOF
fi

# ── THE STAGED SWITCH — this is why the site does not go down here.
#
# The obvious implementation is to render the final config now and wait for the
# certificate. Do not do that. The final config has no plain-HTTP catch-all: the
# moment Caddy reloads it, http://<IP>/ 301s to https, http://<host>/ 308s to
# https (Caddy's own automatic redirect), and https:// cannot hand out a
# certificate it has not been issued yet. Every URL is dead — for 10-30s if
# issuance works, for the whole ${TLS_TIMEOUT}s timeout if it does not, and
# INDEFINITELY if the script is killed in between, because then nothing ever
# runs the rollback. That is a hard payroll outage caused by the fix.
#
# So render --staging instead: the pre-cutover ":80" catch-all is kept exactly
# as it is and an "https://$HOST" block is added beside it. Caddy provisions the
# certificate against that block while plain HTTP keeps serving both apps, and
# the ACME HTTP-01 challenge still wins on port 80 (Caddy prepends the challenge
# routes ahead of user routes). Nothing is redirected until there is something
# to redirect TO.
echo "    staging: adding https://$HOST while plain HTTP keeps serving, so the"
echo "    site stays up while Let's Encrypt issues. Redirects come after the cert."
bash "$HERE/scripts/render-caddyfile.sh" --staging

echo "==> [7/8] waiting for the certificate (up to ${TLS_TIMEOUT}s)"
echo "    Caddy is asking Let's Encrypt now. This normally takes 10-30s."
echo "    Probing $MY_IP directly (--resolve), so only THIS box can pass."
echo "    The site is UP throughout this wait — Ctrl-C here is safe."

DEADLINE=$(( $(date +%s) + TLS_TIMEOUT ))
TLS_OK=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # NO -k. The point is that the certificate VALIDATES; a handshake we had to
  # force would prove nothing and would happily accept Caddy's internal CA.
  # PINNED to $MY_IP: an unpinned probe is answered by whoever DNS points at
  # right now, and a valid certificate held by someone else (Cloudflare's edge,
  # a stale host in the box's resolver cache) is not evidence about this box.
  if curl -sS -o /dev/null --max-time 10 "${PIN443[@]}" "https://$HOST/" 2>/dev/null; then TLS_OK=1; break; fi
  printf '.'
  sleep 5
done
echo
if [ "$TLS_OK" != "1" ]; then
  echo "    ✗ https://$HOST/ still does not complete a valid TLS handshake" >&2
  echo "      against this box ($MY_IP)." >&2
  echo "    Rolling the Caddy config back." >&2
  # Diagnose BEFORE the rollback, while the hostname config is still live: if
  # the unpinned probe succeeds where the pinned one failed, something that is
  # not this box is serving $HOST. That is the case the old, unpinned gate used
  # to mistake for success.
  IMPOSTOR=0
  if curl -sS -o /dev/null --max-time 10 "https://$HOST/" 2>/dev/null; then IMPOSTOR=1; fi
  NOW_A="$(public_a_record "$HOST")"
  undo_tls
  cat >&2 <<EOF

  What to check, in order:
    1. Is TCP 443 open in the security group?  (port 80 answered, 443 may not be)
         aws ec2 describe-security-groups --group-ids <app-sg> --region us-east-2 \\
           --query 'SecurityGroups[0].IpPermissions'
    2. Is EGRESS open? Caddy makes an OUTBOUND HTTPS call to
       acme-v02.api.letsencrypt.org. A locked-down egress rule blocks issuance
       even with 80 and 443 open inbound.
    3. What did Caddy actually say?
         sudo journalctl -u caddy --since '10 min ago' --no-pager | tail -60
    4. Cloudflare proxy back ON? $HOST resolves to: $(echo "${NOW_A:-nothing}" | tr '\n' ' ')
       (this box is $MY_IP)
EOF
  if [ "$IMPOSTOR" = "1" ]; then
    cat >&2 <<EOF

  ⚠ NOTE: https://$HOST/ DOES serve a valid certificate — just not from this
    box. Something else is answering for that name (a Cloudflare proxy in front
    of it is the usual cause; a second server is the other). Do not treat the
    padlock you see in a browser as proof that this cutover worked: the origin
    leg would still be plain HTTP, and this box has no certificate of its own.
EOF
  fi
  echo >&2
  echo "  No env file was changed. Fix and re-run this script." >&2
  emergency_hint
  exit 1
fi

# Pinned to $MY_IP for the same reason as the probe above: we are asking what
# THIS box presents, not what the name resolves to.
ISSUER="$(echo | openssl s_client -connect "$MY_IP:443" -servername "$HOST" 2>/dev/null \
           | openssl x509 -noout -issuer -dates 2>/dev/null || true)"
# Caddy falls back to its OWN internal CA when ACME fails, and it installs that
# root into this box's trust store — so curl above can validate a certificate
# that no browser on earth will accept. Assert the issuer rather than printing
# it and hoping someone reads it.
if echo "$ISSUER" | grep -qi 'Caddy Local Authority\|Caddy Internal'; then
  echo "    ✗ this box is serving its OWN internal certificate, not a public one:" >&2
  echo "$ISSUER" | awk '{print "        " $0}' >&2
  cat >&2 <<EOF

  ACME failed and Caddy fell back to its internal CA. curl on this box trusts
  that root (Caddy installed it here); no browser does. Every user would get a
  full-page certificate warning, so this is a FAILED cutover, not a live one.

  Look for the real error:
      sudo journalctl -u caddy --since '15 min ago' --no-pager | grep -i 'acme\|error'

  Rolling the Caddy config back. No env file was changed.
EOF
  undo_tls
  emergency_hint
  exit 1
fi
echo "    ✓ certificate is live, validates, and is served by THIS box ($MY_IP)"
if [ -n "$ISSUER" ]; then echo "$ISSUER" | awk '{print "      " $0}'; fi

# ────────────────────────── 6. ONLY NOW: secure cookie, https URLs, rebuild

# DNS was checked in step [1], several minutes and one certificate issuance ago.
# Check it AGAIN at the last reversible moment: the pinned probes above prove
# this box's TLS works, but they say nothing about where the public actually
# lands. If the record moved in the meantime — the orange cloud switched back
# on is the realistic way — users would reach Cloudflare, not here, and with
# Cloudflare's SSL mode set to Flexible the origin leg is plain HTTP: this box
# 308-redirects it to https and the request loops. COOKIE_SECURE=true on top of
# that is the lockout. Everything so far is still undoable; from the next line
# on it is a rebuild to undo.
FINAL_A="$(public_a_record "$HOST")"
# One retry: both public resolvers timing out at the same moment would otherwise
# abort a perfectly good cutover after the certificate was already issued.
if [ "$FINAL_A" != "$MY_IP" ]; then sleep 5; FINAL_A="$(public_a_record "$HOST")"; fi
if [ "$FINAL_A" != "$MY_IP" ]; then
  echo "    ✗ $HOST no longer resolves to this box." >&2
  echo "        expected: $MY_IP" >&2
  echo "        now:      $(echo "${FINAL_A:-nothing}" | tr '\n' ' ')" >&2
  cat >&2 <<EOF

  It pointed here when this run started, so it changed in the last few minutes.
  The usual cause is the Cloudflare proxy being switched back on mid-cutover.

  Stopping BEFORE the env flip: no env file has been changed by this run.
  Rolling the Caddy config back; fix DNS and re-run.
EOF
  undo_tls
  emergency_hint
  exit 1
fi

# ── promote the staged config to the final one.
# Until now the box has been serving the app over BOTH plain HTTP (the :80
# catch-all kept from before the cutover) and the freshly-certificated https://.
# Swap in the final config: :80 becomes a redirect and the app is only ever
# served over TLS. This reload is safe in a way the old single-step switch was
# not — the certificate is already in Caddy's storage and has been proven with a
# real handshake, so there is no window without one.
echo "    certificate proven — promoting to the final config"
if [ -n "$LEGACY_VALUE" ]; then
  echo "    (http://$MY_IP/ stays alive as a 301 — you asked for it with"
  echo "     CUTOVER_LEGACY_HTTP_REDIRECT=1. Turn it off as soon as you can.)"
else
  echo "    (http://$MY_IP/ stops reaching the apps: no site block matches that"
  echo "     Host, so it dead-ends on Caddy's blanket redirect to https://$MY_IP/,"
  echo "     which has no certificate. Plain HTTP no longer reaches payroll.)"
fi
bash "$HERE/scripts/render-caddyfile.sh"
# From here an interrupt leaves a WORKING https site rather than a half-switch,
# so the trap stops restoring and starts explaining. See cleanup().
CUTOVER_STATE=tls_live

echo "==> [8/8] switching the apps to https (cookie flag LAST, on purpose)"

# Replace the whole line, or append if the key is absent. Writes back through
# the ORIGINAL inode so the file keeps its ownership and 0600-ish permissions —
# these files hold the database password.
set_env() {
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp)"
  if grep -q "^${k}=" "$f"; then
    awk -v k="$k" -v v="$v" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$f" > "$tmp"
  else
    cat "$f" > "$tmp"
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  cat "$tmp" > "$f"
  rm -f "$tmp"
  echo "    $(basename "$(dirname "$f")")/.env.production  $k=$v"
}

# Past this line an interrupt can leave the env files and the built bundles
# disagreeing, and undoing that is a rebuild rather than a file copy — so the
# trap stops trying to fix it automatically and points at $ROLLBACK instead.
CUTOVER_STATE=env_flipped

# SITE_URL is server-only and runtime-only, but it is what builds password-reset
# links (app/api/auth/forgot/route.js:23). Left on http:// it emails people a
# link to an origin that no longer serves the app.
set_env "$TS_ENV" SITE_URL "https://$HOST"
# COOKIE_SECURE has a split personality: RUNTIME for the Set-Cookie flag
# (lib/aws/auth.js:20), BUILD-TIME for HSTS (next.config.js:34, and procurement's
# next.config.ts:71). Hence the rebuild below. It must literally read "true" —
# blanking it is NOT neutral: the fallback is NODE_ENV === "production", which
# is also true, so an empty value locks everyone out just the same.
set_env "$TS_ENV" COOKIE_SECURE true

if [ -f "$PROC_ENV" ]; then
  # These two are NEXT_PUBLIC_ and reach NextResponse.redirect() (src/proxy.ts:163,
  # src/app/auth/signout/route.ts:10), which requires an absolute URL — so they
  # cannot be made relative to dodge the rebuild. They are compiled in.
  set_env "$PROC_ENV" NEXT_PUBLIC_LOGIN_URL  "https://$HOST/login"
  set_env "$PROC_ENV" NEXT_PUBLIC_LOGOUT_URL "https://$HOST/login"
  # Set EXPLICITLY. Procurement's HSTS/COOP block reads COOKIE_SECURE, but the
  # variable was only ever reaching that build by accident, leaking out of the
  # timesheet's env that install.sh sources. Do not rely on the leak.
  set_env "$PROC_ENV" COOKIE_SECURE true
else
  echo "    (no $PROC_ENV — skipping procurement)"
fi

echo
echo "    rebuilding both apps via install.sh (NEXT_PUBLIC_* are baked at build"
echo "    time, so a restart alone would keep the old URLs). This takes a while,"
echo "    but both apps keep serving their CURRENT build throughout: install.sh"
echo "    builds into .next.build and swaps it in at the end, one app at a time."
echo "    Each app blips for a few seconds at its own swap; nothing else."
echo
echo "    So do NOT dismiss a watchdog email during this. If monitor.sh reports"
echo "    'APP IS DOWN' now it means the app is genuinely down, and this run"
echo "    should be treated as a failed cutover — not as expected build noise."
echo
if ! bash "$HERE/scripts/install.sh"; then
  cat >&2 <<EOF

✗ install.sh failed AFTER the env files were switched to https.

  TLS is live and the certificate is fine. What is uncertain is the build.

  Read install.sh's LAST lines above before assuming the site is up:
    • "rolled back to the previous build"  -> still serving, but the OLD bundle,
      which still redirects to http://$MY_IP/login.
    • "there is NO previous build to roll back to" -> that app has no build. It
      was left running on purpose and NOT restarted, because restarting it would
      crash-loop it into a hard outage. Do not restart it. Free disk/memory and
      re-run this script until a build succeeds.
    • "exiting before step [6/8] ... reloading ajace-timesheet" -> the TIMESHEET
      built fine and is now live on the NEW bundle (https URLs, Secure cookie);
      it was only PROCUREMENT that failed. Payroll works and logins work. The
      mixed state is that https://$HOST/procurement still carries the old
      baked-in http://$MY_IP/login redirect until its build succeeds.

  Check what is actually running:
      pm2 status
      pm2 logs ajace-procurement --lines 60 --nostream
  Then either fix and re-run this script, or roll the whole cutover back:
      bash $ROLLBACK
EOF
  if [ "$REVOKE_NEEDED" = "1" ]; then
    cat >&2 <<EOF

  AND ONE SECURITY STEP HAS NOT RUN: step [8b] revokes every session issued
  while this box was on plain HTTP, and it comes AFTER the rebuild — so it did
  not happen. Those are 7-day JWTs with no origin binding, accepted by both
  apps, and some of them travelled in cleartext. They are still valid.

  This is recorded, so nothing silently forgets it:
      SESSIONS_NEED_REVOKE=1 in $PROGRESS
  The next run of this script that gets past the rebuild will do it, and will
  say so. If that will not be today, do it by hand now — it takes a second:

EOF
    manual_revoke_hint
    echo >&2
    echo "  Everyone then has to sign in again, which they have to do anyway. Doing" >&2
    echo "  it by hand does not update the file above, so a later successful run" >&2
    echo "  bumps it once more — one extra sign-in, not a problem." >&2
  fi
  exit 1
fi

# Everything that can leave a half-state is behind us: config, certificate, env
# files and both builds are consistent. The trap has nothing left to undo.
CUTOVER_STATE="done"   # quoted: shellcheck reads a bare `done` as the keyword

# ───────────────────── 8b. invalidate every session issued before the cutover
# Until a minute ago this box served payroll over plain HTTP on a raw IP. Every
# session cookie in existence was therefore:
#   · issued WITHOUT Secure               (lib/aws/auth.js:20-22)
#   · sent in cleartext on every request  (http://$MY_IP/...)
#   · a 7-day JWT with no origin or audience claim (lib/aws/jwt.js:29-35)
# and both apps accept it on ANY origin as long as session_version still matches
# (lib/aws/auth.js:63, procurement src/proxy.ts:61). Switching to HTTPS does not
# retire a single one of them: a token captured last week off a coffee-shop
# network is replayable against https://$HOST until it expires. New URL, same
# credentials, and the capture window is everything that came before.
#
# session_version exists for exactly this — it is what set-password.sh bumps to
# sign someone out everywhere. Bump it for everyone, once, here.
#
# WHY HERE, and not earlier: before install.sh finished, the box was still
# issuing cookies over plain HTTP, so anyone forced to log in again would just
# have minted another cleartext session. This is the first moment at which
# logging in produces a Secure cookie over TLS.
#
# WHY NOT ALWAYS: if this box has only ever served HTTPS, no session ever
# crossed plain HTTP, and a hostname change logs everyone out by itself — the
# cookie belongs to the old origin. Bumping then would be a gratuitous mass
# logout, most likely during an emergency re-run.
#
# WHAT DECIDES IT: $REVOKE_NEEDED, computed at step [5] from the PERSISTED
# record ($PROGRESS) and cleared only by a revocation that actually succeeded.
# NOT from site.env — this script writes the hostname there at step [6], so on a
# re-run after a failed rebuild site.env describes this script's own unfinished
# work, and reading it back would skip the revocation and announce that it was
# never needed. Every claim below is about something that happened.
REVOKE_STATE=skipped
REVOKE_N=""
REVOKE_ERR=""
if [ "$REVOKE_NEEDED" != "1" ]; then
  echo
  if [ -n "$PG_REVOKED_AT" ]; then
    REVOKE_STATE=already
    echo "==> [8b] sessions: ALREADY REVOKED. An earlier run of this script bumped"
    echo "         session_version on $PG_REVOKED_N accounts at $PG_REVOKED_AT (UTC) for this"
    echo "         same hostname — recorded in"
    echo "         $PROGRESS."
    echo "         Not repeating it: everything issued before that bump is dead, and"
    echo "         a second bump would sign out everyone who has logged in since."
  else
    echo "==> [8b] sessions: not revoked, and they do not need to be — this box was"
    echo "         already serving https://$PG_PRE_HOST when this cutover started, so no"
    echo "         session cookie of this box's making has ever crossed plain HTTP."
    if [ "$PG_INFERRED" = "1" ]; then
      echo
      echo "         ⚠ READ THIS BEFORE BELIEVING THE LINE ABOVE. There is no"
      echo "           $PROGRESS on this box, so"
      echo "           \"already serving https\" was inferred from deploy/site.env —"
      echo "           which records what is served NOW, not what was served before."
      echo "           If a cutover was interrupted, or site.env was restored from the"
      echo "           S3 backup, this box may never have revoked its pre-HTTPS"
      echo "           sessions and they are still valid. Revoke by hand:"
      manual_revoke_hint
    fi
  fi
elif ! command -v psql >/dev/null 2>&1; then
  REVOKE_STATE=failed
  REVOKE_ERR="psql is not installed on this box"
else
  echo
  echo "==> [8b] revoking every pre-cutover session (they were issued over plain HTTP)"
  # Subshell so the app's environment — including the database password — never
  # lands in this script's shell. Same pattern as set-password.sh.
  # lock_timeout/statement_timeout: this is a full-table UPDATE on a live payroll
  # database. Small table, but it must fail fast rather than queue behind an open
  # transaction and stall sign-ins.
  if REVOKE_OUT="$(
        (
          set -a
          # shellcheck source=/dev/null
          . "$TS_ENV"
          set +a
          PGOPTIONS="-c lock_timeout=${DB_LOCK_TIMEOUT:-5s} -c statement_timeout=30s" \
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -c \
            "with bumped as (
               update public.auth_users set session_version = session_version + 1
               returning 1
             ) select count(*) from bumped"
        ) 2>&1
      )"; then
    REVOKE_N="$(printf '%s\n' "$REVOKE_OUT" | tail -1 | tr -d '[:space:]')"
    if printf '%s' "$REVOKE_N" | grep -Eq '^[0-9]+$'; then
      REVOKE_STATE=ok
      echo "    ✓ $REVOKE_N accounts — every session issued before this cutover is now dead."
      echo "      Everyone signs in again, over HTTPS, and gets a Secure cookie."
    else
      REVOKE_STATE=failed
      REVOKE_ERR="psql returned something that is not a row count: $REVOKE_OUT"
    fi
  else
    REVOKE_STATE=failed
    REVOKE_ERR="$REVOKE_OUT"
  fi
fi

# ── record WHAT ACTUALLY HAPPENED ────────────────────────────────────────────
# CUTOVER_COMPLETED_AT means one thing: a run got to a working HTTPS end state —
# certificate proven, env files flipped, install.sh returned 0. And
# SESSIONS_NEED_REVOKE drops to 0 ONLY on the strength of an UPDATE that came
# back with a row count. A failed revocation therefore leaves a COMPLETED
# cutover with the flag still set, so the next run does the revocation instead
# of inferring from "the cutover finished" that the revocation must have too.
PG_COMPLETED="$TS"
if [ "$REVOKE_STATE" = "ok" ]; then
  REVOKE_NEEDED=0
  PG_REVOKED_AT="$TS"
  PG_REVOKED_N="$REVOKE_N"
  PG_REVOKED_HOST="$HOST"
fi
pg_write

if [ "$REVOKE_STATE" = "failed" ]; then
  # Scrub any password out of a psql connection error before it hits the
  # terminal (and whatever scrollback or ticket it gets pasted into).
  SAFE_ERR="$(printf '%s\n' "$REVOKE_ERR" | sed -E 's#(://[^:/@[:space:]]+):[^@[:space:]]*@#\1:***@#g')"
  cat >&2 <<EOF

  ✗ COULD NOT REVOKE PRE-CUTOVER SESSIONS.

    HTTPS is live and correct — this one step did not run, and it is the only
    thing outstanding. Do NOT roll back over this.

    Why it matters: every session cookie issued before today was sent in
    cleartext to http://$MY_IP/ without the Secure flag. Those tokens are valid
    for 7 days, are not bound to an origin, and are accepted by BOTH apps. Until
    session_version moves, anyone holding a captured one is logged in as that
    user at https://$HOST.

    Run this on the box now — it takes a second:

$(manual_revoke_hint 2>&1)

    Everyone then has to sign in again, which they have to do anyway.

    It is also RECORDED as outstanding (SESSIONS_NEED_REVOKE=1 in
    $PROGRESS), so re-running this script
    will retry it — and will not pretend it happened.

    psql said:
$(printf '%s\n' "$SAFE_ERR" | sed 's/^/      /')
EOF
fi

# ───────────────────────────────────────────────────────────── final checks
echo
hr
# Pinned like every other probe: these are checks on what THIS box serves, and a
# 200 collected from some other host that answers for $HOST would be worse than
# no check at all.
REDIR="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PIN80[@]}" "http://$HOST/" 2>/dev/null || echo 000)"
HEALTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${PIN443[@]}" "https://$HOST/api/health" 2>/dev/null || echo 000)"
PROC_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${PIN443[@]}" "https://$HOST/procurement/login" 2>/dev/null || echo 000)"

# ── the two things this checklist used to ASSERT IN PROSE and never measure ──
#
# 1. HSTS. The closing banner has always announced "HSTS is now on", but nothing
#    ever looked. It is not a given: both apps emit the header only if
#    COOKIE_SECURE === "true" WAS SET WHEN THE BUNDLE WAS BUILT (next.config.js:34,
#    procurement next.config.ts:81). A build that picked up a stale environment,
#    a swap that did not happen, or procurement inheriting a different value from
#    the timesheet's exported env (install.sh:125 exports it, and @next/env will
#    not let procurement's own .env.production override a key already in the
#    process environment) all produce a live site with no HSTS and no complaint.
#    Ask the server instead of asserting it.
#
# 2. The old plaintext host. It must not serve the apps. 404 (or connection
#    failure) is the pass; 301 is the pass only if the operator explicitly asked
#    for the grace redirect; 200 means plain HTTP is still serving payroll and
#    the whole cutover has not actually moved anything.
hsts_of() {
  # -L: HSTS is honoured from ANY https response, so following /'s redirect to
  # /login is fine. grep exits 1 with no match, which under `set -o pipefail`
  # would abort the script here — hence `|| true`.
  curl -sS -o /dev/null -D - -L --max-time 20 "${PIN443[@]}" "$1" 2>/dev/null \
    | tr -d '\r' \
    | grep -i '^strict-transport-security:' \
    | head -1 | cut -d: -f2- | sed 's/^ *//' || true
}
HSTS_TS="$(hsts_of "https://$HOST/api/health")"
HSTS_PROC="$(hsts_of "https://$HOST/procurement/login")"
# Not pinned: the point is what answers on the raw IP itself, which is what an
# old bookmark actually hits. There is no name to resolve.
#
# Both the code AND the redirect target matter, and neither alone is enough:
#   308 -> https://<IP>/         the dead end. No cert for an IP, so it stops
#                                there. This is the pass when the grace
#                                redirect is off — NOT a 404. Caddy's automatic
#                                :80 redirect is a blanket, Host-preserving one.
#   301 -> https://<HOST>/       the grace redirect, only if it was asked for.
#   2xx                          plain HTTP is still SERVING payroll. Fail.
LEGACY_PROBE="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$MY_IP/" 2>/dev/null || echo '000 -')"
LEGACY_CODE="${LEGACY_PROBE%% *}"
LEGACY_TO="${LEGACY_PROBE#* }"

echo "  http://$HOST/                  -> HTTP $REDIR   (want 301/308: the redirect to https)"
echo "  https://$HOST/api/health       -> HTTP $HEALTH   (want 200)"
echo "  https://$HOST/procurement/login-> HTTP $PROC_CODE   (want 200 or 307)"
if [ -n "$LEGACY_VALUE" ]; then
  echo "  http://$MY_IP/ (plaintext)     -> HTTP $LEGACY_CODE ${LEGACY_TO:-}   (want 301 to https://$HOST/ — the grace redirect you asked for)"
else
  echo "  http://$MY_IP/ (plaintext)     -> HTTP $LEGACY_CODE ${LEGACY_TO:-}   (want 308 to https://$MY_IP/ — a dead end, no cert for an IP)"
fi
echo "  HSTS on /                      -> ${HSTS_TS:-ABSENT}"
echo "  HSTS on /procurement           -> ${HSTS_PROC:-ABSENT}"
hr

POST_CHECK_FAILED=0
if [ -z "$HSTS_TS" ] && [ -z "$HSTS_PROC" ]; then
  HSTS_MISSING_ON="BOTH apps"
elif [ -z "$HSTS_TS" ]; then
  HSTS_MISSING_ON="the TIMESHEET (procurement is sending it)"
elif [ -z "$HSTS_PROC" ]; then
  HSTS_MISSING_ON="PROCUREMENT (the timesheet is sending it)"
else
  HSTS_MISSING_ON=""
fi
if [ -n "$HSTS_MISSING_ON" ]; then
  POST_CHECK_FAILED=1
  cat >&2 <<EOF

  ✗ Strict-Transport-Security is MISSING from $HSTS_MISSING_ON.

    The site works, so this is not an outage — but without HSTS a browser will
    still follow a plain http:// link to $HOST, which is the downgrade the
    cutover was supposed to close.

    Both apps add the header only when COOKIE_SECURE === "true" AT BUILD TIME.
    Check what the running builds were built with:

        grep -n '^COOKIE_SECURE=' $TS_ENV $PROC_ENV
        pm2 status          # both apps restarted after the last build?

    If procurement alone is missing it: note that install.sh exports the
    TIMESHEET's environment before building procurement, and Next will not let
    procurement's own .env.production override a key that is already in the
    process environment — so procurement's HSTS follows $TS_ENV,
    not its own file. Make them agree, then re-run install.sh.
EOF
fi
case "$LEGACY_CODE" in
  2*)
    POST_CHECK_FAILED=1
    cat >&2 <<EOF

  ✗ http://$MY_IP/ IS STILL SERVING AN APP over plain HTTP (HTTP $LEGACY_CODE).

    That is the pre-cutover Caddy config still running: payroll is reachable
    without TLS, and every request to it carries the session cookie in clear.
    The cutover has not actually moved anything. Check what is installed, then
    re-render:

        sudo grep -n 'handle\|reverse_proxy\|^:80' /etc/caddy/Caddyfile
        bash deploy/scripts/render-caddyfile.sh
EOF
    ;;
  30*)
    # A redirect is expected in BOTH modes; what differs is where it points.
    if [ -z "$LEGACY_VALUE" ] && [ "${LEGACY_TO#https://"$HOST"}" != "$LEGACY_TO" ]; then
      echo "  ⚠ http://$MY_IP/ redirects to https://$HOST — a WORKING plaintext" >&2
      echo "    entry point, which this run did not configure (LEGACY_HTTP_HOST is" >&2
      echo "    empty in deploy/site.env). Something else is serving :80 for that" >&2
      echo "    address, or /etc/caddy/Caddyfile is stale. Check it." >&2
    fi
    ;;
  000)
    echo "  (nothing answered on http://$MY_IP/ — this box may not be able to reach" >&2
    echo "   its own public IP. Check from your laptop; it is not evidence either way.)" >&2
    ;;
esac
# What to tell staff. Driven by what step [8b] ACTUALLY DID this run, not by
# what the configuration implies it should have done — a revocation that failed,
# or that a previous run already performed, are different sentences and the
# operator is about to repeat one of them to the whole company.
if [ "$WAS_HTTPS" = "1" ]; then ORIGIN_WAS="https://$PREV_HOST"; else ORIGIN_WAS="http://$MY_IP"; fi
case "$REVOKE_STATE" in
  ok)
    LOGOUT_NOTE="
EVERYONE MUST LOG IN AGAIN. Step [8b] bumped session_version on all $REVOKE_N
accounts, which invalidates every token issued before this cutover SERVER-SIDE.
That is deliberate: those tokens were minted without Secure and travelled in
cleartext for as long as this box was on plain HTTP, so any of them could
already be in someone else's hands. They are dead now."
    if [ "$ORIGIN_WAS" != "https://$HOST" ]; then
      LOGOUT_NOTE="$LOGOUT_NOTE
The origin changed as well ($ORIGIN_WAS -> https://$HOST), so the browser would
not have sent the old cookie here in any case."
    fi
    LOGOUT_NOTE="$LOGOUT_NOTE
Nothing is lost — no data, no password. One sign-in each."
    ;;
  failed)
    LOGOUT_NOTE="
EVERYONE MUST LOG IN AGAIN. The old cookie was issued for a different origin
($ORIGIN_WAS) and the browser will not send it to the new one.
⚠ But the SERVER still accepts those tokens — see the failed session revocation
  above, and run the psql line it printed. Nothing here has revoked them."
    ;;
  already)
    LOGOUT_NOTE="
(Step [8b] had already been done for this hostname on $PG_REVOKED_AT, by an
earlier run — everything issued before that bump died then, and this run did not
repeat it. Anyone who has signed in since keeps their session.)"
    if [ "$ORIGIN_WAS" != "https://$HOST" ]; then
      LOGOUT_NOTE="$LOGOUT_NOTE
EVERYONE MUST LOG IN AGAIN anyway: this box was serving $ORIGIN_WAS and now
serves https://$HOST, and the old cookie belongs to the old origin."
    fi
    ;;
  *)
    if [ "$ORIGIN_WAS" = "https://$HOST" ]; then
      LOGOUT_NOTE="
(Re-run over a box already serving this same hostname: the origin did not
change and no session of this box's making has ever crossed plain HTTP, so
sessions are unaffected and nobody is logged out.)"
      if [ "$PG_INFERRED" = "1" ]; then
        LOGOUT_NOTE="$LOGOUT_NOTE
  ⚠ Inferred from deploy/site.env, not from a cutover record — there is no
    $PROGRESS on this box. If a cutover was
    interrupted or site.env came back from the S3 backup, pre-HTTPS sessions
    may still be live. See step [8b] above for the manual revoke."
      fi
    else
      LOGOUT_NOTE="
EVERYONE MUST LOG IN AGAIN. This box was serving $ORIGIN_WAS and now
serves https://$HOST. The old cookie belongs to the old origin and the browser
will not send it to the new one."
    fi
    ;;
esac
cat <<EOF

✅ https://$HOST is live.
$LOGOUT_NOTE

CHECK THESE SEVEN THINGS IN A BROWSER before you tell staff:

  1. Open  https://$HOST/  — padlock, no warning. Click it: the certificate
     should be issued by "Let's Encrypt", not by "Caddy Local Authority"
     (that one means ACME failed and Caddy fell back to its internal CA).
  2. Log in. Then DevTools → Application → Cookies → https://$HOST
     The cookie  ts_session  must show:
         Secure ✓   HttpOnly ✓   SameSite Lax   Path /   Domain (blank/$HOST)
     If Domain shows anything else, stop — NEXT_PUBLIC_COOKIE_DOMAIN got set
     somewhere and the cookie will not reach both apps.
  3. Without logging in again, go to  https://$HOST/procurement
     The same session must carry you straight in — no redirect loop, no
     second login. That is the whole reason for one hostname with paths.
  4. Sign out from inside procurement. It must land you on
     https://$HOST/login , NOT on http://$MY_IP/login .
  5. Request a password reset for a test account and read the email (or
     'pm2 logs ajace-timesheet' if AUTH_LOG_RESET_LINKS=1). The link must
     start  https://$HOST/reset  — an http:// link is a dead link now.
  6. Submit any form inside procurement (e.g. save a bid). Next 16 checks the
     request Origin against the forwarded Host for server actions, and this is
     the first time that path has ever run over https on this box.
  7. In a private window, open  http://$MY_IP/ .
$(if [ -n "$LEGACY_VALUE" ]; then
    echo "     It should 301 to https://$HOST/ — you asked for that with
     CUTOVER_LEGACY_HTTP_REDIRECT=1. It is a PLAINTEXT URL that people will keep
     using: blank LEGACY_HTTP_HOST in deploy/site.env and re-run install.sh as
     soon as the bookmarks are updated."
  else
    echo "     Expect it to FAIL — a 308 to https://$MY_IP/ , which has no
     certificate and cannot have one. That is the intended dead end, not a
     bug: the raw-IP bookmark is gone. If you see a login page there instead,
     plain HTTP is still serving payroll and this cutover moved nothing."
  fi)

IF ANYTHING ABOVE IS WRONG:

    bash $ROLLBACK

  That restores both .env.production files, the Caddyfile and deploy/site.env,
  $(if [ -n "$PREV_SHA" ]; then
      echo "and the git checkout (back to ${PREV_SHA:0:12}), then rebuilds."
    else
      echo "then rebuilds — but NOT the code, which stays where it is now."
    fi)
  It is NOT instant — the hostname is compiled into procurement's bundle, so
  rolling back is another full build. Budget the same time again.

  IT DOES NOT ROLL BACK THE DATABASE. install.sh applied deploy/db/schema.sql
  to the live payroll database as part of this run.$(if [ -n "$DB_BACKUP_KEY" ]; then
    echo "
  The pre-cutover dump is $DB_BACKUP_KEY .
  Rehearse any restore into a scratch database first:
      bash $HERE/scripts/restore.sh $(basename "$DB_BACKUP_KEY")"
  else
    echo "
  NO pre-cutover dump was taken (SKIP_DB_BACKUP was set), so there is nothing
  to restore from. Take one now:  bash $HERE/scripts/backup.sh"
  fi)

THREE THINGS TO KNOW ABOUT WHAT JUST HAPPENED:

  • HSTS. The checks above asked the server rather than assuming; what it
    actually sent is
        /             $( [ -n "$HSTS_TS" ]   && echo "$HSTS_TS"   || echo "ABSENT — see the error above" )
        /procurement  $( [ -n "$HSTS_PROC" ] && echo "$HSTS_PROC" || echo "ABSENT — see the error above" )
    Every browser that has loaded https://$HOST will now REFUSE plain http to
    that name for a year. "includeSubDomains" extends that to everything under
    $HOST — which is why this script refuses to run on a zone apex, where
    it would mean every host in the whole domain. There is no preload entry, so
    it clears per browser (chrome://net-internals/#hsts), but you cannot fall
    back to http as a quick workaround if TLS ever breaks. Renewal needs port 80
    to stay open — do not close it.
  • Plain HTTP no longer reaches payroll$( [ -n "$LEGACY_VALUE" ] && echo " except through the http://$MY_IP/ redirect
    you explicitly kept" || echo "" ). $(case "$REVOKE_STATE" in
      ok)      echo "Every session that ever crossed it was invalidated
    by step [8b], this run." ;;
      already) echo "Every session that ever crossed it was invalidated
    by step [8b] on $PG_REVOKED_AT, by an earlier run." ;;
      failed)  echo "⚠ SESSIONS THAT CROSSED IT ARE STILL VALID — step [8b]
    did not run. Run the psql line above." ;;
      *)       echo "" ;;
    esac)
  • deploy/site.env now holds the hostname and install.sh reads it, so future
    deploys keep TLS. It is git-ignored: a 'git pull' cannot wipe it, and it
    will NOT exist on a rebuilt box or a fresh clone. That is the one way back
    into the lockout — a restored .env.production says COOKIE_SECURE=true while
    a missing site.env puts Caddy back on plain :80. Two guards now cover it:
    tonight's backup.sh uploads the file to
        s3://\${STORAGE_S3_BUCKET}/site-config/site.env
    (recover with 'aws s3 cp <that> deploy/site.env'), and install.sh refuses to
    deploy that combination rather than warning and carrying on. If you want the
    off-box copy right now instead of waiting for cron:
        bash deploy/scripts/backup.sh
EOF

# The cutover itself succeeded — TLS is live and both apps are on it — but a
# security step did not finish. Exiting 0 here would let that scroll past on a
# 1000-line run, and would tell any wrapper or cron that everything is fine.
# Distinct code so it cannot be confused with the failure paths above, all of
# which exit 1 with the site untouched or rolled back.
if [ "$REVOKE_STATE" = "failed" ] || [ "$POST_CHECK_FAILED" = "1" ]; then
  echo >&2
  hr >&2
  echo "⚠ EXIT 3 — https://$HOST is LIVE, but a post-cutover security step did not" >&2
  echo "  pass. Do not roll back for this; fix it forward:" >&2
  if [ "$REVOKE_STATE" = "failed" ]; then
    echo "    · pre-cutover sessions were NOT revoked (psql line above)" >&2
  fi
  if [ "$POST_CHECK_FAILED" = "1" ]; then
    echo "    · a header/plaintext check failed (details above)" >&2
  fi
  hr >&2
  exit 3
fi
