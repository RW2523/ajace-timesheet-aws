#!/usr/bin/env bash
# Start / stop the EC2 box to control COST. A stopped instance = $0 compute
# (EBS + RDS + S3 keep billing). Run from your LAPTOP (needs AWS CLI).
#   deploy/scripts/instance.sh {start|stop|status|ip}
# Override the stack name with STACK=... if you didn't use the default.
set -euo pipefail
STACK="${STACK:-ajace-timesheet}"
ID=$(aws cloudformation describe-stack-resource --stack-name "$STACK" \
       --logical-resource-id AppHost \
       --query 'StackResourceDetail.PhysicalResourceId' --output text)

case "${1:-status}" in
  start)
    aws ec2 start-instances --instance-ids "$ID" >/dev/null
    echo "starting $ID … (a NEW public IP is assigned on start unless you use an Elastic IP —"
    echo "  update SITE_URL + your bookmark; run '$0 ip' once it's up)";;
  stop)
    aws ec2 stop-instances --instance-ids "$ID" >/dev/null
    echo "stopping $ID … compute charge stops. RDS + S3 keep running (see teardown.sh to pause RDS too).";;
  status)
    aws ec2 describe-instances --instance-ids "$ID" \
      --query 'Reservations[0].Instances[0].State.Name' --output text;;
  ip)
    aws ec2 describe-instances --instance-ids "$ID" \
      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text;;
  *) echo "usage: instance.sh {start|stop|status|ip}"; exit 1;;
esac
