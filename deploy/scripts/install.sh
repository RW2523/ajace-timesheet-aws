#!/usr/bin/env bash
# =============================================================================
# ONE-FILE SETUP. Run this on the EC2 box after cloning the repo. It installs
# everything, builds, creates the DB schema, and starts the app. When it
# finishes, the app is LIVE on http://<this-box-ip>.
#
#   cd ajace-timesheet-aws
#   cp deploy/env.production.example .env.production   # then edit
#   bash deploy/scripts/install.sh
#
# Idempotent — safe to re-run (e.g. after editing .env or pulling new code).
# Re-running is also the deploy path: it keeps the last good build and rolls
# back to it if the new build fails, so the app never ends up crash-looping.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"     # deploy
ROOT="$(cd "$HERE/.." && pwd)"               # repo root
APPDIR="$ROOT"
ENVF="$ROOT/.env.production"

echo "==> [1/8] swap (best-effort; a 2 GB box builds tight)"
# NOTE: swapon fails with "Invalid argument" on some ARM AWS kernels. That must
# never abort the install, and we must not leave a dead 2 GB file behind on a
# volume that has to fit node_modules + two builds.
SWAP_OK=0
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    sudo chmod 600 /swapfile && sudo mkswap -q /swapfile
  fi
  if sudo swapon /swapfile 2>/dev/null; then
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    SWAP_OK=1; echo "    2 GB swap enabled"
  else
    echo "    swapon unsupported on this kernel — reclaiming the file, will cap the build heap instead"
    sudo rm -f /swapfile
    sudo sed -i '\#^/swapfile#d' /etc/fstab
  fi
else
  SWAP_OK=1; echo "    swap already active"
fi

echo "==> [2/8] system packages (node, pm2, caddy, psql, aws cli)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || sudo npm i -g pm2
# Cap pm2's own logs: an app that crash-loops can otherwise fill the disk.
pm2 install pm2-logrotate >/dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 10M    >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 5        >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true   >/dev/null 2>&1 || true

sudo apt-get update -y
# Ubuntu 24.04 has NO 'awscli' apt package — do not add it here.
sudo apt-get install -y postgresql-client unzip debian-keyring debian-archive-keyring apt-transport-https curl
if ! command -v aws >/dev/null 2>&1; then
  case "$(uname -m)" in aarch64|arm64) AZ=aarch64;; *) AZ=x86_64;; esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$AZ.zip" -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install --update
  rm -rf /tmp/awscliv2.zip /tmp/aws
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> [3/8] environment"
# ---------------------------------------------------------------- secrets 0600
# .env.production holds the RDS password, AUTH_JWT_SECRET and the OpenRouter
# key. Every way this script produces one leaves it WORLD-READABLE:
#   · `cp template .env.production` and `mv "$ENVF.tmp" "$ENVF"` both create a
#     new file under the default umask 022, i.e. 0644;
#   · every awk rewrite below (SITE_URL, AUTH_JWT_SECRET, and procurement's
#     sync at step [5b]) goes through that .tmp + mv, so it RESETS the mode even
#     if someone chmod'ed the file by hand afterwards.
# enable-https.sh then backs the file up with `cp -p`, which faithfully
# reproduces whatever mode it finds — so one 0644 source becomes a growing pile
# of 0644 copies of the database password, one per cutover or rollback.
#
# harden_env() fixes the SOURCE, which fixes the backups too: `cp -p` of a 0600
# file makes a 0600 copy. It also repairs copies already sitting on the box, and
# prunes the pile, because "not world-readable" and "unbounded" are two
# different problems and the task is to close both.
#
# KEEP_BACKUPS: enable-https.sh's generated rollback script names ONE specific
# .pre-https.<UTC timestamp> file, so pruning must never reach a backup a recent
# cutover could still roll back through. Five is more cutovers than this box
# will ever have in flight at once; anything older is not a recovery path, it is
# a stale credential — restoring it would also restore that era's SITE_URL and
# NEXT_PUBLIC_* values. The names sort lexicographically because the timestamp
# is %Y%m%d-%H%M%S (enable-https.sh:62), so `sort -r` really is newest-first.
KEEP_BACKUPS=5
harden_env() {
  local f="$1" d b extra n
  [ -f "$f" ] || return 0
  chmod 600 "$f" 2>/dev/null || true
  d="$(dirname "$f")"; b="$(basename "$f")"
  find "$d" -maxdepth 1 -type f -name "$b.pre-https.*" -exec chmod 600 {} + 2>/dev/null || true
  extra="$(find "$d" -maxdepth 1 -type f -name "$b.pre-https.*" 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) || true)"
  if [ -n "$extra" ]; then
    n=$(printf '%s\n' "$extra" | wc -l | tr -d ' ')
    printf '%s\n' "$extra" | xargs rm -f --
    echo "    removed $n old $b.pre-https.* copies (kept the newest $KEEP_BACKUPS)"
  fi
}

