#!/usr/bin/env bash
# DELETE EVERYTHING for this deployment. Run from your LAPTOP (needs admin AWS
# creds — the EC2 box's role can't delete infrastructure).
#   deploy/scripts/teardown.sh
# Overrides: STACK=, REGION=, KEY=
set -euo pipefail
STACK="${STACK:-ajace-timesheet}"
# Default to the caller's configured region rather than a hard-coded one — a
# mismatch here silently "succeeds" while deleting nothing and leaving you billed.
REGION="${REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
KEY="${KEY:-ajace-key}"

if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  echo "✗ No stack '$STACK' in region '$REGION'."
  echo "  Nothing was deleted. Set the right region and re-run, e.g.:"
  echo "     REGION=us-east-2 $0"
  exit 1
fi

BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text 2>/dev/null || true)

echo "This DELETES EVERYTHING for '$STACK' in $REGION — NOTHING is kept:"
echo "  • EC2, RDS (no final snapshot), IAM role, security groups, budget"
echo "  • S3 bucket + ALL files: ${BUCKET:-<none found>}"
echo "  • SSH key pair: $KEY"
read -r -p "Type DELETE to confirm: " c
[ "$c" = "DELETE" ] || { echo "aborted."; exit 1; }

if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
  echo "==> emptying + deleting bucket $BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" || true
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" || true
fi

echo "==> deleting stack (RDS is snapshotted during delete; removed next)"
aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION" || true

echo "==> deleting any leftover RDS snapshots"
for s in $(aws rds describe-db-snapshots --snapshot-type manual --region "$REGION" \
    --query "DBSnapshots[?starts_with(DBInstanceIdentifier,'$STACK')].DBSnapshotIdentifier" --output text 2>/dev/null); do
  aws rds delete-db-snapshot --db-snapshot-identifier "$s" --region "$REGION" && echo "   deleted $s"
done

echo "==> deleting key pair $KEY"
aws ec2 delete-key-pair --key-name "$KEY" --region "$REGION" || true

echo "✅ Everything deleted for $STACK."
