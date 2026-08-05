#!/usr/bin/env bash
# =============================================================================
# SSH to the app box — from your laptop or from CloudShell.
#
#   deploy/scripts/connect.sh            # interactive shell on the box
#   deploy/scripts/connect.sh deploy     # pull + install.sh ON THE BOX, then exit
#
# Overrides: REGION= NAME= KEY= SG=
#
# Finds the instance by its Name tag rather than a hard-coded id, so it keeps
# working after a redeploy. Adds THIS machine's egress IP to the security group
# first: the group pins port 22 to a single address, and CloudShell gets a
# different one every session, so without this the ssh just hangs.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # deploy
REGION="${REGION:-us-east-2}"
NAME="${NAME:-ajace-timesheet}"
MODE="${1:-shell}"

command -v aws >/dev/null || { echo "✗ aws CLI not found."; exit 1; }

IP="$(aws ec2 describe-instances --region "$REGION" \
      --filters "Name=tag:Name,Values=$NAME" Name=instance-state-name,Values=running \
      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || true)"
# describe-instances prints the STRING "None" for a missing value rather than
# failing, so an unquoted $IP would sail on and ssh to the host "None".
[ -n "$IP" ] && [ "$IP" != "None" ] || {
  echo "✗ No RUNNING instance tagged Name=$NAME in $REGION."
  echo "  A stopped box still has no public IP — start it first:"
  echo "     aws ec2 start-instances --region $REGION --instance-ids <id>"
  exit 1
}

# The key is not in the repo (and must never be committed). Look where it
# actually tends to land, so this works unchanged in CloudShell and on a laptop.
KEY="${KEY:-}"
if [ -z "$KEY" ]; then
  for c in "$HERE/../ajace-key.pem" "$HOME/ajace-key.pem" "$HOME/.ssh/ajace-key.pem" "./ajace-key.pem"; do
    [ -f "$c" ] && { KEY="$c"; break; }
  done
fi
[ -n "$KEY" ] && [ -f "$KEY" ] || {
  echo "✗ ajace-key.pem not found (looked in repo root, ~, ~/.ssh, cwd)."
  echo "  AWS cannot re-issue it. Without it, get in keylessly instead:"
  echo "     aws ssm start-session --target <instance-id> --region $REGION"
  exit 1
}
chmod 400 "$KEY" 2>/dev/null || true

SG="${SG:-$(grep '^APP_SG=' "$HERE/.aws-state" 2>/dev/null | cut -d= -f2 || true)}"
SG="${SG:-sg-0f8f26bd6a7bb95e9}"
MYIP="$(curl -s --max-time 10 ifconfig.me || true)"
if [ -n "$MYIP" ]; then
  # Already-exists is the normal case on a re-run and is NOT an error, but a
  # genuine failure (wrong group, no permission) must still be visible — so the
  # output is inspected rather than blanket-discarded with 2>/dev/null.
  ERR="$(aws ec2 authorize-security-group-ingress --region "$REGION" \
          --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" 2>&1 >/dev/null || true)"
  case "$ERR" in
    "") echo "→ opened :22 to $MYIP/32 on $SG" ;;
    *InvalidPermission.Duplicate*) ;;                       # already allowed
    *) echo "⚠ could not add the SSH rule: $ERR"; echo "  continuing — ssh may hang if $MYIP is not already allowed." ;;
  esac
else
  echo "⚠ could not determine this machine's IP; skipping the security-group rule."
fi

echo "→ $NAME at $IP (key: $KEY)"
SSH=(ssh -o StrictHostKeyChecking=accept-new -i "$KEY" "ubuntu@$IP")

if [ "$MODE" = "deploy" ]; then
  # SINGLE-QUOTED: this whole string has to reach the box as one remote command.
  # Unquoted, the shell splits on && and everything after the first word runs
  # LOCALLY — pulling the local clone and building here instead of on the box.
  "${SSH[@]}" 'set -e; cd ~/ajace-timesheet-aws && git pull && bash deploy/scripts/install.sh'
else
  exec "${SSH[@]}"
fi