if [ ! -f "$ENVF" ]; then
  cp "$HERE/env.production.example" "$ENVF"
  chmod 600 "$ENVF"
  echo "    created app/.env.production from the template — EDIT IT then re-run."
  echo "    (need: DATABASE_URL, STORAGE_S3_BUCKET, STORAGE_S3_REGION, OPENROUTER_API_KEY)"
  exit 1
fi
# A strong session secret is mandatory in production (the app refuses to start
# with the placeholder), so generate one on first run.
#
# `(umask 077; … > "$ENVF.tmp")` here and at every other rewrite below: the temp
# file holds the same secrets as the real one, and under the default umask it is
# born 0644. harden_env() cannot help — the exposure is over by the time it runs,
# and a run interrupted between the redirect and the `mv` leaves a world-readable
# .env.production.tmp behind for good.
if grep -q 'CHANGE_ME_openssl' "$ENVF"; then
  SECRET=$(openssl rand -base64 48 | tr -d '\n')
  (umask 077; awk -v s="$SECRET" '/^AUTH_JWT_SECRET=/{print "AUTH_JWT_SECRET="s; next} {print}' "$ENVF" > "$ENVF.tmp") && mv "$ENVF.tmp" "$ENVF"
  echo "    generated AUTH_JWT_SECRET"
