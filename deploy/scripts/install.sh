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
if [ ! -f "$ENVF" ]; then
  cp "$HERE/env.production.example" "$ENVF"
  echo "    created app/.env.production from the template — EDIT IT then re-run."
  echo "    (need: DATABASE_URL, STORAGE_S3_BUCKET, STORAGE_S3_REGION, OPENROUTER_API_KEY)"
  exit 1
fi
# A strong session secret is mandatory in production (the app refuses to start
# with the placeholder), so generate one on first run.
if grep -q 'CHANGE_ME_openssl' "$ENVF"; then
  SECRET=$(openssl rand -base64 48 | tr -d '\n')
  awk -v s="$SECRET" '/^AUTH_JWT_SECRET=/{print "AUTH_JWT_SECRET="s; next} {print}' "$ENVF" > "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"
  echo "    generated AUTH_JWT_SECRET"
fi
# Keep SITE_URL (used to build password-reset links) pointing at this box. The
# public IP changes on every stop/start unless an Elastic IP is attached.
IP=$(curl -s --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
if [ -n "$IP" ] && grep -q '^SITE_URL=' "$ENVF"; then
  CUR=$(grep '^SITE_URL=' "$ENVF" | cut -d= -f2-)
  if [ "$CUR" = "http://REPLACE_EC2_PUBLIC_IP" ] || [ "$CUR" = "http://$IP" ] || echo "$CUR" | grep -qE '^http://[0-9.]+$'; then
    awk -v u="http://$IP" '/^SITE_URL=/{print "SITE_URL="u; next} {print}' "$ENVF" > "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"
    echo "    SITE_URL set to http://$IP"
  fi
fi
set -a; . "$ENVF"; set +a
: "${DATABASE_URL:?set DATABASE_URL in app/.env.production}"
: "${STORAGE_S3_BUCKET:?set STORAGE_S3_BUCKET in app/.env.production}"
if [ -z "${OPENROUTER_API_KEY:-}" ] || [ "${OPENROUTER_API_KEY}" = "sk-or-REPLACE" ]; then
  echo "    ⚠ OPENROUTER_API_KEY not set — the app runs, but Direct++ extraction won't work."
fi

echo "==> [4/8] database schema (RDS)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$HERE/db/schema.sql"
echo "    schema applied"

echo "==> [5/8] build the app"
FREE_MB=$(df -Pm "$APPDIR" | awk 'NR==2{print $4}')
if [ "$FREE_MB" -lt 4000 ]; then
  echo "    ✗ only ${FREE_MB}MB free — a Next build needs ~4GB of headroom."
  echo "      Free space (npm cache clean --force; rm -rf app/.next.prev) or grow the volume, then re-run."
  exit 1
fi
# Without swap, cap V8 so the build can't OOM the 2 GB box.
[ "$SWAP_OK" = "1" ] || export NODE_OPTIONS="--max-old-space-size=1536"
# Webpack's on-disk cache is what hit ENOSPC before; it buys nothing on a
# one-shot production build.
export NEXT_TELEMETRY_DISABLED=1

cd "$APPDIR"
npm ci --include=dev --no-audit --no-fund || npm install --include=dev --no-audit --no-fund
rm -rf "$APPDIR/.next.prev"
# Keep the last good build so a failed build can never leave pm2 with no .next
# (that is what produced the "Could not find a production build" crash loop).
if [ -f "$APPDIR/.next/BUILD_ID" ]; then mv "$APPDIR/.next" "$APPDIR/.next.prev"; fi
if npm run build; then
  rm -rf "$APPDIR/.next.prev"
  echo "    build ok"
else
  echo "    ✗ build failed — rolling back to the previous build"
  rm -rf "$APPDIR/.next"
  [ -d "$APPDIR/.next.prev" ] && mv "$APPDIR/.next.prev" "$APPDIR/.next"
  cd "$ROOT"
  pm2 restart ajace-timesheet >/dev/null 2>&1 || true
  exit 1
fi
cd "$ROOT"

# ---------------------------------------------------------------- procurement
# The second app is optional: if the repo is cloned beside this one, bring it up
# too. Same database (shared logins), same S3 bucket, its own port + prefix.
PROC="$(cd "$ROOT/.." && pwd)/procurement-intelligence-platform"
if [ -d "$PROC" ]; then
  echo "==> [5b/8] procurement app"
  if [ ! -f "$PROC/.env.production" ]; then
    cp "$PROC/deploy/env.production.example" "$PROC/.env.production" 2>/dev/null || true
    echo "    created procurement/.env.production — EDIT IT then re-run."
    echo "    AUTH_JWT_SECRET must MATCH this app's, or its login won't work."
    exit 1
  fi
  # The shared session only works if both apps sign with the same secret.
  TS_SECRET=$(grep '^AUTH_JWT_SECRET=' "$ENVF" | cut -d= -f2-)
  PR_SECRET=$(grep '^AUTH_JWT_SECRET=' "$PROC/.env.production" | cut -d= -f2-)
  if [ "$TS_SECRET" != "$PR_SECRET" ]; then
    echo "    ⚠ AUTH_JWT_SECRET differs between the two apps — syncing procurement to match."
    awk -v s="$TS_SECRET" '/^AUTH_JWT_SECRET=/{print "AUTH_JWT_SECRET="s; next} {print}' \
      "$PROC/.env.production" > "$PROC/.env.production.tmp" && mv "$PROC/.env.production.tmp" "$PROC/.env.production"
  fi
  # NOTE --include=dev: install.sh sources .env.production, which sets
  # NODE_ENV=production, and npm then SKIPS devDependencies. Build-time tooling
  # (Tailwind's PostCSS plugin, TypeScript) lives there, so the build fails
  # without it. Runtime is unaffected — this only matters while building.
  ( cd "$PROC" && npm ci --include=dev --no-audit --no-fund \
      || (cd "$PROC" && npm install --include=dev --no-audit --no-fund) )
  # Procurement's tables live in the SAME database as the timesheet's.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$PROC/deploy/db/schema.sql"
  ( cd "$PROC" && NEXT_TELEMETRY_DISABLED=1 npm run build )
  echo "    procurement built"
fi

echo "==> [6/8] start under pm2 (+ boot on reboot)"
pm2 startOrReload "$HERE/ecosystem.config.cjs" --update-env
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

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

echo "==> [8/8] reverse proxy (Caddy, port 80)"
sudo cp "$HERE/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

# health check rather than an optimistic "it's live"
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3009/api/health || echo 000)
echo
if [ "$CODE" = "200" ]; then
  echo "✅ Timesheet is LIVE at:   http://${IP:-<this-box-ip>}"
  if [ -d "$PROC" ]; then
    PCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3002/procurement/login || echo 000)
    if [ "$PCODE" = "200" ] || [ "$PCODE" = "307" ]; then
      echo "✅ Procurement is LIVE at: http://${IP:-<this-box-ip>}/procurement"
    else
      echo "⚠ Procurement did not answer on :3002 (HTTP $PCODE) — pm2 logs ajace-procurement"
    fi
  fi
else
  echo "⚠ App did not answer on :3009 (HTTP $CODE). Check:  pm2 logs ajace-timesheet --lines 40 --nostream"
fi
echo "   • make yourself admin:  deploy/scripts/make-admin.sh you@ajace.com"
echo "   • control the app:      deploy/scripts/app.sh {start|stop|restart|status|logs}"
