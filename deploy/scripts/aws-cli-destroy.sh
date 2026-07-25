#!/usr/bin/env bash
# =============================================================================
# Delete everything aws-cli-deploy.sh created, in dependency order, using the
# ids recorded in deploy/.aws-state.
#
#   bash deploy/scripts/aws-cli-destroy.sh
#
# ⚠ IRREVERSIBLE: no RDS final snapshot is kept and the S3 bucket (every
# uploaded timesheet) is emptied and deleted. To pause cheaply instead, stop the
# instance:  aws ec2 stop-instances --instance-ids <id>
# =============================================================================
set -uo pipefail   # NOT -e: keep deleting even if one resource is already gone

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HERE/.aws-state"
[ -f "$STATE" ] || { echo "No $STATE — nothing recorded to delete."; echo "If you deployed anyway, delete by hand in the console."; exit 1; }
get() { grep "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }

REGION=$(get REGION); NAME="${NAME:-ajace-timesheet}"
IID=$(get IID); DBID=$(get DBID); BUCKET=$(get BUCKET)
APP_SG=$(get APP_SG); DB_SG=$(get DB_SG); SUBGRP=$(get SUBGRP)
ROLE=$(get ROLE); PROFILE=$(get PROFILE); KEY=$(get KEY); BUDGET=$(get BUDGET)
A() { aws --region "$REGION" "$@"; }

echo "About to PERMANENTLY DELETE in $REGION:"
echo "  EC2 $IID · RDS $DBID (no final snapshot) · S3 $BUCKET + all files"
echo "  SGs $APP_SG/$DB_SG · subnet group $SUBGRP · IAM $ROLE · key $KEY · budget $BUDGET"
read -r -p "Type DELETE to confirm: " c
[ "$c" = "DELETE" ] || { echo "aborted."; exit 1; }

if [ -n "$IID" ]; then
  echo "==> terminating EC2 $IID"
  A ec2 terminate-instances --instance-ids "$IID" >/dev/null 2>&1
  A ec2 wait instance-terminated --instance-ids "$IID" 2>/dev/null
fi

if [ -n "$DBID" ]; then
  echo "==> deleting RDS $DBID"
  A rds delete-db-instance --db-instance-identifier "$DBID" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1
  A rds wait db-instance-deleted --db-instance-identifier "$DBID" 2>/dev/null
fi
[ -n "$SUBGRP" ] && { echo "==> deleting DB subnet group"; A rds delete-db-subnet-group --db-subnet-group-name "$SUBGRP" >/dev/null 2>&1; }

# db SG references app SG, so it must go first; both need their ENIs gone.
for sg in "$DB_SG" "$APP_SG"; do
  [ -n "$sg" ] || continue
  echo "==> deleting security group $sg"
  for i in 1 2 3 4 5 6; do
    A ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 && break
    sleep 10   # network interfaces can take a moment to detach
  done
done

if [ -n "$BUCKET" ]; then
  echo "==> emptying + deleting s3://$BUCKET"
  A s3 rm "s3://$BUCKET" --recursive >/dev/null 2>&1
  A s3api delete-bucket --bucket "$BUCKET" >/dev/null 2>&1
fi

if [ -n "$ROLE" ]; then
  echo "==> deleting IAM role/profile $ROLE"
  aws iam remove-role-from-instance-profile --instance-profile-name "${PROFILE:-$ROLE}" --role-name "$ROLE" >/dev/null 2>&1
  aws iam delete-instance-profile --instance-profile-name "${PROFILE:-$ROLE}" >/dev/null 2>&1
  aws iam delete-role-policy --role-name "$ROLE" --policy-name "$NAME-s3-ses" >/dev/null 2>&1
  aws iam delete-role --role-name "$ROLE" >/dev/null 2>&1
fi

[ -n "$KEY" ]    && { echo "==> deleting key pair $KEY"; A ec2 delete-key-pair --key-name "$KEY" >/dev/null 2>&1; }
[ -n "$BUDGET" ] && { echo "==> deleting budget"; ACC=$(aws sts get-caller-identity --query Account --output text); \
                      aws budgets delete-budget --account-id "$ACC" --budget-name "$BUDGET" >/dev/null 2>&1; }

mv "$STATE" "$STATE.deleted-$(date +%s)" 2>/dev/null
echo
echo "✅ Done. Verify nothing is left (all four should print nothing):"
echo "  aws ec2 describe-instances --region $REGION --filters Name=instance-state-name,Values=running,stopped --query 'Reservations[].Instances[].InstanceId' --output text"
echo "  aws rds describe-db-instances --region $REGION --query 'DBInstances[].DBInstanceIdentifier' --output text"
echo "  aws ec2 describe-volumes --region $REGION --query 'Volumes[].VolumeId' --output text"
echo "  aws s3 ls | grep $BUCKET"
