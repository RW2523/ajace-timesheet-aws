# Pre-flight checklist — before you launch

Tick these before running the CloudFormation deploy. ~10 minutes.

## 1. Access
- [ ] AWS account with billing enabled
- [ ] AWS CLI installed + logged in → `aws sts get-caller-identity` shows your account
- [ ] Region picked (default **us-east-1** = cheapest)

## 2. Stack inputs (Phase 1 parameters)
- [ ] **VPC id** — default VPC is fine: `aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text`
- [ ] **App subnet** — one PUBLIC subnet (auto-assign public IPv4 = yes)
- [ ] **DB subnets** — two subnets in different AZs
- [ ] **EC2 key pair** — `aws ec2 create-key-pair --key-name ajace-key --query KeyMaterial --output text > ajace-key.pem && chmod 400 ajace-key.pem`
- [ ] **Your public IP** for SSH — `curl ifconfig.me` (pass as `SSHLocation=IP/32`)
- [ ] **RDS password** chosen (8+ chars, no `@`/`/` to keep the URL simple)
- [ ] **S3 bucket name** — globally unique (e.g. `ajace-ts-files-<something>`)
- [ ] **BudgetAlertEmail** — where the $15/mo budget alerts go (free)

## 3. App secrets (go in app/.env.production)
- [ ] **OPENROUTER_API_KEY** (Direct++ AI)
- [ ] **AUTH_JWT_SECRET** — leave the placeholder; `install.sh` auto-generates it
- [ ] Raw EC2 URL for now → **COOKIE_SECURE=false**, **SITE_URL=http://<EC2-IP>**

## 4. Email (optional — for password resets)
- [ ] SES sender verified + production access requested (both free; ~1 day)

## 5. Cost awareness
- [ ] ~**$28/mo** steady (~$14 first year) + OpenRouter usage
- [ ] **$15/mo budget** auto-created by the stack (alerts only) — or `scripts/budget.sh`
- [ ] To truly stay ≤ $15 after the free year: run intermittently (`instance.sh stop`)
- [ ] Know the pause options: `instance.sh stop` (compute only) · `teardown.sh` (snapshot + delete)

## 6. Post-launch smoke test
- [ ] Stack **CREATE_COMPLETE**; noted **AppPublicIP** + **DBEndpoint**
- [ ] `install.sh` finished; **http://<AppPublicIP>** shows the login page
- [ ] Signed up → dashboard loads
- [ ] `make-admin.sh you@…` → `/admin` shows submissions
- [ ] Uploaded a timesheet → row in `ts_timesheets` + object in `s3://<bucket>/ts-uploads/`
