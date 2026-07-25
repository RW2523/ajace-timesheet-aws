import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/aws/db";
import { hashPassword } from "@/lib/aws/auth";
import { passwordProblem } from "@/lib/aws/password";
import { rateLimit, clientIp } from "@/lib/aws/ratelimit";

export const runtime = "nodejs";

export async function POST(request) {
  const ip = clientIp(request);
  // Reset tokens are 32 random bytes, but throttle guessing anyway.
  const rl = rateLimit(`reset:ip:${ip}`, { limit: 15, windowMs: 15 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { token, password } = await request.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  // Same policy as signup — otherwise reset is a bypass for the password rules.
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  // Consuming the token in the UPDATE (rather than select-then-update) makes it
  // single-use even if two requests race.
  // Bumping session_version is what makes a reset actually lock an attacker
  // out: without it their existing 7-day cookie would keep working.
  const updated = await queryOne(
    `update public.auth_users
        set password_hash=$1, reset_token=null, reset_expires=null,
            session_version = session_version + 1
      where reset_token=$2 and reset_expires > now()
      returning id, email`,
    [await hashPassword(password), token]
  );
  if (!updated) {
    return NextResponse.json({ error: "this reset link is invalid or has expired" }, { status: 400 });
  }
  console.warn(`[auth] password reset completed for ${updated.email} ip=${ip}`);
  return NextResponse.json({ ok: true });
}