fi
# The persisted hostname, if the box has been cut over to HTTPS. This is the
# file that stops a deploy from silently reverting the site to plain HTTP —
# step [8] renders the Caddyfile from it, and SITE_URL follows it here.
# It is git-ignored, so `git pull` cannot wipe it. See deploy/site.env.example.
SITE_HOSTNAME=""
if [ -f "$HERE/site.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HERE/site.env"
  set +a
fi

# Keep SITE_URL (used to build password-reset links) pointing at this box. The
# public IP changes on every stop/start unless an Elastic IP is attached.
IP=$(curl -s --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
if [ -n "$SITE_HOSTNAME" ]; then
  # A hostname wins over the metadata IP: a reset link pointing at http://<IP>
  # after cutover is a dead link, because Caddy no longer serves the app there.
  WANT="https://$SITE_HOSTNAME"
  # NOTE the grep -q guard: this script runs under `set -o pipefail`, so reading
  # CUR from a grep that matches nothing would abort the whole install right
  # here, silently, before anything is built.
  if grep -q '^SITE_URL=' "$ENVF"; then
    # awk '{print $1}' drops the trailing "# comment" the template ships with,
    # which is otherwise part of the value and never compares equal.
    CUR=$(grep '^SITE_URL=' "$ENVF" | cut -d= -f2- | awk '{print $1}')
    if [ "$CUR" != "$WANT" ]; then
      (umask 077; awk -v u="$WANT" '/^SITE_URL=/{print "SITE_URL="u; next} {print}' "$ENVF" > "$ENVF.tmp") && mv "$ENVF.tmp" "$ENVF"
      echo "    SITE_URL set to $WANT (from deploy/site.env)"
    fi
  else
    echo "SITE_URL=$WANT" >> "$ENVF"
    echo "    SITE_URL added as $WANT (from deploy/site.env)"
  fi
elif [ -n "$IP" ] && grep -q '^SITE_URL=' "$ENVF"; then
  CUR=$(grep '^SITE_URL=' "$ENVF" | cut -d= -f2-)
  if [ "$CUR" = "http://REPLACE_EC2_PUBLIC_IP" ] || [ "$CUR" = "http://$IP" ] || echo "$CUR" | grep -qE '^http://[0-9.]+$'; then
    (umask 077; awk -v u="http://$IP" '/^SITE_URL=/{print "SITE_URL="u; next} {print}' "$ENVF" > "$ENVF.tmp") && mv "$ENVF.tmp" "$ENVF"
    echo "    SITE_URL set to http://$IP"
  fi
fi
# After the last rewrite above (each one `mv`s a fresh 0644 file into place) and
# BEFORE the gates below, which can exit — a run that refuses to deploy should
# still leave the secrets on this box unreadable to other local accounts.
harden_env "$ENVF"
harden_env "$HERE/site.env"
set -a; . "$ENVF"; set +a
# NEXT_DIST_DIR belongs to the BUILD and to nothing else. It is set per-command
# on the two `npm run build` invocations below and must never be exported: step
# [6] runs `pm2 startOrReload --update-env`, which hands this process's whole
# environment to `next start`. If NEXT_DIST_DIR reached the server it would look
# for a .next.build that no longer exists and crash-loop out. `set -a` above
# would export it if anyone ever put it in .env.production, so drop it here.
unset NEXT_DIST_DIR
# The two settings that must never disagree. COOKIE_SECURE=true on a box with no
# TLS makes the browser refuse to send the login cookie back: nobody can sign in
# to EITHER app, including the operator.
#
# Mirror lib/aws/auth.js:19-22 EXACTLY, including the trap that an EMPTY value is
# not neutral: it falls back to NODE_ENV === "production", and .env.production
# (NODE_ENV=production) and ecosystem.config.cjs:8 both set that. So an UNSET
# COOKIE_SECURE is a lockout too, and testing only for the literal string "true"
# sails straight past it.
if [ -n "${COOKIE_SECURE:-}" ]; then
  if [ "$COOKIE_SECURE" = "true" ]; then EFFECTIVE_SECURE=1; else EFFECTIVE_SECURE=0; fi
else
  if [ "${NODE_ENV:-}" = "production" ]; then EFFECTIVE_SECURE=1; else EFFECTIVE_SECURE=0; fi
fi

# HARD GATE, not a warning. This combination has exactly one outcome — no user
# can sign in to payroll — so deploying it is never the right move. Placed before
# step [4]: no schema is applied, nothing is built, pm2 is not reloaded and the
# Caddyfile is not re-rendered, so a running site is left exactly as it was.
if [ "$EFFECTIVE_SECURE" = "1" ] && [ -z "$SITE_HOSTNAME" ] && [ "${TLS_TERMINATES_UPSTREAM:-}" != "1" ]; then
  cat >&2 <<EOF

    ✗ REFUSING TO DEPLOY — this combination locks everyone out of payroll.

      the login cookie would carry  Secure
        COOKIE_SECURE=${COOKIE_SECURE:-<unset, so it falls back to NODE_ENV=production>}
      but this box would be served over plain HTTP
        no SITE_HOSTNAME in deploy/site.env, so render-caddyfile.sh emits ':80'

      A Secure cookie is never returned over http://, so sign-in fails silently
      for EVERY user, including you. Nothing has been changed.

      deploy/site.env is git-ignored and is the ONLY record that this box serves
      a hostname. That makes this the state you land in after a box rebuild, a
      fresh clone or 'git clean -xdf': restoring .env.production from your own
      copy brings COOKIE_SECURE=true back WITHOUT bringing the hostname back.

    Pick whichever is true, then re-run this script:

      1. This box has a hostname and belongs on HTTPS — restore the hostname.
         backup.sh uploads it nightly:
           aws s3 cp s3://${STORAGE_S3_BUCKET:-<your-bucket>}/site-config/site.env deploy/site.env
         If there is no copy, redo the cutover from scratch:
           bash deploy/scripts/enable-https.sh <hostname> [acme-email]

      2. This box really is plain HTTP on the raw EC2 IP — say so explicitly in
         BOTH .env.production files (blank is NOT the same as false):
           COOKIE_SECURE=false

      3. TLS terminates in FRONT of this box (ALB, Cloudflare proxy), so the
         browser genuinely speaks HTTPS — record that where it survives a
         deploy, rather than passing it once:
           echo 'TLS_TERMINATES_UPSTREAM=1' >> deploy/site.env

EOF
  exit 1
fi
if [ "$EFFECTIVE_SECURE" = "1" ] && [ -z "$SITE_HOSTNAME" ]; then
  echo "    TLS_TERMINATES_UPSTREAM=1 — trusting that something in front of this"
  echo "      box terminates TLS. Caddy here still serves plain :80."
fi
# The MIRROR IMAGE of the gate above, and fatal for the opposite reason.
#
# Note this tests the LITERAL string, not EFFECTIVE_SECURE. COOKIE_SECURE has
# two consumers and they do not agree on what "unset" means:
#   · lib/aws/auth.js:20-22 falls back to NODE_ENV === "production", so an unset
#     value still produces a Secure cookie;
#   · next.config.js:34 and procurement/next.config.ts:81 compare it to the
#     string "true" AT BUILD TIME, so an unset value silently drops HSTS from
#     both bundles and COOP from procurement's.
# Testing EFFECTIVE_SECURE here would sail straight past that second case — the
# box would look correct, log nothing, and ship without HSTS.
#
# Refusing is free. A Secure cookie is returned normally over https://, so this
# gate can never lock anyone out; the cost of stopping is one edit and a re-run.
# Deploying it, by contrast, strips three controls at once, in the middle of a
# multi-minute run that ends with a green "✅ Timesheet is LIVE" banner — the two
# warning lines that used to live here were the only trace.
if [ -n "$SITE_HOSTNAME" ] && [ "${COOKIE_SECURE:-}" != "true" ]; then
  cat >&2 <<EOF

    ✗ REFUSING TO DEPLOY — this box serves HTTPS but is configured as if it did not.

      deploy/site.env says this box is served at
        https://$SITE_HOSTNAME
      but .env.production says
        COOKIE_SECURE=${COOKIE_SECURE:-<unset>}

      Deploying that would, silently:

        1. drop Strict-Transport-Security from BOTH apps and
           Cross-Origin-Opener-Policy from procurement. Both are decided at
           BUILD time from this exact string, so they vanish from the bundles
           and no runtime setting can put them back without another build.
EOF
  if [ -n "${COOKIE_SECURE:-}" ]; then
    cat >&2 <<EOF

        2. re-issue the payroll session cookie WITHOUT the Secure flag, so the
           browser will also send it over plain http. That matters on this box
           specifically: LEGACY_HTTP_HOST in deploy/site.env keeps
           http://<old-IP>/ answering, and the cookie is attached to that
           cleartext request BEFORE Caddy's redirect can upgrade it.
EOF
  else
    cat >&2 <<EOF

        (The cookie itself would still be Secure — lib/aws/auth.js falls back to
        NODE_ENV=production when COOKIE_SECURE is unset. That fallback is
        exactly why an unset value is so easy to miss: sign-in keeps working
        while the headers quietly disappear.)
EOF
  fi
  cat >&2 <<EOF

      Nothing has been changed. Pick whichever is true, then re-run:

      1. This box belongs on HTTPS (it does — Caddy is serving that hostname).
         Set the literal string in BOTH .env.production files:
           COOKIE_SECURE=true
         The one that decides it is
           $ENVF
         — step [5b] syncs procurement's file to whatever that one says.

      2. This box should NOT be on HTTPS. Then the hostname has to go too, or
         Caddy will keep serving https-only for it:
           blank SITE_HOSTNAME in deploy/site.env, set COOKIE_SECURE=false in
           both .env.production files, then re-run.
         Read deploy/docs/HTTPS-CUTOVER.md first: if this site has already sent
         HSTS, browsers that have seen it will REFUSE plain http for up to a
         year, and there is no server-side undo.

EOF
  exit 1
fi
: "${DATABASE_URL:?set DATABASE_URL in app/.env.production}"
: "${STORAGE_S3_BUCKET:?set STORAGE_S3_BUCKET in app/.env.production}"
if [ -z "${OPENROUTER_API_KEY:-}" ] || [ "${OPENROUTER_API_KEY}" = "sk-or-REPLACE" ]; then
  echo "    ⚠ OPENROUTER_API_KEY not set — the app runs, but Direct++ extraction won't work."
fi

echo "==> [4/8] database schema (RDS)"
# These files are applied to the LIVE payroll database on EVERY deploy, and they
# are not all cheap on re-run: db/schema.sql:135-136, 157-158 and 207-224 are
# drop-then-add CONSTRAINT pairs (Postgres has no `add constraint if not
# exists`, so the ADD re-validates every row), and 126-127 / 181-182 are
# drop-then-create TRIGGER pairs. Each takes ACCESS EXCLUSIVE on a payroll
# table, and a request for that lock queues AHEAD of every read and write that
# arrives after it — so DDL waiting behind one open transaction stalls BOTH apps
# for as long as that transaction lasts.
#
# lock_timeout makes the deploy fail fast and change nothing instead, which is
# the outcome you want: re-run when nobody is submitting. This is the same rule
# procurement/deploy/db/schema.sql already documents for its own migrations.
# Raise it (DB_LOCK_TIMEOUT=30s) only for a first-time ALTER on an idle database.
apply_schema() {
  local label="$1" file="$2"
  if PGOPTIONS="-c lock_timeout=${DB_LOCK_TIMEOUT:-5s}" \
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file"; then
    echo "    $label schema applied"
    return 0
  fi
  # Do NOT assert a cause here. This block used to state flatly that the failure
  # was a lock timeout and that nothing had changed; on the live box the real
  # error was "cannot change return type of existing function", and the operator
  # was told to wait for staff to stop submitting timesheets — advice that would
  # never have fixed it. Read psql's own message above; it is the truth.
  echo "    ✗ applying the $label schema FAILED — read psql's error above." >&2
  echo "      Every statement ran inside ON_ERROR_STOP, so the schema stopped at" >&2
  echo "      the first failure and anything below it (including the migration" >&2
  echo "      chain) did NOT run." >&2
  echo "      · 'canceling statement due to lock timeout' → something held a lock" >&2
  echo "        on a table the DDL needed. Nothing changed; re-run when staff are" >&2
  echo "        not submitting timesheets." >&2
  echo "      · anything else → a real schema defect. Re-running will fail the" >&2
  echo "        same way until it is fixed in the repo." >&2
  return 1
}
apply_schema timesheet "$HERE/db/schema.sql"

echo "==> [5/8] build the app"
FREE_MB=$(df -Pm "$APPDIR" | awk 'NR==2{print $4}')
if [ "$FREE_MB" -lt 4000 ]; then
  echo "    ✗ only ${FREE_MB}MB free — a Next build needs ~4GB of headroom."
  echo "      Free space with:  npm cache clean --force"
  echo "      or grow the volume, then re-run."
  echo "      A stale .next.build from an interrupted run is safe to delete."
  echo "      Do NOT delete .next — that is the build the live app is serving."
  exit 1
fi
# Without swap, cap V8 so the build can't OOM the 2 GB box.
[ "$SWAP_OK" = "1" ] || export NODE_OPTIONS="--max-old-space-size=1536"
# Webpack's on-disk cache is what hit ENOSPC before; it buys nothing on a
# one-shot production build.
export NEXT_TELEMETRY_DISABLED=1

# ------------------------------------------------ build beside, then swap in
# THE RULE: never build into the directory the live server is reading.
#
# `next start` is not self-contained once it has booted. It resolves static
# assets and not-yet-required server bundles from distDir BY PATH, per request
# (next/dist/server/require.js requirePage(); router-utils/filesystem.js serves
# /_next/static out of <distDir>/static), and it re-reads BUILD_ID from distDir
# when it starts. The old flow moved .next aside and rebuilt in place, which meant:
#
#   1. For the WHOLE build — minutes, twice, on a 2 GB box — the live payroll
#      process pointed at a .next that did not exist. Every chunk 404s and every
#      route the process had not already required 500s.
#   2. Any restart during that window died on "Could not find a production build
#      in the '.next' directory". min_uptime 10000 / max_restarts 10 in
#      ecosystem.config.cjs means pm2 gives up in about a minute and leaves the
#      app STOPPED — payroll hard down, needing a hand on the box. The triggers
#      are all routine: monitor.sh's cron restart, max_memory_restart, the OOM
#      killer on a 2 GB box running two Next servers plus a Next build, a reboot.
#   3. Even after a good build, the process still served the OLD BUILD_ID until
#      pm2 reloaded — and that reload came only after the procurement build, so
#      the browser asked for /_next/static/<old BUILD_ID>/*.js that no longer
#      existed. /api/health kept returning 200 throughout, so monitor.sh said
#      "ok" while the UI was blank.
#
# So build into .next.build instead (next.config.js and next.config.ts both read
# NEXT_DIST_DIR), then swap it in with two renames and reload immediately. The
# live .next is complete and untouched at every instant, so a failed — or
# interrupted — build costs nothing and needs no rollback: nothing was moved.
# That is also why there is no longer an EXIT trap here to "finish" a half-done
# swap; there is no window left for an early exit to land in.

# build_app <appdir> <label> — build into <appdir>/.next.build. Leaves the live
# .next alone whatever happens.
build_app() {
  local dir="$1" label="$2"
  # A leftover from an interrupted run is a partial build, never a usable one.
  rm -rf "$dir/.next.build"
  # NEXT_DIST_DIR is set PER COMMAND and never exported: step [6/8] runs
  # `pm2 startOrReload --update-env`, which hands this shell's environment to
  # `next start`. If it leaked, the server would look for .next.build — which no
  # longer exists after the swap — and crash-loop out exactly as above.
  if ( cd "$dir" && NEXT_DIST_DIR=.next.build npm run build ); then
    if [ ! -f "$dir/.next.build/BUILD_ID" ]; then
      echo "    ✗ $label: build exited 0 but produced no BUILD_ID — refusing to swap it in."
      rm -rf "$dir/.next.build"
      return 1
    fi
    echo "    $label built"
    return 0
  fi
  echo "    ✗ $label build failed — the live build was never touched, so the app"
  echo "      keeps serving exactly what it was serving before. Nothing to roll back."
  rm -rf "$dir/.next.build"
  return 1
}

# swap_build <appdir> <pm2-name> <probe-url> <label> — make the new build live.
# Two renames (atomic within the volume) and then an immediate reload, so the
# only moment the process is stale is the reload itself.
swap_build() {
  local dir="$1" app="$2" probe="$3" label="$4"
  rm -rf "$dir/.next.prev"
  if [ -d "$dir/.next" ]; then mv "$dir/.next" "$dir/.next.prev"; fi
  mv "$dir/.next.build" "$dir/.next"

  # First install: pm2 has never heard of this app. Step [6/8] starts it.
  if ! pm2 describe "$app" >/dev/null 2>&1; then
    rm -rf "$dir/.next.prev"
    echo "    $label: new build in place (pm2 starts it at step [6/8])"
    return 0
  fi
  pm2 restart "$app" --update-env >/dev/null 2>&1 || true

  # Verify the new build actually boots, rather than assuming a compile means a
  # working server. Only "nothing is listening" (curl 000) counts as a failed
  # build: a 5xx means the server IS up and something else — nearly always the
  # database — is unhappy, and reverting the bundle would not fix that.
  local deadline code
  deadline=$(( $(date +%s) + 90 ))
  code=000
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$probe" 2>/dev/null || echo 000)
    case "$code" in 200|307|308) break ;; esac
    sleep 3
  done
  case "$code" in
    200|307|308)
      rm -rf "$dir/.next.prev"
      echo "    $label: live on the new build (HTTP $code)"
      return 0 ;;
    000)
      echo "    ✗ $label never started on the new build (nothing listening on $probe)."
      if [ -d "$dir/.next.prev" ]; then
        rm -rf "$dir/.next"
        mv "$dir/.next.prev" "$dir/.next"
        pm2 restart "$app" --update-env >/dev/null 2>&1 || true
        echo "      Reverted to the previous build. NOTE: it has the OLD baked-in URLs."
      else
        echo "      There is no previous build to revert to (first install?)."
        echo "      Deliberately not looping pm2 on it: check  pm2 logs $app --lines 50 --nostream"
      fi
      return 1 ;;
    *)
      # Keep the new build: the server is answering, so it is not the bundle.
      rm -rf "$dir/.next.prev"
      echo "    ⚠ $label is up but $probe answered HTTP $code."
      echo "      NOT reverting — the process is serving, so this is not the build."
      echo "      Check:  pm2 logs $app --lines 50 --nostream"
      return 0 ;;
  esac
}

