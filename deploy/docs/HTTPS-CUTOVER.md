# HTTPS cutover runbook

Moving this box from `http://<raw-EC2-IP>/` to `https://<HOSTNAME>/`.

Throughout this document, replace `<HOSTNAME>` with the subdomain you are going
to use — e.g. `apps.yourdomain.com`. It appears nowhere in either repo; you fill
it in exactly twice (once in Cloudflare, once on the command line) and the
script persists it for you.

**This box runs payroll.** Read the whole page before you start. Total time
30–60 minutes, most of it two Next.js builds on a 2 GB instance.

---

## What is actually changing, and what is not

One hostname, two paths — deliberately **not** two subdomains:

| URL | App | Port |
| --- | --- | --- |
| `https://<HOSTNAME>/` | Timesheet / payroll | 3009 |
| `https://<HOSTNAME>/procurement` | Procurement | 3002 |

Both apps share one login: an httpOnly JWT cookie named `ts_session`, issued by
the timesheet app. Because they are on the **same origin**, that cookie needs no
`Domain` attribute and procurement keeps its `basePath=/procurement`. Neither of
those changes here, and you should not change them.

What does change: Caddy serves a hostname with a real certificate instead of
`:80`; `COOKIE_SECURE` flips to `true`; `SITE_URL` (password-reset links) and
procurement's `NEXT_PUBLIC_LOGIN_URL` / `NEXT_PUBLIC_LOGOUT_URL` become
`https://<HOSTNAME>...`; both apps are rebuilt, because Next bakes
`NEXT_PUBLIC_*` in at build time.

Two consequences that are deliberate rather than incidental, both explained in
full further down — read them before you schedule this:

- **`http://<old-IP>/` stops working entirely.** Not a redirect: a dead end. The
  raw-IP bookmark is gone. ("The raw-IP URL after the cutover")
- **Every existing session is invalidated server-side**, not merely orphaned by
  the change of origin. Everyone signs in again. (Step 6)

## The three ways this goes wrong

1. **`COOKIE_SECURE=true` before TLS actually works.** The browser will not send
   a `Secure` cookie over plain HTTP, so the login cookie never comes back and
   *nobody can sign in to either app* — you included. The script exists mainly to
   make this impossible: it proves the certificate with a real TLS handshake
   before it touches that variable.
2. **Port 80 closed "because we're on HTTPS now."** Let's Encrypt validates over
   port 80. Close it and you get no certificate today, and — worse — renewal
   fails silently in about 60 days and the site dies while you are not looking.
   **Leave port 80 open forever.**
3. **Treating this as "just a TLS change."** It is not. The script finishes by
   running `install.sh`, which rebuilds both apps from the current checkout and
   applies `deploy/db/schema.sql` to the live payroll database. Pull carelessly
   in Step 4 and you have shipped unreviewed code and migrated payroll in the
   same command — and while the rollback script can undo the config and the
   code, **nothing undoes the DDL**. Step 4a is how you avoid this.

---

## Step 1 — Give the box a permanent IP (skip if it already has one)

An auto-assigned public IPv4 is released every time the instance stops. Pointing
DNS at an address that can change is how you lose the site on the next reboot.

> **Your SSH session will drop and the public IP will change the moment the
> Elastic IP is associated.** Do this *before* creating the DNS record, and do it
> from CloudShell (not from an SSH session on the box).

Check first — if `PublicIp` comes back non-empty here, you already have one and
can skip to Step 2:

```bash
REGION=us-east-2
aws ec2 describe-addresses --region $REGION \
  --query 'Addresses[].{IP:PublicIp,Instance:InstanceId,Alloc:AllocationId}' --output table
```

Find the instance, then allocate and associate:

```bash
REGION=us-east-2

# 1. the instance
aws ec2 describe-instances --region $REGION \
  --filters 'Name=instance-state-name,Values=running' \
  --query 'Reservations[].Instances[].{Id:InstanceId,IP:PublicIpAddress,Name:Tags[?Key==`Name`]|[0].Value}' \
  --output table

IID=i-xxxxxxxxxxxxxxxxx      # paste the instance id from above

# 2. allocate an Elastic IP
ALLOC=$(aws ec2 allocate-address --region $REGION --domain vpc \
  --query AllocationId --output text)
echo "AllocationId: $ALLOC"

# 3. associate it — THE PUBLIC IP CHANGES HERE, ANY SSH SESSION DROPS
aws ec2 associate-address --region $REGION --instance-id "$IID" --allocation-id "$ALLOC"

# 4. the new, permanent address
EIP=$(aws ec2 describe-addresses --region $REGION --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)
echo "Permanent IP: $EIP"
```

Write `$EIP` down. Cost: an Elastic IP attached to a *running* instance costs
about the same as the auto-assigned one you already pay for (~$3.60/mo). It keeps
billing while the instance is stopped — that is the price of a stable address.

Do not run `deploy/scripts/stable-ip.sh` *after* the DNS record exists; it
associates immediately and would move the address out from under DNS.

**Give yourself a way back in.** If your own IP changes while the box is
misbehaving, the SSH rule (locked to a single `/32`) will not let you in:

```bash
ROLE=$(aws ec2 describe-instances --region $REGION --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
echo "$ROLE"   # note the role name at the end of the ARN
aws iam attach-role-policy --role-name <that-role-name> \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
# then, any time:  aws ssm start-session --target $IID --region $REGION
```

## Step 2 — Open 80 and 443 in the security group

The deploy script only creates these rules when the security group is *first*
created, so do not assume 443 is open. Check, then add whatever is missing —
`authorize-security-group-ingress` errors harmlessly with
`InvalidPermission.Duplicate` if the rule is already there.

