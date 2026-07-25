import { NextResponse } from "next/server";
import { queryOne } from "@/lib/aws/db";
import { verifyPassword, signSession, setSessionCookie } from "@/lib/aws/auth";

export const runtime = "nodejs";

export async function POST(request) {
  const { email, password } = await request.json().catch(() => ({}));
  // role comes from ts_profiles (source of truth for admin), falling back to auth_users
  const row = await queryOne(
    `select u.id, u.email, u.password_hash, coalesce(p.role, u.role, 'employee') as role
       from public.auth_users u
       left join public.ts_profiles p on p.id = u.id
      where lower(u.email) = lower($1)`,
    [email || ""]
  );
  if (!row || !(await verifyPassword(password || "", row.password_hash))) {
    return NextResponse.json({ error: "invalid email or password" }, { status: 400 });
  }
  const user = { id: row.id, email: row.email, role: row.role };
  await setSessionCookie(await signSession(user));
  return NextResponse.json({ user });
}
