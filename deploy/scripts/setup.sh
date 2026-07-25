#!/usr/bin/env bash
# One-time bootstrap on a fresh Ubuntu 24.04 EC2 box (no Docker needed).
#   bash deploy/scripts/setup.sh
set -euo pipefail

echo "== Node 20 + pm2 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo npm i -g pm2 >/dev/null 2>&1 || sudo npm i -g pm2

echo "== psql client + unzip + AWS CLI v2 + Caddy =="
sudo apt-get update -y
sudo apt-get install -y postgresql-client unzip debian-keyring debian-archive-keyring apt-transport-https curl
# Ubuntu 24.04 has no 'awscli' apt package — use the official v2 installer.
if ! command -v aws >/dev/null 2>&1; then
  case "$(uname -m)" in aarch64|arm64) AZ=aarch64;; *) AZ=x86_64;; esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$AZ.zip" -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install --update
fi
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update -y && sudo apt-get install -y caddy

echo
echo "Base install done. Next:"
echo "  1) cp deploy/env.production.example .env.production  &&  edit it"
echo "  2) cd app && npm ci && npm run build"
echo "  3) deploy/scripts/migrate.sh        # create the schema in RDS"
echo "  4) pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup"
echo "  5) sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
