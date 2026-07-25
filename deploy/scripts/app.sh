#!/usr/bin/env bash
# Start / stop / restart the APP process (PM2). Run ON the EC2 box.
# This controls the app only — the box keeps running (still bills). To stop
# paying for compute, stop the whole instance with scripts/instance.sh (laptop).
#   deploy/scripts/app.sh {start|stop|restart|status|logs}
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NAME=ajace-timesheet
case "${1:-status}" in
  start)   pm2 start "$HERE/ecosystem.config.cjs" 2>/dev/null || pm2 start "$NAME"; pm2 save ;;
  stop)    pm2 stop "$NAME" ;;
  restart) pm2 restart "$NAME" ;;
  status)  pm2 status "$NAME" ;;
  logs)    pm2 logs "$NAME" ;;
  *) echo "usage: app.sh {start|stop|restart|status|logs}"; exit 1 ;;
esac