( cd "$APPDIR" && npm ci --include=dev --no-audit --no-fund ) \
  || ( cd "$APPDIR" && npm install --include=dev --no-audit --no-fund )
build_app "$APPDIR" timesheet || exit 1
swap_build "$APPDIR" ajace-timesheet "http://127.0.0.1:3009/api/health" timesheet || exit 1

# ---------------------------------------------------------------- procurement
# The second app is optional: if the repo is cloned beside this one, bring it up
# too. Same database (shared logins), same S3 bucket, its own port + prefix.
PROC="$(cd "$ROOT/.." && pwd)/procurement-intelligence-platform"
if [ -d "$PROC" ]; then
  echo "==> [5b/8] procurement app"
  if [ ! -f "$PROC/.env.production" ]; then
    cp "$PROC/deploy/env.production.example" "$PROC/.env.production" 2>/dev/null || true
    chmod 600 "$PROC/.env.production" 2>/dev/null || true
    echo "    created procurement/.env.production — EDIT IT then re-run."
    echo "    AUTH_JWT_SECRET must MATCH this app's, or its login won't work."
    exit 1
  fi
  # The shared session only works if both apps sign with the same secret.
  TS_SECRET=$(grep '^AUTH_JWT_SECRET=' "$ENVF" | cut -d= -f2-)
  PR_SECRET=$(grep '^AUTH_JWT_SECRET=' "$PROC/.env.production" | cut -d= -f2-)
  if [ "$TS_SECRET" != "$PR_SECRET" ]; then
    echo "    ⚠ AUTH_JWT_SECRET differs between the two apps — syncing procurement to match."
    (umask 077; awk -v s="$TS_SECRET" '/^AUTH_JWT_SECRET=/{print "AUTH_JWT_SECRET="s; next} {print}' \
      "$PROC/.env.production" > "$PROC/.env.production.tmp") && mv "$PROC/.env.production.tmp" "$PROC/.env.production"
  fi

  # ------------------------------------------- ONE origin, ONE cookie policy
  # WHICH FILE ACTUALLY DECIDES PROCUREMENT'S CONFIG — read this before "fixing"
  # anything in procurement/.env.production.
  #
  # Step [3] does `set -a; . "$ENVF"; set +a`, which EXPORTS every key in the
  # TIMESHEET's .env.production. That environment is inherited by procurement's
  # build (build_app runs `npm run build` in a subshell of this one) and by
  # `pm2 startOrReload --update-env` at step [6]. Next never lets a .env file
  # overwrite a key that is already in the environment — verified in the
  # installed dependency, procurement/node_modules/@next/env/dist/index.js:
  #
  #     for (const t of Object.keys(e.parsed||{}))
  #       if (typeof u[t] === "undefined" && typeof l[t] === "undefined") u[t] = ...
  #
  # where `l` is a snapshot of the original process.env. A key already present
  # is SKIPPED. So for every key the two files share, the timesheet's value is
  # what procurement is built and run with, and procurement's own file is inert.
  #
  # For COOKIE_SECURE that precedence is CORRECT and deliberate, not a leak to
  # be plugged: the two apps are one origin behind Caddy and share ONE session
  # cookie, which the timesheet issues (lib/aws/auth.js). "Is this origin
  # HTTPS?" has exactly one true answer, and the app that sets the cookie owns
  # it. Two different answers is not a configuration, it is a bug — and it would
  # be a silent one, because procurement's HSTS/COOP block reads COOKIE_SECURE
  # at BUILD time (next.config.ts:81).
  #
  # What was wrong was that the winner was invisible. enable-https.sh writes
  # COOKIE_SECURE into procurement's file "explicitly, not relying on the leak"
  # — that write has no effect on its own. So: keep the timesheet authoritative,
  # but make the file on disk MATCH what is in effect, and say so out loud. Same
  # treatment AUTH_JWT_SECRET gets above.
  sync_key() {  # sync_key <file> <KEY> <value> — replace the line, or append it
    local f="$1" k="$2" v="$3"
    if grep -q "^$k=" "$f"; then
      (umask 077; awk -F= -v k="$k" -v v="$v" '$1==k{print k"="v; next} {print}' "$f" > "$f.tmp") \
        && mv "$f.tmp" "$f"
    else
      printf '%s=%s\n' "$k" "$v" >> "$f"
    fi
  }
  TS_HAS_SECURE=0
  if grep -q '^COOKIE_SECURE=' "$ENVF"; then TS_HAS_SECURE=1; fi
  TS_SECURE=$(grep '^COOKIE_SECURE=' "$ENVF" | tail -1 | cut -d= -f2- | awk '{print $1}' || true)
  PR_SECURE=$(grep '^COOKIE_SECURE=' "$PROC/.env.production" | tail -1 | cut -d= -f2- | awk '{print $1}' || true)
  if [ "$TS_HAS_SECURE" = "1" ] && [ "$PR_SECURE" != "$TS_SECURE" ]; then
    echo "    ⚠ COOKIE_SECURE disagrees: procurement says '${PR_SECURE:-<empty>}', the"
    echo "      timesheet says '${TS_SECURE:-<empty>}'. The timesheet's value is the one"
    echo "      procurement is actually built and started with, so procurement's file is"
    echo "      being rewritten to match it — the file now shows what is in effect."
    echo "      To CHANGE it, edit $ENVF (both apps follow it)."
    sync_key "$PROC/.env.production" COOKIE_SECURE "$TS_SECURE"
  fi
  # Same trap, every other shared key. Names only — the values are the database
  # password and the OpenRouter key, and this output goes to a log.
  # FILENAME == ARGV[1], not the usual NR == FNR: an empty first file would make
  # NR == FNR true while reading the SECOND one, and the whole check would
  # silently compare that file against itself and report nothing.
  DIVERGENT="$(awk -F= '
      /^[A-Za-z_][A-Za-z0-9_]*=/ {
        k = $1; v = substr($0, index($0, "=") + 1)
        # already reconciled above, and their raw lines can differ by a trailing
        # comment alone, which would make this report bogus
        if (k == "COOKIE_SECURE" || k == "AUTH_JWT_SECRET") next
        if (FILENAME == ARGV[1]) { a[k] = v; next }
        if (k in a && a[k] != v) print k
      }' "$ENVF" "$PROC/.env.production" | sort -u | tr '\n' ' ' || true)"
  DIVERGENT="${DIVERGENT% }"
  if [ -n "$DIVERGENT" ]; then
    echo "    ⚠ set in BOTH .env.production files with DIFFERENT values:"
    echo "        $DIVERGENT"
    echo "      procurement builds and runs with the TIMESHEET's value for each of these."
    echo "      Editing procurement's copy alone changes nothing while install.sh is the"
    echo "      deploy path; edit $ENVF instead."
  fi
  harden_env "$PROC/.env.production"
  # NOTE --include=dev: install.sh sources .env.production, which sets
  # NODE_ENV=production, and npm then SKIPS devDependencies. Build-time tooling
  # (Tailwind's PostCSS plugin, TypeScript) lives there, so the build fails
  # without it. Runtime is unaffected — this only matters while building.
  ( cd "$PROC" && npm ci --include=dev --no-audit --no-fund \
      || (cd "$PROC" && npm install --include=dev --no-audit --no-fund) )
  # Procurement's tables live in the SAME database as the timesheet's — so its
  # migrations can block payroll queries too. Same bounded-lock rule.
  apply_schema procurement "$PROC/deploy/db/schema.sql"
  # Same build-beside-then-swap treatment as the timesheet. This build matters
  # more than it looks: NEXT_PUBLIC_LOGIN_URL / NEXT_PUBLIC_LOGOUT_URL are baked
  # in here, so an HTTPS cutover CANNOT skip it.
  #
  # Note the ordering that this buys: the timesheet is already swapped AND
  # reloaded before procurement is touched at all. Previously a procurement
  # failure here exited the script before the single pm2 reload at step [6/8],
  # leaving payroll's OLD process running against payroll's NEW .next — broken
  # chunks, /api/health still green — with nothing to put it right.
  PFREE_MB=$(df -Pm "$PROC" | awk 'NR==2{print $4}')
  if [ "$PFREE_MB" -lt 2500 ]; then
    echo "    ✗ only ${PFREE_MB}MB free — not starting the procurement build."
    echo "      Free space with:  npm cache clean --force"
    echo "      A stale $PROC/.next.build from an interrupted run is also safe to"
    echo "      delete; $PROC/.next is the LIVE build, so leave that alone."
    exit 1
  fi
  build_app "$PROC" procurement || exit 1
  swap_build "$PROC" ajace-procurement "http://127.0.0.1:3002/procurement/login" procurement || exit 1
