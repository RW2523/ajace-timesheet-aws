#!/usr/bin/env bash
# Give the box a PERMANENT public IP (Elastic IP) and enable emergency access.
# Run from your laptop or CloudShell against an EXISTING deployment.
#
#   bash deploy/scripts/stable-ip.sh
#
# Why: the instance uses an auto-assigned public IPv4, which is RELEASED every
# time you stop it. Since the cost advice is "stop the box when idle", the app's
# URL changes exactly when you follow that advice — breaking bookmarks, SITE_URL
# and every password-reset link already sent.
#
# Cost note: an Elastic IP attached to a RUNNING instance costs the same as the
# auto-assigned one you already pay for (~$3.60/mo). While the instance is
# STOPPED it keeps billing (~$3.60/mo) — that is the price of a stable address.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HERE/.aws-state"
[ -f "$STATE" ] || { echo "No $STATE — run aws-cli-deploy.sh first."; exit 1; }
get() { grep "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
REGION="$(get REGION)"; IID="$(get IID)"; ROLE="$(get ROLE)"
: "${IID:?no instance id in state file}"
A() { aws --region "$REGION" "$@"; }

echo "==> [1/3] Elastic IP"
EIP_ALLOC="$(get EIP_ALLOC)"
if [ -z "$EIP_ALLOC" ]; then
  EIP_ALLOC=$(A ec2 allocate-address --domain vpc --query AllocationId --output text)
  echo "EIP_ALLOC=$EIP_ALLOC" >> "$STATE"
fi
A ec2 associate-address --instance-id "$IID" --allocation-id "$EIP_ALLOC" >/dev/null
EIP=$(A ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "    permanent IP: $EIP"

echo "==> [2/3] emergency access (SSM Session Manager)"
# Without this the ONLY way in is SSH from the single IP captured at provision
# time. If your IP changes while the app is down, you are locked out of your own
# box. SSM gives a browser/CLI shell with no inbound port and no IP pinning.
if [ -n "$ROLE" ]; then
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 \
    && echo "    SSM policy attached to $ROLE" \
    || echo "    (SSM policy already attached)"
  echo "    the agent is preinstalled on Ubuntu 24.04; it may take ~5 min to register"
else
  echo "    ⚠ no IAM role in the state file — attach AmazonSSMManagedInstanceCore by hand"
fi

echo "==> [3/3] re-open SSH for your CURRENT address"
SG="$(get APP_SG)"
MYIP=$(curl -s --max-time 5 ifconfig.me || echo "")
if [ -n "$SG" ] && [ -n "$MYIP" ]; then
  A ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 \
    --cidr "$MYIP/32" >/dev/null 2>&1 && echo "    SSH opened for $MYIP" \
    || echo "    SSH already open for $MYIP"
fi

cat <<EOF

════════════════════════════════════════════════════════════════════
✅ Stable address: http://$EIP   (survives stop/start)

Finish on the box:
  ssh -i ajace-key.pem ubuntu@$EIP
  cd ~/ajace-timesheet-aws
  bash deploy/scripts/install.sh

  install.sh sets SITE_URL itself. If deploy/site.env has a SITE_HOSTNAME (i.e.
  this box is already on HTTPS) it keeps https://<hostname>; only on a plain-HTTP
  box does it fall back to http://$EIP. Do NOT sed SITE_URL back to an IP by hand
  afterwards — that emails users dead password-reset links.

Next step, if this box should be on a real domain over HTTPS:
  point a DNS A record at $EIP (Cloudflare proxy OFF), then on the box:
  bash deploy/scripts/enable-https.sh <hostname> <your-email>
  Runbook: deploy/docs/HTTPS-CUTOVER.md

Emergency access without SSH (works even if your IP changed):
  aws ssm start-session --target $IID --region $REGION
════════════════════════════════════════════════════════════════════
EOF