```bash
REGION=us-east-2
IID=i-xxxxxxxxxxxxxxxxx

SG=$(aws ec2 describe-instances --region $REGION --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
echo "app security group: $SG"

# what is open today
aws ec2 describe-security-groups --region $REGION --group-ids "$SG" \
  --query 'SecurityGroups[0].IpPermissions' --output json

# open both. 80 is NOT optional — Let's Encrypt validates over it and renews
# over it every 60 days.
aws ec2 authorize-security-group-ingress --region $REGION --group-id "$SG" \
  --protocol tcp --port 80  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --region $REGION --group-id "$SG" \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# EGRESS must reach the internet: Caddy makes an OUTBOUND HTTPS call to
# acme-v02.api.letsencrypt.org. A locked-down egress rule blocks issuance even
# with 80 and 443 wide open inbound. The default is allow-all — confirm:
aws ec2 describe-security-groups --region $REGION --group-ids "$SG" \
  --query 'SecurityGroups[0].IpPermissionsEgress' --output json
```

## Step 3 — Create the Cloudflare DNS record

### Use a subdomain. Not the apex. The script enforces this.

`apps.yourdomain.com`, `timesheets.yourdomain.com` — something *under* the
domain. **Not `yourdomain.com` itself.**

This is not style. Once `COOKIE_SECURE=true`, both apps send

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

and `includeSubDomains` is scoped to the name in the address bar. On
`apps.yourdomain.com` that covers `apps.yourdomain.com` and anything below it —
nothing else in the zone. On the apex it covers **every host in the domain**:
`www`, `mail`, `staging`, `vpn`, a marketing site someone else hosts, and every
subdomain you have not created yet. Every browser that has loaded payroll then
refuses plain HTTP to all of them, for a year.

There is no undo. Dropping the header later does not clear what browsers have
already stored; it expires per browser, per user, when the year runs out (or by
hand, one machine at a time, via `chrome://net-internals/#hsts`). One visit to
payroll can take an unrelated http-only host in the same zone offline for a
year, and whoever has to fix that will not connect it to this cutover.

`enable-https.sh` **refuses an apex** and tells you to use a subdomain. It
cannot make an apex safe: the header comes from the two Next configs at build
time and is not parameterised by hostname, so there is no reduced mode to fall
back to. `CUTOVER_ALLOW_APEX_HSTS=1` overrides the refusal (and still makes you
type `APEX` at a prompt) — only take that if you have checked every host in the
zone, including the ones that do not exist yet.

The check is a heuristic: two labels is always a domain, and three labels is one
too when the last two are a known multi-part suffix (`co.uk`, `com.au`, …).
There is no Public Suffix List on the box, so an unusual suffix can slip
through. It is a guard, not a proof — choosing a subdomain is what actually
keeps you safe.

In the Cloudflare dashboard: your domain → **DNS** → **Records** → **Add record**.

| Field | Value |
| --- | --- |
| Type | `A` |
| Name | the subdomain only, e.g. `apps` (Cloudflare appends the domain) |
| IPv4 address | the Elastic IP from Step 1 |
| Proxy status | **DNS only — grey cloud.** Not "Proxied", not the orange cloud. |
| TTL | Auto |

**Leave the proxy OFF.** Two reasons, and the second is the serious one.

With the orange cloud on, Let's Encrypt's validation no longer terminates on
this box. Caddy's TLS-ALPN-01 challenge cannot work at all (Cloudflare
terminates TLS), leaving HTTP-01, which only succeeds if Cloudflare forwards
`/.well-known/acme-challenge/...` to the origin unchanged. Whether it does is a
Cloudflare-side matter — a page rule, a cache rule, "Always Use HTTPS", or
"Under Attack" mode can each change it, and none of those feels like touching
certificates. Renewal stops being something this box controls and becomes
something nobody reviews. It fails silently, 60 days later.

And Cloudflare's **"Flexible" SSL is actively more dangerous than having no TLS
at all**: the browser sees a padlock while the Cloudflare→origin leg travels in
plaintext, so every session cookie and every payroll page is exposed on a link
that *looks* encrypted, and nobody has any reason to check.

Verify before moving on:

```bash
dig +short A apps.yourdomain.com @1.1.1.1
```

That must print your Elastic IP and nothing else. If it prints something in
`104.16–104.27.x`, `172.64–172.71.x`, `162.158.x`, `188.114.x` and similar, the
orange cloud is still on.

### If someone later wants to turn the proxy on

The honest answer for this box is **don't**. It is one origin serving payroll to
about twenty people; Cloudflare's proxy buys nothing here and adds a second
place where TLS can be silently downgraded. But "don't" without a procedure gets
ignored, so here is the whole picture.

The trap is not the proxy itself, it is the zone's **SSL/TLS encryption mode**,
which lives somewhere else in the dashboard and is not shown next to the orange
cloud:

| Mode | What the Cloudflare→origin leg does | Consequence here |
| --- | --- | --- |
| **Flexible** | plain HTTP | Padlock in the browser, cleartext to the origin. This box 308-redirects every http request to https, so you get a **redirect loop** instead. The fix everyone finds online is "turn off the origin's HTTPS redirect" — which removes the loop by landing you exactly on padlock-over-plaintext, with `COOKIE_SECURE=true` cheerfully sending the payroll cookie down it. |
| **Full** | HTTPS, certificate **not** verified | No loop, but Cloudflare will accept any certificate from the origin, including a self-signed one. It cannot tell you the origin's TLS broke. |
| **Full (strict)** | HTTPS, certificate verified | The only acceptable mode — and it **hard-fails** (Error 526) the moment the origin certificate lapses. Combined with the renewal risk above, that is the deadlock: renewal breaks quietly, 60 days pass, the site returns 526 to everyone, and HSTS forbids falling back to `http://` for a year. |

So, in order, and only if you have a reason better than "it seemed like a good
idea":

1. Confirm the origin certificate is live and renewing **today** (Step 5's
   `openssl` check, plus `journalctl -u caddy | grep -i renew`).
2. Set the zone SSL/TLS mode to **Full (strict)** *first*, while the record is
   still grey.
