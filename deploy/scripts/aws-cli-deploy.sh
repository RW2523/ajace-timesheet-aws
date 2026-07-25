#!/usr/bin/env bash
# =============================================================================
# Provision the whole AWS side with PLAIN AWS CLI (no CloudFormation).
# Equivalent to infra/cloudformation.yaml: S3 + IAM role + security groups +
# RDS Postgres + EC2 app host + a monthly budget.
#
#   REGION=us-east-2 DBPASS='YourStrongPass' BUDGET_EMAIL=you@ajace.com \
#     bash deploy/scripts/aws-cli-deploy.sh
#
# Every resource id is appended to deploy/.aws-state so
# aws-cli-destroy.sh can delete exactly what this created. WITHOUT that file you
# must clean up by hand — this is the main reason CloudFormation is easier.
# Safe to re-run: each step is skipped if the resource already exists.
# =============================================================================
set -euo pipefail

REGION="${REGION:-us-east-2}"
NAME="${NAME:-ajace-timesheet}"
KEY="${KEY:-ajace-key}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
DB_CLASS="${DB_CLASS:-db.t4g.micro}"
VOLUME_GB="${VOLUME_GB:-50}"
BUDGET_USD="${BUDGET_USD:-15}"
: "${DBPASS:?set DBPASS='a-strong-password' (8+ chars, avoid @ / and spaces)}"
: "${BUDGET_EMAIL:?set BUDGET_EMAIL=you@example.com}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HERE/.aws-state"
touch "$STATE"
save() { grep -q "^$1=" "$STATE" 2>/dev/null || echo "$1=$2" >> "$STATE"; }
get()  { grep "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }
A() { aws --region "$REGION" "$@"; }

ACCOUNT=$(A sts get-caller-identity --query Account --output text)
BUCKET="${BUCKET:-$NAME-files-$RANDOM}"
[ -n "$(get BUCKET)" ] && BUCKET=$(get BUCKET)
echo "account=$ACCOUNT region=$REGION bucket=$BUCKET"
save REGION "$REGION"; save BUCKET "$BUCKET"

# ---------------------------------------------------------------- networking
VPC=$(A ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" = "None" ] && { echo "no default VPC in $REGION — pass VPC/subnets manually"; exit 1; }
# (no mapfile here — macOS still ships bash 3.2, where it doesn't exist)
SUBNET_LIST=$(A ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
  --query 'sort_by(Subnets,&AvailabilityZone)[].SubnetId' --output text | tr '\t' ' ')
set -- $SUBNET_LIST
[ $# -ge 2 ] || { echo "need >=2 subnets in $VPC"; exit 1; }
APP_SUBNET="$1"; DB_A="$1"; DB_B="$2"
PUBIP_ON=$(A ec2 describe-subnets --subnet-ids "$APP_SUBNET" --query 'Subnets[0].MapPublicIpOnLaunch' --output text)
[ "$PUBIP_ON" = "True" ] || echo "  ⚠ $APP_SUBNET does not auto-assign a public IP — you may not be able to SSH."
echo "vpc=$VPC app-subnet=$APP_SUBNET db-subnets=$DB_A,$DB_B"

MYIP=$(curl -s --max-time 5 ifconfig.me || echo "0.0.0.0")
echo "==> [1/7] security groups"
APP_SG=$(get APP_SG)
if [ -z "$APP_SG" ]; then
  APP_SG=$(A ec2 create-security-group --group-name "$NAME-app" --vpc-id "$VPC" \
    --description "$NAME app host (SSH + HTTP/S)" --query GroupId --output text)
  A ec2 authorize-security-group-ingress --group-id "$APP_SG" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null
  A ec2 authorize-security-group-ingress --group-id "$APP_SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  A ec2 authorize-security-group-ingress --group-id "$APP_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  save APP_SG "$APP_SG"
fi
DB_SG=$(get DB_SG)
if [ -z "$DB_SG" ]; then
  DB_SG=$(A ec2 create-security-group --group-name "$NAME-db" --vpc-id "$VPC" \
    --description "$NAME RDS (from the app host only)" --query GroupId --output text)
  A ec2 authorize-security-group-ingress --group-id "$DB_SG" --protocol tcp --port 5432 \
    --source-group "$APP_SG" >/dev/null
  save DB_SG "$DB_SG"
fi
echo "    app-sg=$APP_SG db-sg=$DB_SG (SSH open to $MYIP/32)"

echo "==> [2/7] S3 bucket (private, encrypted, NO CORS — uploads are app-proxied)"
if ! A s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  if [ "$REGION" = "us-east-1" ]; then           # us-east-1 must NOT send a LocationConstraint
    A s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    A s3api create-bucket --bucket "$BUCKET" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  A s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  A s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi
echo "    s3://$BUCKET"

echo "==> [3/7] IAM role + instance profile (S3 objects + SES)"
ROLE="$NAME-role"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  save ROLE "$ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$NAME-s3-ses" --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::$BUCKET/*"},
 {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::$BUCKET"},
 {"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"}]}
JSON
)"
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  save PROFILE "$ROLE"
  echo "    waiting for the instance profile to propagate…"; sleep 15
fi

echo "==> [4/7] RDS PostgreSQL ($DB_CLASS) — this is the slow one (~10 min)"
SUBGRP="$NAME-subnets"
A rds describe-db-subnet-groups --db-subnet-group-name "$SUBGRP" >/dev/null 2>&1 || {
  A rds create-db-subnet-group --db-subnet-group-name "$SUBGRP" \
    --db-subnet-group-description "$NAME" --subnet-ids "$DB_A" "$DB_B" >/dev/null
  save SUBGRP "$SUBGRP"; }
DBID="$NAME-db"
if ! A rds describe-db-instances --db-instance-identifier "$DBID" >/dev/null 2>&1; then
  A rds create-db-instance \
    --db-instance-identifier "$DBID" --db-name timesheet \
    --engine postgres --engine-version 16 \
    --db-instance-class "$DB_CLASS" \
    --allocated-storage 20 --storage-type gp3 --storage-encrypted \
    --master-username tsadmin --master-user-password "$DBPASS" \
    --db-subnet-group-name "$SUBGRP" --vpc-security-group-ids "$DB_SG" \
    --no-publicly-accessible --backup-retention-period 7 --no-multi-az >/dev/null
  save DBID "$DBID"
fi

echo "==> [5/7] EC2 app host ($INSTANCE_TYPE, ${VOLUME_GB}GB)"
A ec2 describe-key-pairs --key-names "$KEY" >/dev/null 2>&1 || {
  A ec2 create-key-pair --key-name "$KEY" --query KeyMaterial --output text > "$KEY.pem"
  chmod 400 "$KEY.pem"; save KEY "$KEY"
  echo "    wrote private key to ./$KEY.pem  (keep it — you cannot download it again)"; }

IID=$(get IID)
if [ -z "$IID" ]; then
  AMI=$(A ssm get-parameter \
    --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
    --query Parameter.Value --output text)
  # Minimal user-data: just git. Do NOT apt-get install awscli here (no such
  # package on Ubuntu 24.04); install.sh fetches AWS CLI v2 properly.
  UD=$(printf '#!/bin/bash\napt-get update -y\napt-get install -y git\n' | base64 | tr -d '\n')
  for attempt in 1 2 3 4 5; do
    IID=$(A ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
      --key-name "$KEY" --subnet-id "$APP_SUBNET" --security-group-ids "$APP_SG" \
      --iam-instance-profile "Name=$ROLE" --user-data "$UD" \
      --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
      --query 'Instances[0].InstanceId' --output text 2>/dev/null) && break
    echo "    instance profile not ready yet, retrying ($attempt/5)…"; sleep 15
  done
  [ -n "$IID" ] || { echo "run-instances failed"; exit 1; }
  save IID "$IID"
fi
echo "    instance=$IID"

echo "==> [6/7] monthly budget (\$$BUDGET_USD, alerts only — free)"
cat > /tmp/$NAME-budget.json <<JSON
{"BudgetName":"$NAME-monthly","BudgetLimit":{"Amount":"$BUDGET_USD","Unit":"USD"},
 "TimeUnit":"MONTHLY","BudgetType":"COST"}
JSON
cat > /tmp/$NAME-notif.json <<JSON
[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
  "Subscribers":[{"SubscriptionType":"EMAIL","Address":"$BUDGET_EMAIL"}]},
 {"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
  "Subscribers":[{"SubscriptionType":"EMAIL","Address":"$BUDGET_EMAIL"}]},
 {"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
  "Subscribers":[{"SubscriptionType":"EMAIL","Address":"$BUDGET_EMAIL"}]}]
JSON
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget file:///tmp/$NAME-budget.json \
  --notifications-with-subscribers file:///tmp/$NAME-notif.json >/dev/null 2>&1 \
  && save BUDGET "$NAME-monthly" || echo "    (budget already exists — skipped)"

echo "==> [7/7] waiting for EC2 + RDS to come up"
A ec2 wait instance-running --instance-ids "$IID"
IP=$(A ec2 describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "    app host ready: $IP"
echo "    waiting on RDS (usually 5-10 min)…"
A rds wait db-instance-available --db-instance-identifier "$DBID"
EP=$(A rds describe-db-instances --db-instance-identifier "$DBID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)

cat <<EOF

════════════════════════════════════════════════════════════════════
✅ AWS infrastructure ready (region $REGION)

  App host IP : $IP
  DB endpoint : $EP
  S3 bucket   : $BUCKET
  SSH key     : ./$KEY.pem
  State file  : $STATE   <-- aws-cli-destroy.sh needs this. Keep it.

NEXT — install the app on the box:

  ssh -i $KEY.pem ubuntu@$IP
  git clone https://github.com/RW2523/ajace-timesheet-aws.git
  cd ajace-timesheet-aws
  cp deploy/env.production.example .env.production
  nano app/.env.production      # paste the block below, add your OpenRouter key
  bash deploy/scripts/install.sh

  DATABASE_URL=postgresql://tsadmin:$DBPASS@$EP:5432/timesheet
  STORAGE_S3_BUCKET=$BUCKET
  STORAGE_S3_REGION=$REGION
  DIRECT_SERVERLESS=true
  OPENROUTER_API_KEY=sk-or-...
  NEXT_PUBLIC_AI_ENABLED=true
  COOKIE_SECURE=false
  NODE_ENV=production

Then open  http://$IP
Tear it all down later:  bash deploy/scripts/aws-cli-destroy.sh
════════════════════════════════════════════════════════════════════
EOF
