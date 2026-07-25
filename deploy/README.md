# Timesheet (Direct++) — AWS-only (no Supabase)

The timesheet app re-platformed onto **AWS-native services**. Supabase is gone
entirely. The only thing that leaves AWS is the OpenRouter call (Direct++ AI).

```
Browser ──HTTPS──► Caddy ──► Next.js app (:3009, PM2) ──► OpenRouter (Direct++)
                                 │
              ┌──────────────────┼───────────────────┐
              ▼                   ▼                    ▼
     Amazon RDS Postgres   S3 via the app       (self-managed auth
     records + auth_users   file bytes  (no CORS)  = bcrypt + JWT cookie)
```

### What replaced Supabase

| Supabase piece | Now |
|---|---|
| GoTrue auth | **self-managed** — `auth_users` table + bcrypt + a signed JWT session cookie (`lib/aws/auth.js`, `/api/auth/*`) |
| Postgres + PostgREST | **Amazon RDS** + one scoped endpoint `/api/data` (`lib/aws/data.js`) |
| RLS (DB-enforced) | **app-enforced** ownership in `lib/aws/data.js` (deny-by-default, forces `user_id = you`) |
| Storage | **S3, proxied through the app** (`lib/aws/storage.js`, `/api/storage/upload` + `/api/storage/get`). The browser never talks to S3 directly, so **no bucket CORS is needed** and the box needs no `s3:PutBucketCORS`. |
| the `@supabase/*` client | **drop-in shims** (`lib/supabase/{client,server,middleware}.js`) so existing pages/components didn't change |

The app **builds clean** as an AWS-native app (verified: `next build` → all 23 routes, no Supabase imports).

---

## ✅ What I need from you

| # | Item | Notes |
|---|------|-------|
| 1 | **AWS account** + **EC2** `t4g.small` (2 GB) Ubuntu 24.04, ports 22/80/443 | app only — no Supabase containers, so 2 GB is plenty |
| 2 | **Amazon RDS PostgreSQL** — `db.t4g.micro`, same VPC, reachable from the EC2 box | the database |
| 3 | **S3 bucket** (private; name must be globally unique) + an **IAM role on the EC2 box** for it | file storage |
| 4 | **A domain** — `timesheet.` → the EC2 IP | TLS + cookies |
| 5 | **OpenRouter API key** | Direct++ document AI |
| 6 | **`AUTH_JWT_SECRET`** you generate (`openssl rand -base64 48`) | signs the login session |

## Deploy — production, in 3 phases

### Phase 1 — provision all AWS infra (one command, your creds)
`infra/cloudformation.yaml` creates the S3 bucket, RDS Postgres, EC2 app host,
the IAM role (S3 + SES), and security groups. Run it with the AWS CLI:

```bash
aws cloudformation deploy \
  --template-file deploy/infra/cloudformation.yaml \
  --stack-name ajace-timesheet \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      VpcId=vpc-xxxx AppSubnetId=subnet-public \
      DbSubnetIds=subnet-aaa,subnet-bbb \
      KeyName=your-keypair SSHLocation=YOUR_IP/32 \
      DBPassword='a-strong-password' BucketName=ajace-ts-files-$RANDOM \
      BudgetAlertEmail=you@ajace.com MonthlyBudgetUSD=15
aws cloudformation describe-stacks --stack-name ajace-timesheet \
  --query 'Stacks[0].Outputs' --output table    # note AppPublicIP + DBEndpoint
```
> The app subnet must be **public** (auto-assign public IPv4 on). `DeletionPolicy`
> keeps the S3 bucket and snapshots RDS if you delete the *stack* directly with
> `aws cloudformation delete-stack`. Note that `scripts/teardown.sh` deliberately
> goes further and destroys those too — see the warning in the day-2 section.

### Phase 2 — bring the app to production (on the EC2 host)
```bash
ssh -i your-key.pem ubuntu@<AppPublicIP>
git clone https://github.com/RW2523/ajace-timesheet-aws.git
cd ajace-timesheet-aws
cp deploy/env.production.example .env.production
#   ↳ edit: DATABASE_URL (RDS endpoint + DBPassword), STORAGE_S3_BUCKET/REGION,
#           OPENROUTER_API_KEY, SITE_URL, COOKIE_SECURE  (AUTH_JWT_SECRET auto-generates)
bash deploy/scripts/install.sh      # ONE file: setup + build + migrate + pm2 + caddy
```
> `install.sh` is the single all-in-one setup — installs everything, builds,
> creates the schema, and starts the app. Re-run it any time (idempotent).

### Phase 3 — access, admin, email