fi

echo "==> [6/8] start under pm2 (+ boot on reboot)"
# Both apps are already reloaded onto their new builds by swap_build. This call
# is what STARTS them on a first install, and what applies any ecosystem.config
# or .env.production change on a re-run; it is a no-op restart otherwise.
# NEXT_DIST_DIR was unset back at step [3] precisely because --update-env hands
# this shell's environment to `next start`.
pm2 startOrReload "$HERE/ecosystem.config.cjs" --update-env
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

# Record WHICH COMMITS are now built and running. This is the only thing on the
# box that answers "what code was live before this deploy?", and
# enable-https.sh's rollback script reads it to put the checkout back.
#
# Without it a "rollback" is not one: the runbook has the operator `git pull`
# immediately before the cutover, install.sh rebuilds from that pulled checkout,
# and a rollback that restores only .env.production + the Caddyfile would then
# re-run install.sh on the SAME pulled code — redeploying whatever the pull
# brought, on top of restored config.
#
# Written only after both builds succeeded and pm2 is running them, so it always
# names code that actually booted. Machine state, not source — git-ignored.
{
  echo "# Written by deploy/scripts/install.sh — the commits this box last BUILT"
  echo "# and started. Read by deploy/scripts/enable-https.sh. Do not edit."
  printf 'TS_COMMIT=%s\n'   "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  printf 'PROC_COMMIT=%s\n' "$([ -d "$PROC" ] && git -C "$PROC" rev-parse HEAD 2>/dev/null || true)"
} > "$HERE/.deployed-commits"