3. Only then switch the record to Proxied.
4. Immediately re-test everything in Step 5. A padlock is not the test — check
   from the box that the origin still answers TLS itself:
   `curl -sSI --resolve apps.yourdomain.com:443:<ELASTIC-IP> https://apps.yourdomain.com/`
5. Put a calendar reminder at **50 days** to confirm the certificate actually
   renewed. That is the failure this setup makes silent.

### Nothing re-checks DNS after the cutover

The cutover script refuses to run against a Cloudflare proxy address and
re-checks DNS one last time before the env flip — but `install.sh` and
`render-caddyfile.sh` never look again. If the record is proxied later, every
deploy re-renders the same config without comment.

Worth a cron entry, or at least a habit before each deploy:

```bash
# does the hostname still point at this box?
EIP=<ELASTIC-IP>
test "$(dig +short A apps.yourdomain.com @1.1.1.1)" = "$EIP" \
  && echo "DNS ok" || echo "⚠ DNS MOVED — check the Cloudflare proxy before deploying"
```

## Step 4 — Run one command on the box

### 4a. Pull the cutover script — but review what else comes with it

This is the step most likely to turn a TLS change into an outage, and it has
nothing to do with TLS.

`enable-https.sh` finishes by running `install.sh`, which **rebuilds both apps
from whatever is checked out** and **applies `deploy/db/schema.sql` to the live
payroll database**. So a bare `git pull` here silently makes the cutover an
unreviewed code deploy *and* a schema migration on payroll. The rollback script
can undo the config and the code; **nothing undoes the DDL.**

So: record where you are, look at what is landing, then pull.

```bash
ssh -i ajace-key.pem ubuntu@<ELASTIC-IP>
cd ~/ajace-timesheet-aws

# 1. THE COMMIT THAT IS RUNNING RIGHT NOW. Write it down — this is your way back.
PRE=$(git rev-parse HEAD); echo "pre-cutover commit: $PRE"

# 2. What would the pull bring? Read every line.
git fetch origin
git log --oneline HEAD..origin/main

# 3. Does any of it touch the DATABASE? Anything here is DDL against live
#    payroll, and it is the one thing rollback cannot reverse.
git diff --stat HEAD..origin/main -- deploy/db
git diff        HEAD..origin/main -- deploy/db     # read it if the above is non-empty

# 4. Only now, and only fast-forward — never a merge commit built on the box.
git merge --ff-only origin/main
```

If step 3 printed nothing, this cutover is a code deploy but not a migration.
If it printed something, read the diff before continuing and run the cutover
when staff are **not** submitting timesheets: those changes take
`ACCESS EXCLUSIVE` locks on payroll tables.

### 4b. Run it

```bash
tmux new -s cutover                          # so a dropped SSH doesn't kill the build
ROLLBACK_TO_COMMIT=$PRE \
  bash deploy/scripts/enable-https.sh apps.yourdomain.com you@yourdomain.com
```

`ROLLBACK_TO_COMMIT` is what lets the generated rollback script put the **code**
back, not just the config. You only need to pass it this once: `install.sh`
records the running commit in `deploy/.deployed-commits` from now on, and the
script reads it automatically on every later run.

> If you set `$PRE` in a shell that has since closed, get it from
> `git reflog` — the entry before the `merge` — rather than guessing.

The script stops and asks you to confirm before it migrates the database, and
takes a `pg_dump` to S3 first. Neither is optional theatre: they are the only
things standing between a bad migration and a payroll database you cannot
restore.

The second argument is the address Let's Encrypt uses to warn you if renewal
starts failing. It is optional, and you want it.

Use `tmux` (or `screen`). The script runs two Next builds; losing SSH partway
through a build is how you end up with a half-finished cutover.

What it does, in this order — the order is the entire point:

1. Resolves the hostname against 1.1.1.1 and refuses to continue unless it points
   at this box. Detects a Cloudflare proxy address and says so by name.
   Nothing has been modified at this point, so failing here costs nothing.
2. Confirms `http://<HOSTNAME>/` already answers, i.e. port 80 really is open.
   Like every other probe in the script, this one is pinned to this box's public
   IP with `curl --resolve`, so it cannot be answered by anything else.
3. Confirms there is ≥4 GB of disk free, because the cutover cannot finish
   without rebuilding both apps.
4. Reports **what else this deploy carries**: which commits have landed since the
   box last built (from `deploy/.deployed-commits`, or `ROLLBACK_TO_COMMIT`), and
   whether any of them touch `deploy/db`. If they do, it stops and makes you type
   `MIGRATE` — that DDL hits the live payroll database and no rollback undoes it.
   Then it takes a `pg_dump` to S3. All of this happens while nothing on the box
   has been changed yet, so aborting here is free.
5. Backs up both `.env.production` files, `deploy/site.env` and
   `/etc/caddy/Caddyfile`, and writes a rollback script.
6. Writes `deploy/site.env` with the hostname and regenerates
   `/etc/caddy/Caddyfile` **in staging form**: the pre-cutover `:80` catch-all is
   kept exactly as it is, and an `https://<HOSTNAME>` block is added *beside* it.
   Caddy starts obtaining the certificate while plain HTTP carries on serving
   both apps, and nothing redirects yet. See "Why the switch happens in two
   steps" below — this is the part that keeps the site up.
