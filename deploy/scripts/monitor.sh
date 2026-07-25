#!/usr/bin/env bash
# Health watchdog. Runs from cron on the box every 5 minutes.
#
# Nothing used to tell you the app was down: pm2 gives up after max_restarts and
# stays stopped silently, and the only alerting configured was an AWS *cost*
# email. This checks the app end-to-end (app -> database), restarts it once, and
# emails you via SES if it can't recover.
#
#   */5 * * * * /home/ubuntu/ajace-timesheet-aws/deploy/scripts/monitor.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE=/tmp/ts-monitor.state
URL="http://127.0.0.1:3009/api/health"
[ -f "$ROOT/.env.production" ] && { set -a; . "$ROOT/.env.production"; set +a; }
ALERT_TO="${MONITOR_ALERT_EMAIL:-${SES_FROM_EMAIL:-}}"

notify() {  # only alert on a CHANGE of state, so cron doesn't email every 5 min
  local state="$1" subject="$2" body="$3"
  [ "$(cat "$STATE" 2>/dev/null)" = "$state" ] && return 0
  echo "$state" > "$STATE"
  logger -t ts-monitor "$subject"
  if [ -n "$ALERT_TO" ] && [ -n "${SES_FROM_EMAIL:-}" ]; then
    aws ses send-email --region "${SES_REGION:-${STORAGE_S3_REGION:-us-east-1}}" \
      --from "$SES_FROM_EMAIL" --destination "ToAddresses=$ALERT_TO" \
      --message "Subject={Data=$subject},Body={Text={Data=$body}}" >/dev/null 2>&1 \
      && logger -t ts-monitor "alert emailed to $ALERT_TO" \
      || logger -t ts-monitor "SES alert FAILED (is the sender verified?)"
  fi
}

CODE=$(curl -s -o /tmp/ts-health.json -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)
if [ "$CODE" = "200" ]; then
  notify ok "[timesheet] recovered" "The timesheet app is responding again on $(hostname)."
  exit 0
fi

logger -t ts-monitor "health check failed (HTTP $CODE) — restarting"
pm2 restart ajace-timesheet >/dev/null 2>&1
sleep 20
CODE2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)
if [ "$CODE2" = "200" ]; then
  notify ok "[timesheet] recovered after restart" \
    "Health check failed (HTTP $CODE) and a pm2 restart fixed it. Worth checking: pm2 logs ajace-timesheet"
  exit 0
fi

DISK=$(df -h / | awk 'NR==2{print $5" used of "$2}')
MEM=$(free -h 2>/dev/null | awk 'NR==2{print $3"/"$2}')
notify down "[timesheet] APP IS DOWN on $(hostname)" \
"The timesheet app is not responding (HTTP $CODE, still $CODE2 after a restart).

Disk: $DISK
Memory: $MEM
Health body: $(head -c 300 /tmp/ts-health.json 2>/dev/null)

Check:  pm2 status ; pm2 logs ajace-timesheet --lines 50 --nostream"
exit 1