echo "==> [7/8] scheduled jobs (backup + health watchdog)"
# These were documented but nothing ever installed them, so there were no
# backups and nothing would have told you the app was down.
CRON_TMP=$(mktemp)
crontab -l 2>/dev/null | grep -vE "ajace-timesheet-aws/deploy/scripts/(backup|monitor)\.sh" > "$CRON_TMP" || true
echo "17 3 * * * $HERE/scripts/backup.sh >> /var/log/ts-backup.log 2>&1" >> "$CRON_TMP"
echo "*/5 * * * * $HERE/scripts/monitor.sh >/dev/null 2>&1" >> "$CRON_TMP"
crontab "$CRON_TMP" && rm -f "$CRON_TMP"
sudo touch /var/log/ts-backup.log && sudo chown "$USER" /var/log/ts-backup.log 2>/dev/null || true
echo "    nightly backup 03:17 UTC · health check every 5 min"

echo "==> [8/8] reverse proxy (Caddy)"
# NOT a blind `cp deploy/Caddyfile`. That is what used to throw away the HTTPS
# hostname on every deploy: the operator edits /etc/caddy/Caddyfile, it works,
# and then the next deploy silently puts the box back on plain :80 with no TLS.
# render-caddyfile.sh regenerates the config from deploy/site.env instead, so
# the hostname is a persisted setting the deploy READS rather than overwrites.
bash "$HERE/scripts/render-caddyfile.sh"

# health check rather than an optimistic "it's live"
sleep 3
if [ -n "$SITE_HOSTNAME" ]; then BASE="https://$SITE_HOSTNAME"; else BASE="http://${IP:-<this-box-ip>}"; fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3009/api/health || echo 000)
echo
if [ "$CODE" = "200" ]; then
  echo "✅ Timesheet is LIVE at:   $BASE"
  if [ -d "$PROC" ]; then
    PCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3002/procurement/login || echo 000)
    if [ "$PCODE" = "200" ] || [ "$PCODE" = "307" ]; then
      echo "✅ Procurement is LIVE at: $BASE/procurement"
    else
      echo "⚠ Procurement did not answer on :3002 (HTTP $PCODE) — pm2 logs ajace-procurement"
    fi
  fi
else
  echo "⚠ App did not answer on :3009 (HTTP $CODE). Check:  pm2 logs ajace-timesheet --lines 40 --nostream"
fi
echo "   • make yourself admin:  deploy/scripts/make-admin.sh you@ajace.com"
echo "   • control the app:      deploy/scripts/app.sh {start|stop|restart|status|logs}"