7. **Polls `https://<HOSTNAME>/` until a real, validating TLS handshake succeeds
   against this box** (up to 4 minutes) — `curl --resolve`-pinned to this box's
   public IP, and then the issuer is checked so Caddy's internal CA cannot pass
   for a real certificate. Both matter: an unpinned probe would be satisfied by
   *any* host on the internet holding a valid cert for that name (a Cloudflare
   proxy switched back on mid-cutover is the realistic case), which would green-
   light `COOKIE_SECURE=true` on a box that has no certificate at all — the
   lockout. If the handshake never succeeds, the script puts `deploy/site.env`
   and `/etc/caddy/Caddyfile` back **as they were immediately before this run**
   and stops. It does not touch `COOKIE_SECURE` — step 8 is what sets that.
   What that leaves behind depends on what the box was serving *before* the run,
   and the script reports which case you are in rather than assuming. On a first
   cutover it is plain HTTP on `http://<IP>/`, and logins keep working — unless
   `COOKIE_SECURE` was already `true` or blank before you started, in which case
   nobody could sign in before this run either and the script says so. On a
   **re-run over a box that is already on HTTPS, none of that holds**: see
   "If step 7 fails on a box that is already serving HTTPS" below.
8. Re-checks DNS one last time — it was verified in step 1, several minutes ago,
   and this is the last moment the cutover is undoable without a rebuild. Then
   renders the **final** Caddyfile (`:80` becomes a redirect; the app is served
   only over TLS from here on). The certificate already exists at this point, so
   that reload is an ordinary zero-downtime one. Then, *only then*, sets
   `COOKIE_SECURE=true`, `SITE_URL=https://<HOSTNAME>`,
   `NEXT_PUBLIC_LOGIN_URL` / `NEXT_PUBLIC_LOGOUT_URL=https://<HOSTNAME>/login`,
   and runs `install.sh` to rebuild and restart both apps under pm2.
9. **Invalidates every session that existed before the cutover** (step `[8b]`),
   by bumping `auth_users.session_version` for all users. See Step 6 — this is
   why everyone has to sign in again, and it is deliberate.
10. Verifies what it just claimed rather than asserting it: that
   `Strict-Transport-Security` is really being sent by **both** apps, and that
   the old plaintext address is no longer serving anything. If either check
   fails the cutover is still live and correct, and the script exits **3** with
   what to fix. Do not roll back for an exit 3.

### The switches you can pass it

All optional, all environment variables:

| | |
| --- | --- |
| `ROLLBACK_TO_COMMIT=<sha>` | lets the rollback script restore the **code**, not just the config. Needed once; `install.sh` records it from then on. |
| `CUTOVER_ACCEPT_MIGRATIONS=1` | pre-answers the `MIGRATE` prompt. Only after reading the `deploy/db` diff. |
| `SKIP_DB_BACKUP=1` | skips the pre-cutover `pg_dump`. Only if you have a fresh dump elsewhere. |
| `CUTOVER_LEGACY_HTTP_REDIRECT=1` | keeps `http://<old-IP>/` answering as a redirect. Off by default now — see "The raw-IP URL after the cutover". |
| `CUTOVER_ALLOW_APEX_HSTS=1` | overrides the apex refusal in Step 3. Still prompts. |
| `TLS_TIMEOUT=<seconds>` | how long to wait for Let's Encrypt (default 240). |

Exit codes: `0` clean · `1` stopped, with the site untouched or rolled back ·
`2` bad usage · `3` **the cutover succeeded** but a post-cutover security step
did not pass (fix it forward; rolling back would be a second full rebuild for
nothing).

It is safe to run twice. It regenerates the Caddyfile wholesale rather than
appending, so it cannot duplicate a site block, and every value it writes is
replace-or-append rather than accumulate. If it stops at step 1, 2 or 3, fix the
cause and just run it again.

### Why the switch happens in two steps

The obvious way to do step 6 is to render the final Caddyfile straight away and
then wait for the certificate. That takes the site down.

The final config has no plain-HTTP catch-all — that is the point of it. The
instant Caddy reloads it, and until Let's Encrypt answers:

| URL | what happens |
|---|---|
| `http://<IP>/` | 301 → `https://<HOSTNAME>/` → no certificate yet → dead |
| `http://<HOSTNAME>/` | 308 → `https://<HOSTNAME>/` (Caddy's own redirect) → dead |
| `https://<HOSTNAME>/` | no certificate yet → TLS handshake fails → dead |

So every URL is dead: ~10–30 s when issuance works, the full `TLS_TIMEOUT`
(4 min) when it does not, and **indefinitely** if the script is killed in
between, because then nothing runs the rollback. On the box that runs payroll,
that is an outage caused by the safety procedure.

The staged config avoids the window entirely rather than shortening it. During
step 6 the live config is:

```
:80 { ...both apps... }              # unchanged from before the cutover
https://<HOSTNAME> { ...both apps... }   # explicit scheme: no auto-redirect
```

Plain HTTP keeps serving throughout, and Caddy still answers the ACME HTTP-01
challenge on port 80 — it prepends the challenge routes ahead of the site's own
routes, so the catch-all cannot swallow them. Only after the handshake is proven
does step 8 install the redirect.

Waiting at the dots in step 7 is therefore safe to interrupt. It is also
belt-and-braces: the script traps `EXIT`, `INT`, `TERM` and `HUP`, so Ctrl-C, an
SSH drop without `tmux`, or the OOM killer restores the pre-cutover Caddyfile and
tells you what state the box is in. Use `tmux` anyway — the *builds* in step 8
are long, and that is where losing the session actually costs you.

### The trap this closes

`install.sh` used to copy `deploy/Caddyfile` over `/etc/caddy/Caddyfile` on every
run. If you had added the hostname by hand, the next deploy silently reverted the
box to plain HTTP and TLS vanished with it — while `COOKIE_SECURE=true` stayed
behind, which is the total-lockout scenario. The hostname now lives in
`deploy/site.env`, which `install.sh` *reads* and renders the Caddyfile from.
That file is git-ignored, so `git pull` cannot wipe it either.

Do not hand-edit `/etc/caddy/Caddyfile`; it is generated. To change the hostname
later, edit `deploy/site.env` and run `bash deploy/scripts/render-caddyfile.sh`.

The same trap survived one more place until recently: `deploy/scripts/setup.sh`
finished by printing
`sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`
as a step to run. `deploy/Caddyfile` is reference-only and is the plain `:80`
config, so on a box that has been cut over that command *is* the lockout, by
hand. That line is gone, and `setup.sh` now refuses to run at all on a box that
looks cut over (a hostname in `deploy/site.env`, `COOKIE_SECURE` not `false`, a
hostname block in the live Caddyfile, or the apps already under pm2), pointing
at `install.sh` instead. Rebuilding a box is the scenario where you are most
likely to reach for it.

### If you lose `deploy/site.env`

Being git-ignored is what protects it from `git pull` — and also what means it
does not exist on a rebuilt box, a fresh clone, or after `git clean -xdf`. That
matters because restoring `.env.production` from your own copy brings
`COOKIE_SECURE=true` back *without* bringing the hostname back, and that pair is
the total-lockout state: Caddy serves plain `:80`, the cookie demands HTTPS, and
nobody can sign in.

Two things now close that hole:

- `backup.sh` uploads the file nightly to
  `s3://<bucket>/site-config/site.env` (hostname, ACME email and old public IP
  only — no credentials). Get it back with:

  ```bash
  aws s3 cp s3://<bucket>/site-config/site.env deploy/site.env
  ```

  **Restore the cutover record too — not site.env on its own.**

  ```bash
  aws s3 cp s3://<bucket>/site-config/https-cutover-progress deploy/.https-cutover-progress
  ```

  `site.env` says the box serves a hostname. `.https-cutover-progress` says
  whether the pre-HTTPS sessions were ever revoked. Restore only the first and
  the box looks fully cut over while the evidence that step 8b is still
  outstanding is gone — `enable-https.sh` would then tell you no session has
  ever crossed plain HTTP, about a box whose old cookies are still valid. If the
  record really is unrecoverable, the script now says so in step 8b and prints
  the manual revoke command rather than asserting you are safe.

- `install.sh` **refuses to deploy** the lockout combination instead of warning
  and continuing. It stops before applying schema, building, reloading pm2 or
  re-rendering the Caddyfile, so a running site is untouched, and it prints the
  three ways out (restore the hostname / set `COOKIE_SECURE=false` / declare
  `TLS_TERMINATES_UPSTREAM=1` if an ALB or proxy terminates TLS in front).

### While it runs

The health watchdog (`deploy/scripts/monitor.sh`, cron, every 5 minutes) probes
`/api/health`, **restarts the app** on a failed probe, and emails
"APP IS DOWN" only if it is *still* failing 20 seconds after that restart.

**An alert during the cutover is not build noise. Do not dismiss it.** There is
no longer a rebuild window in which the app is legitimately unreachable:
`install.sh` builds into `.next.build` and swaps it in with two renames, so the
live `.next` is complete at every instant and each app is stale only for the few
seconds of its own reload. (The old flow moved `.next` aside and rebuilt in
place, which *did* take the app down for the whole build — that is the flow the
"expected during the rebuild" advice used to describe, and it is gone.)
`enable-https.sh` prints the same warning immediately before it calls
`install.sh`.

So if the watchdog fires during a cutover, the app is genuinely down — it failed
a probe, was restarted, and was still failing 20 seconds later — and the run
should be treated as a failed cutover. Look at what is actually running before
doing anything else:

```bash
pm2 status
pm2 logs ajace-timesheet   --lines 60 --nostream
pm2 logs ajace-procurement --lines 60 --nostream
```

Note that `monitor.sh` restarts the app on every failed probe, so a real fault
gets restarted underneath you and that email may be the only trace it left.

## Step 5 — Verify

The script runs its own checks first, and these two are the ones that used to be
*claimed* in the closing banner and never measured:

```
  HSTS on /                      -> max-age=31536000; includeSubDomains
  HSTS on /procurement           -> max-age=31536000; includeSubDomains
  http://<old-IP>/ (plaintext)   -> HTTP 308 https://<old-IP>/
```

- **`ABSENT` on either line is a real finding.** Both apps emit HSTS only if
  `COOKIE_SECURE === "true"` *at build time*, so a stale environment, a build
  that did not swap in, or a restart that did not happen all produce a working
  site with no HSTS and no complaint. If **procurement alone** is missing it,
  the cause is almost always that `install.sh` exports the *timesheet's*
  environment before building procurement, and Next will not let procurement's
  own `.env.production` override a key already present in the process
  environment — so procurement's HSTS follows the **timesheet's** file. Make the
  two agree and re-run `install.sh`.
- **A `2xx` on the plaintext line means the cutover moved nothing** and payroll
  is still being served without TLS.

Then, from a browser, confirm all seven:

1. `https://<HOSTNAME>/` — padlock, no warning. Click it: issuer should be
   **Let's Encrypt**. If it says *Caddy Local Authority*, ACME failed and Caddy
   fell back to its internal CA — treat that as a failed cutover.
2. Log in. DevTools → Application → Cookies → `https://<HOSTNAME>`. The
   `ts_session` cookie must read: `Secure ✓`, `HttpOnly ✓`, `SameSite Lax`,
   `Path /`, and **no** `Domain` value (or the hostname itself). Anything else in
   `Domain` means the cookie will not reach both apps.
3. Without logging in again, open `https://<HOSTNAME>/procurement`. The same
   session must carry straight through — no second login, no redirect loop. This
   is the whole reason for one hostname with paths.
4. Sign out from inside procurement. It must land on `https://<HOSTNAME>/login`,
   not `http://<old-IP>/login`.
5. Request a password reset for a test account and read the email. The link must
   begin `https://<HOSTNAME>/reset`. (If SES is not live yet, set
   `AUTH_LOG_RESET_LINKS=1` temporarily and read `pm2 logs ajace-timesheet` —
   then turn it back off: a live reset token in a log is a credential.)
6. Submit a form inside procurement (e.g. save a bid). Next 16 validates the
   request `Origin` against the forwarded `Host` for server actions, and this is
   the first time that path has ever run over HTTPS on this box.
7. From a private window, `http://<HOSTNAME>/` must redirect (301/308) to
   `https://<HOSTNAME>/`. And `http://<old-IP>/` must **fail** — see the next
   section; that is the intended end state, not a fault.

Also worth a look on the box:

```bash
sudo systemctl status caddy
sudo journalctl -u caddy --since '30 min ago' --no-pager | grep -i 'certificate\|error'
echo | openssl s_client -connect apps.yourdomain.com:443 -servername apps.yourdomain.com 2>/dev/null \
  | openssl x509 -noout -issuer -dates
pm2 status
# HSTS, from outside the app: both of these must print a max-age
curl -sSI https://apps.yourdomain.com/api/health        | grep -i strict-transport
curl -sSI https://apps.yourdomain.com/procurement/login | grep -i strict-transport
```

## The raw-IP URL after the cutover

**`http://<old-IP>/` stops working, and it is not coming back.** This is the one
thing in the cutover that deliberately *removes* something people were using, so
it is worth understanding before someone reports it as an outage.

What actually happens (measured against the generated config on Caddy 2.11.4,
not assumed):

| Request | Result |
| --- | --- |
| `http://<old-IP>/anything` | `308` to `https://<old-IP>/anything` — Caddy's automatic-HTTPS redirect on `:80` is a blanket, Host-preserving one; it does not 404 and it does not proxy |
| `https://<old-IP>/anything` | TLS handshake **fails**. There is no certificate for an IP address and there cannot be one |
| the two apps | receive **nothing**: zero requests reach ports 3009 or 3002 for any raw-IP request |

So the old address is a dead end. What a user sees is a browser TLS error, not a
redirect and not a tidy message. **Tell people the new URL before you cut over,
not after.**

### Why not just leave a redirect there?

Earlier versions of this script kept `http://<old-IP>/` alive as a `301` to the
new hostname, to soften old bookmarks. That cannot be made safe:

1. **A redirect does not prevent the request.** By the time Caddy answers, the
   browser has already put the old `ts_session` cookie on the wire in cleartext.
   Pre-cutover that cookie is host-scoped to the raw IP and issued *without*
   `Secure` (`lib/aws/auth.js`), so it is attached to the plain-HTTP request like
   any other. Whoever is on the same network has it.
2. **The redirect carries the query string.** `redir ... {uri}` preserves the
   full path and query, so an already-emailed
   `http://<old-IP>/reset?token=…` sends a live password-reset token in the
   clear — and the redirect then delivers the user to a working link, so nothing
   about the experience suggests anything went wrong.
3. **Its entire purpose is to keep people using the plaintext address.** That is
   not a leftover to clean up later; it is an invitation, and "later" never
   arrives.

Nothing on the box can stop that *first* cleartext request — the browser sends
it before any server is involved. What closes the hole is Step 6: every session
that could have been captured is invalidated as part of the cutover. The two go
together. Turning the old address into a dead end removes the reason to keep
hitting it; the session bump removes the value of anything captured on the way.

### If you genuinely need the grace period

Re-run with:

```bash
CUTOVER_LEGACY_HTTP_REDIRECT=1 \
  bash deploy/scripts/enable-https.sh apps.yourdomain.com you@yourdomain.com
```

`http://<old-IP>/` then `301`s to `https://<HOSTNAME>/` again, with everything
above still true of it. If you take that, treat it as **days, not months**: once
the bookmarks are updated, blank `LEGACY_HTTP_HOST` in `deploy/site.env` and run
`bash deploy/scripts/install.sh`. The script's own verification will keep
reminding you which mode the box is in.

## Step 6 — Everyone has to log in again. Say so in advance.

**Every user is signed out, and their old session is dead on the server.** Tell
people before you cut over, not after someone reports it as a bug. Nothing is
lost — no data, no password, no submitted hours. One sign-in each, at the new
address.

Two separate things make it true, and only the first is obvious:

1. **The origin changed.** The old cookie belongs to `http://<old-IP>`; a
   browser will not send it to `https://<HOSTNAME>`. This alone would have
   people logging in again.
2. **The cutover invalidates those sessions server-side** — step `[8b]` runs

   ```sql
   update public.auth_users set session_version = session_version + 1
   ```

   which is the same mechanism `set-password.sh` uses for "sign out
   everywhere". Both apps compare the `sv` claim in the token against this
   column on every request (`lib/aws/auth.js`, procurement's `src/proxy.ts`), so
   every token minted before the cutover stops being accepted immediately.

### Why the second one is not optional

Point 1 only stops *honest* browsers. The token itself does not care about
origins: it is a 7-day JWT with no origin or audience claim, and both apps
accept it anywhere as long as `session_version` matches. Until today this box
served payroll over plain HTTP on a raw IP, so **every session cookie in
existence was sent in the clear, on every request, without the `Secure` flag**.
Anyone who captured one — coffee-shop wifi, a hotel network, anything between a
user and the box — can replay it against the shiny new HTTPS site for up to
seven days. Moving to HTTPS does not retire a single one of them.

Bumping `session_version` is what actually ends the pre-cutover sessions. It is
cheap (one `UPDATE` on a table with about twenty rows, run with a `lock_timeout`
so it cannot stall payroll) and it is done once, at the only moment where
signing in again produces a `Secure` cookie over TLS.

It is **skipped** only when no session of this box's making can ever have
crossed plain HTTP — i.e. the box was already serving HTTPS when the cutover
began (a certificate repair, or a move between two hostnames), or the bump has
already been done for this hostname. Logging everyone out during what is usually
an emergency re-run would be gratuitous.

**What decides that is a persisted record, not `deploy/site.env`.** The script
writes `deploy/.https-cutover-progress` at step 5, before it touches anything,
and it is what a later run reads:

| Key | Means |
| --- | --- |
| `PRE_CUTOVER_HOST` | what this box served before the cutover began — empty means plain HTTP |
| `SESSIONS_NEED_REVOKE` | `1` until a bump has actually returned a row count |
| `SESSIONS_REVOKED_AT` / `_N` / `_HOST` | when the bump ran, for how many accounts, for which hostname |
| `CUTOVER_COMPLETED_AT` | a run reached a working HTTPS end state |

That indirection is the point. Step 6 writes the hostname into `deploy/site.env`
*before* step 8 runs `install.sh` — the longest and most failure-prone part of
the cutover on a 2 GB box — and a failed rebuild deliberately leaves the
hostname in place, because TLS is live and tearing it down would be the bigger
outage. So on the re-run `site.env` describes the script's *own unfinished
work*, and anything deriving "was this box already on HTTPS?" from it would skip
the revocation and announce that it was never needed, while every plain-HTTP
session stayed valid for its remaining seven days. `SESSIONS_NEED_REVOKE` only
goes to `0` on the strength of an `UPDATE` that came back with a count, so a
failed rebuild, a `Ctrl-C`, or a failed revocation all leave it set and the next
run does it.

The file is machine-local and git-ignored, like `deploy/site.env`. Do not delete
it while a cutover is unfinished — it is the only thing that knows the bump is
still outstanding. If it is missing, the script says so and falls back to
`site.env`; in that case do the revocation by hand with the statement below.

### If the script reports it could not revoke

You will see `✗ COULD NOT REVOKE PRE-CUTOVER SESSIONS` and the script will exit
`3`. **HTTPS is live and correct — do not roll back for this.** Run the
statement yourself; it takes a second:

```bash
cd ~/ajace-timesheet-aws
( set -a; . .env.production; set +a; \
  psql "$DATABASE_URL" -c \
    'update public.auth_users set session_version = session_version + 1' )
```

If it failed with `canceling statement due to lock timeout`, nothing was
changed — something was holding a lock on `auth_users`. Wait a moment and run it
again.

You do not have to remember to come back to it: `SESSIONS_NEED_REVOKE` stays `1`
in `deploy/.https-cutover-progress`, so the next run of `enable-https.sh` does
the bump. Running the statement by hand is simply faster than waiting for that.

Run it by hand for the same reason if the script told you it could not find
`deploy/.https-cutover-progress` while you were resuming an interrupted cutover
(the file was deleted, or the box was rebuilt). With no record, "was this box
already on HTTPS?" can only be read from `deploy/site.env` — which a previous
run may have written itself — and a bump you did not need costs one extra
sign-in, while one you skipped leaves every plain-HTTP session valid for a week.

### Everything else with the old URL in it

Bookmarks (see "The raw-IP URL after the cutover" — they now fail rather than
redirect), any password-reset emails already sent (those links are dead; have
people request a new one), and any external system that calls into these apps.

## Rolling back

The script prints the exact command; it looks like:

```bash
bash deploy/.https-rollback-20260726-141530.sh
```

Read its header before you run it — it states its own scope, for that specific
run. In general:

| | Rolled back? |
| --- | --- |
| Both `.env.production` files, `deploy/site.env`, `/etc/caddy/Caddyfile` | **Yes**, from the backups it took |
| The git checkout | **Yes, if** it knew the previous commit (`deploy/.deployed-commits`, or the `ROLLBACK_TO_COMMIT` you passed in step 4b). Otherwise **no**, and it says so |
| The database | **No. Never.** |

**Rollback is not instant.** The hostname is compiled into procurement's client
bundle (`NEXT_PUBLIC_LOGIN_URL` reaches `NextResponse.redirect()`, which requires
an absolute URL, so it cannot be made relative), so undoing it is another full
build — budget the same time again. Everyone has to log in again after a rollback
too.

**"Rolled back" means the state from immediately before *this run*, which is not
always plain HTTP.** On a first cutover the two are the same thing. On a **re-run
over a box that is already serving HTTPS** — a certificate repair, or a move
between two hostnames — the backups the script took at the top of that run *are*
the HTTPS configuration, and `COOKIE_SECURE` was already `true` before it
started. Rolling back therefore returns the box to HTTPS; it does not put it on
plain HTTP, and it does not by itself restore logins. The generated script's
header states which of the two cases it was written for. Read it first.

If the script stops *before* step 8 (the env flip), there is nothing to roll
back: it restores `/etc/caddy/Caddyfile` and `deploy/site.env` itself, and
`COOKIE_SECURE` was never touched. Whether the site is usable afterwards is the
same question as above — on a first cutover it is back on plain HTTP and
working; on a re-run it is back on the HTTPS config, which is only "working" if
that config still works.

### If step 7 fails on a box that is already serving HTTPS

The realistic version of this: TLS for the hostname the box already serves has
broken, the site is already down, you re-ran `enable-https.sh` to repair it —
and the handshake still does not come up.

Undoing the run does not help here, and the script now says so rather than
promising that logins keep working:

- `deploy/site.env` goes back to the same `SITE_HOSTNAME`
- `/etc/caddy/Caddyfile` goes back to the same HTTPS config
- `COOKIE_SECURE` is still `true` — the run never reached step 8, so that was
  already its value

and HSTS means browsers refuse plain `http://<HOSTNAME>` for up to a year, so
there is no fallback on that name. The rollback script is not the tool for this
either: it restores the state from before the run, and on this box that state is
an HTTPS configuration.

For this case, and only this case, the cutover writes an **emergency downgrade
script** beside itself and prints the path:

```bash
bash deploy/.https-emergency-plain-http-<stamp>.sh
```

It blanks `SITE_HOSTNAME` and `LEGACY_HTTP_HOST` in `deploy/site.env`, sets
`COOKIE_SECURE=false` in **both** `.env.production` files (which also drops the
HSTS header from both bundles — both `next.config` files gate it on that string
at build time), points `SITE_URL` and procurement's `NEXT_PUBLIC_LOGIN_URL` /
`NEXT_PUBLIC_LOGOUT_URL` back at `http://<IP>`, and runs `install.sh`. Both apps
come back on `http://<IP>/` and `http://<IP>/procurement` — the one URL HSTS
cannot block, because an IP address can never be an HSTS host.

Budget a full rebuild of both apps; everyone signs in again. It is a stopgap for
staff who have to be paid today: fix the certificate or the DNS record, then run
`enable-https.sh` again.

If the run was *moving* the box from one hostname to another and only the new
name failed, the old one was restored untouched — check whether it is still
serving before treating this as an outage. The script prints the exact
`curl --resolve` command for that.

### The database is not rolled back

`install.sh` applies `deploy/db/schema.sql` (and procurement's) to the live
payroll database on **every** run, cutover or not. Re-running an older schema
file does not un-apply the newer one — and can fail outright, because a re-added
`CHECK` constraint has to validate rows the newer code already wrote.

So if the rollback also restores an older commit, expect `install.sh` to stop at
the schema step with a constraint violation. That is the honest failure, not a
new bug: the database has moved forward and the code you are rolling back to
does not know about it. Fix forward from there, or restore the dump.

The cutover takes a `pg_dump` to S3 before it migrates anything, and prints the
key. Rehearse any restore into a scratch database first:

```bash
bash deploy/scripts/restore.sh                       # list what is in S3
bash deploy/scripts/restore.sh ts-db-<stamp>.sql.gz  # scratch copy, live data untouched
```

Only add `--live` as a genuine last resort: it discards every row written since
the dump, which on this box means submitted timesheets.

### Why the cutover asks before migrating

`deploy/db/schema.sql` is not free to re-run. It contains drop-then-add
`CONSTRAINT` pairs (Postgres has no `add constraint if not exists`, so the ADD
re-validates every row) and drop-then-create `TRIGGER` pairs. Each takes
`ACCESS EXCLUSIVE` on a payroll table, and a request for that lock **queues ahead
of every read and write behind it** — so DDL waiting on one open transaction
stalls both apps for as long as that transaction lasts.

`install.sh` now runs both schema files with `lock_timeout` (5s by default,
`DB_LOCK_TIMEOUT` to override), so a deploy that cannot get the lock fails fast
and changes nothing instead of freezing payroll. If you see
`canceling statement due to lock timeout`, nothing was applied — re-run when the
database is quiet.

### One thing rollback does not undo: HSTS

Once `COOKIE_SECURE=true`, both apps send

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Every browser that has successfully loaded `https://<HOSTNAME>` will refuse
plain HTTP to that hostname **for a year**, regardless of what the server later
says. There is no `preload` directive, so it is per-browser and clearable
(`chrome://net-internals/#hsts`), but it means you cannot fall back to HTTP as a
quick workaround if TLS breaks later. Fixing TLS is the only path forward from
there — which is why port 80 must stay open and why the ACME email is worth
setting.

**Read `includeSubDomains` before you decide it does not concern you.** The
scope is the name in the address bar, so on `apps.yourdomain.com` this covers
that name and anything under it — and on the apex it would cover every host in
the domain, including hosts this box has never heard of. That is why Step 3
insists on a subdomain and why `enable-https.sh` refuses an apex outright: the
header is baked into both Next builds and is not parameterised by hostname, so
there is no version of this cutover where an apex ships a narrower header.

The rollback restores config, and (if it knows the commit) code. It cannot
retract a header that browsers have already stored. Of everything in this
runbook, the hostname is the choice with the longest tail.

### The other thing rollback does not undo: the session bump

Step 6's `session_version` bump is not reversed by the rollback script either.
That is harmless — the effect is one more sign-in, on whichever URL the box ends
up serving — but it is worth knowing that rolling back does not restore anyone's
session.

## Reference

| What | Where |
| --- | --- |
| Persisted hostname / ACME email | `deploy/site.env` (git-ignored; template: `deploy/site.env.example`) |
| Commits this box last built | `deploy/.deployed-commits` (git-ignored; written by `install.sh`, read by the cutover to make rollback restore code) |
| What the cutover actually did | `deploy/.https-cutover-progress` (git-ignored; `SESSIONS_NEED_REVOKE` is the only record that step `[8b]` is still outstanding — do not delete it mid-cutover) |
| Caddyfile generator | `deploy/scripts/render-caddyfile.sh` → `/etc/caddy/Caddyfile` |
| Cutover script | `deploy/scripts/enable-https.sh` |
| Rollback script (written per run) | `deploy/.https-rollback-<stamp>.sh` — restores the state from before *that* run |
| Emergency downgrade to plain HTTP | `deploy/.https-emergency-plain-http-<stamp>.sh` — written only when TLS fails on a box that was already on HTTPS |
| Schema applied on every deploy | `deploy/db/schema.sql` + `procurement/deploy/db/schema.sql` → `install.sh` step [4] / [5b] |
| DB backup / restore | `deploy/scripts/backup.sh`, `deploy/scripts/restore.sh` |
| Old raw-IP redirect (off by default) | `LEGACY_HTTP_HOST` in `deploy/site.env`; set it with `CUTOVER_LEGACY_HTTP_REDIRECT=1` |
| Session revocation | `auth_users.session_version` → `lib/aws/auth.js`, procurement `src/proxy.ts`; also bumped by `deploy/scripts/set-password.sh` |
| Cookie options | `lib/aws/auth.js` (`cookieBase()`) |
| Reset-link URL | `SITE_URL` → `app/api/auth/forgot/route.js` |
| Procurement redirects | `NEXT_PUBLIC_LOGIN_URL` / `NEXT_PUBLIC_LOGOUT_URL` → `src/proxy.ts`, `src/app/auth/signout/route.ts` |
| HSTS gate | `next.config.js` and procurement `next.config.ts`, both on `COOKIE_SECURE === "true"` |
