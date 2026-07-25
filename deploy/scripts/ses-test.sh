#!/usr/bin/env bash
# Confirm SES works from this box (uses the instance IAM role).
#   deploy/scripts/ses-test.sh recipient@example.com
# NOTE: while SES is in the sandbox, the recipient must be a VERIFIED identity.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HERE/../.env.production"; set +a
TO="${1:?usage: ses-test.sh <to-address>}"
FROM="${SES_FROM_EMAIL:?set SES_FROM_EMAIL in app/.env.production}"
REGION="${SES_REGION:-${STORAGE_S3_REGION:-us-east-1}}"

aws ses send-email --region "$REGION" \
  --from "$FROM" \
  --destination "ToAddresses=$TO" \
  --message 'Subject={Data=Ajace SES test,Charset=UTF-8},Body={Text={Data=If you can read this, SES sending works.,Charset=UTF-8}}'

echo "Sent from $FROM to $TO via SES ($REGION)."
echo "No email? (1) sender not verified, (2) still in sandbox + recipient not verified,"
echo "         (3) instance role missing ses:SendEmail (see deploy/iam/instance-policy.json)."