**No domain yet? Use the raw EC2 URL (default).** The shipped `Caddyfile` serves
plain HTTP on port 80, so just open **`http://<AppPublicIP>`**. For this to work,
keep `COOKIE_SECURE=false` in `app/.env.production` (otherwise the login cookie
won't stick over HTTP) and set `SITE_URL=http://<AppPublicIP>`.
> ⚠️ Plain HTTP is unencrypted — fine for a demo/pilot with test data, but add a
> domain + HTTPS before real employee data. To switch later: point a DNS A record
> at the box, uncomment the domain block in `Caddyfile`, set `COOKIE_SECURE=true`
> and `SITE_URL=https://…`, then `sudo systemctl reload caddy` + rebuild.

```bash
deploy/scripts/make-admin.sh you@ajace.com   # first admin
deploy/scripts/ses-test.sh you@ajace.com      # confirm SES delivery
```

**SES (reset emails):** verify a sender + request production access in the SES
console (both free — new accounts start in sandbox). The instance already has
`ses:SendEmail` via the IAM role (`iam/instance-policy.json`).

## Verify end-to-end (your live test — I can't run RDS/S3 from here)

1. Open `http://<AppPublicIP>` (or your domain) → **Sign up** → you land on the dashboard (session cookie set).
2. Upload a timesheet → Direct++ (OpenRouter) reads it → hours appear.
3. Confirm storage + records:
   ```bash
   aws s3 ls s3://<YOUR-BucketName-from-stack-output>/ts-uploads/ --recursive
   psql "$DATABASE_URL" -c "select email from auth_users; select count(*) from ts_timesheets;"
   ```
4. **Make yourself admin:** `deploy/scripts/make-admin.sh you@ajace.com` → refresh → `/admin` shows all submissions (the role is read from the DB on every request, so no re-login is needed).
5. **Privacy check (the RLS replacement):** as a second, non-admin user, confirm you see only your own timesheets.

## Manage it (day-2)

| Task | Command | Where |
|---|---|---|
| Pre-flight before launch | see [`PREFLIGHT.md`](PREFLIGHT.md) | — |
| Start/stop/restart the **app** | `scripts/app.sh {start\|stop\|restart\|status\|logs}` | on the box |
| Start/stop the **whole box** (save compute $) | `scripts/instance.sh {start\|stop\|status\|ip}` | laptop |
| Deploy code updates | `git pull && scripts/install.sh` | on the box |
| First admin | `scripts/make-admin.sh you@ajace.com` | on the box |
| Test reset email | `scripts/ses-test.sh you@ajace.com` | on the box |
| Nightly DB backup → S3 | `scripts/backup.sh` (add to cron) | on the box |
| **Delete EVERYTHING permanently** (see warning below) | `scripts/teardown.sh` | laptop |

> Stopping the instance assigns a **new public IP** on restart (unless you attach
> an Elastic IP) — re-check with `scripts/instance.sh ip` and update `SITE_URL`.

## Cost (AWS-only)

| Line | Spec | $/mo |
|---|---|--:|
| EC2 `t4g.small` (app) | on-demand | ~$12 |
| RDS `db.t4g.micro` + 20 GB | single-AZ | ~$14 ($0 first 12 mo) |
| S3 (files) | ~10–20 GB | ~$1 |
| Data transfer / DNS | light | ~$1 |
| **AWS total** | | **~$28** (~$14 first year) |
| OpenRouter | Direct++ usage | ~$1–15 |

RDS can't cheaply "turn off" like EC2, so the always-down ~$2/mo trick doesn't apply here — this is the trade for going fully managed/AWS-native.

### $15/month budget (free)
The stack creates a **$15/month AWS Budget** (email alerts at 50/80/100% + forecast). AWS Budgets are **free** (first two). Add one to an existing account without redeploying:
```bash
BUDGET_EMAIL=you@ajace.com deploy/scripts/budget.sh 15
```
**Honest caveat — a budget alerts, it does NOT hard-stop spending.** To actually stay under $15:
- **First 12 months** you're already ~$14/mo (RDS + EBS free-tier) — under $15 by default.
- **After the free year** the stack is ~$28/mo, so $15 means running the box only ~half the month: `scripts/instance.sh stop` when idle, `start` when needed (RDS + S3 keep the data). To pause between pilots use `scripts/instance.sh stop` — **not** `teardown.sh`.

> ⚠️ **`scripts/teardown.sh` is irreversible.** It empties and deletes the S3
> bucket (every uploaded timesheet), deletes the stack, deletes the RDS final
> snapshot, and deletes the key pair. Nothing is recoverable afterwards. Use it
> only when you are finished with the deployment for good.
> To pause cheaply instead: `scripts/instance.sh stop` (compute stops billing;
> RDS + S3 keep your data), or take your own snapshot first.
- For an automatic cap, a **Budget Action** can stop the EC2 instance at 100% (needs an IAM role) — ask if you want it wired in.

---

## ⚠️ Status — read before trusting in production

This is a **complete first implementation that compiles cleanly**, but I could not
run it against a live RDS/S3 from here. Test the checklist above. Known things to
watch on first run:

- **`/api/data` scoping** (`lib/aws/data.js`) is the RLS replacement — exercise every
  screen as a non-admin AND an admin and confirm no cross-user data leaks.
- **Password reset email** is wired to **Amazon SES** (`lib/aws/email.js`). To turn it on:
  1. In SES, **verify a sender** (`noreply@ajace.com` or your domain — domain verification adds DKIM).
  2. **Request production access** (new SES accounts start in *sandbox* — can only send to verified
     addresses until approved; the request is free and usually approved within a day).
  3. Add `ses:SendEmail` to the EC2 instance IAM role, set `SES_FROM_EMAIL` in `.env.production`.
  If `SES_FROM_EMAIL` is unset, the flow still works — it logs the link instead of emailing.
- **First admin** must be promoted via `make-admin.sh` (no admin exists at first signup).
