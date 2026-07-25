#!/usr/bin/env bash
# Create a monthly AWS COST budget with email alerts. AWS Budgets — the first
# TWO budgets are FREE. Run from your laptop (needs AWS CLI).
#   BUDGET_EMAIL=you@ajace.com deploy/scripts/budget.sh [amount_usd]
#
# NOTE: a budget ALERTS you; it does NOT hard-stop spending. To actually stay
# under the limit, run the box intermittently (scripts/instance.sh stop) or add
# a Budget Action (see README). Default limit: $15/month.
set -euo pipefail
EMAIL="${BUDGET_EMAIL:?set BUDGET_EMAIL=you@example.com}"
AMOUNT="${1:-15}"
ACCT=$(aws sts get-caller-identity --query Account --output text)
NAME="ajace-timesheet-monthly"

BUDGET=$(printf '{"BudgetName":"%s","BudgetType":"COST","TimeUnit":"MONTHLY","BudgetLimit":{"Amount":"%s","Unit":"USD"}}' "$NAME" "$AMOUNT")

sub() { printf '{"Notification":{"NotificationType":"%s","ComparisonOperator":"GREATER_THAN","Threshold":%s,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"%s"}]}' "$1" "$2" "$EMAIL"; }
NOTIFS="[$(sub ACTUAL 50),$(sub ACTUAL 80),$(sub ACTUAL 100),$(sub FORECASTED 100)]"

aws budgets create-budget --account-id "$ACCT" \
  --budget "$BUDGET" \
  --notifications-with-subscribers "$NOTIFS"

echo "✓ Created \$$AMOUNT/mo budget '$NAME' — email alerts to $EMAIL at 50/80/100% + forecast."
echo "  Reminder: this warns you; it doesn't cap spend. Pause with scripts/instance.sh stop."
