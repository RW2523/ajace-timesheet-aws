import { NextResponse } from "next/server";
import { queryOne } from "@/lib/aws/db";
import { verifyPassword, signSession, setSessionCookie } from "@/lib/aws/auth";
import { rateLimit, rateLimitReset, clientIp } from "@/lib/aws/ratelimit";

export const runtime = "nodejs";

// Two independent limits: per-IP (one attacker spraying many accounts) and
// per-account (a botnet targeting one account). Both must pass.
const IP_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };
const ACCOUNT_LIMIT = { limit: 8, windowMs: 15 * 60 * 1000 };

export async function POST(request) {
  const { email, password } = await request.json().catch(() => ({}));
  const ip = clientIp(request);
  const account = String(email || "").trim().toLowerCase();

  const byIp = rateLimit(`login:ip:${ip}`, IP_LIMIT);
  const byAccount = rateLimit(`login:acct:${account}`, ACCOUNT_LIMIT);
  if (!byIp.ok || !byAccount.ok) {
    const retryAfter = Math.max(byIp.retryAfter, byAccount.retryAfter);
    console.warn(`[auth] login throttled ip=${ip} account=${account}`);
    return NextResponse.json(
      { error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // role comes from ts_profiles (source of truth for admin), falling back to auth_users
  const row = await queryOne(
    `select u.id, u.email, u.password_hash, u.session_version,
            coalesce(p.role, u.role, 'employee') as role,
            coalesce(p.active, true) as active
       from public.auth_users u
       left join public.ts_profiles p on p.id = u.id
      where lower(u.email) = lower($1)`,
    [account]
  );
  if (!row || !(await verifyPassword(password || "", row.password_hash))) {
    // Logged so repeated failures are visible in `pm2 logs`. Never log the password.
    console.warn(`[auth] failed login ip=${ip} account=${account}`);
    return NextResponse.json({ error: "invalid email or password" }, { status: 400 });
  }

  if (row.active === false) {
    console.warn(`[auth] login refused for deactivated account ${account}`);
    return NextResponse.json({ error: "This account has been deactivated." }, { status: 403 });
  }
  rateLimitReset(`login:acct:${account}`);
  const user = { id: row.id, email: row.email, role: row.role, session_version: row.session_version };
  await setSessionCookie(await signSession(user));
  return NextResponse.json({ user });
}
