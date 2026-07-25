import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/aws/db";
import { hashPassword, signSession, setSessionCookie } from "@/lib/aws/auth";

export const runtime = "nodejs";

export async function POST(request) {
  const { email, password, meta = {} } = await request.json().catch(() => ({}));
  if (!email || !password || password.length < 6) {
    return NextResponse.json({ error: "email and a 6+ character password are required" }, { status: 400 });
  }
  const existing = await queryOne(`select id from public.auth_users where lower(email)=lower($1)`, [email]);
  if (existing) return NextResponse.json({ error: "an account with that email already exists" }, { status: 400 });

  const hash = await hashPassword(password);
  const u = await queryOne(
    `insert into public.auth_users (email, password_hash, role) values ($1,$2,'employee')
     returning id, email, role`,
    [email, hash]
  );
  // provision the timesheet profile (mirrors the old ts_handle_new_user trigger)
  await query(
    `insert into public.ts_profiles
       (id,email,full_name,phone,role,employer,client,job_title,employee_code,country,manager_name,manager_email)
     values ($1,$2,$3,$4,'employee',$5,$6,$7,$8,coalesce($9,'US'),$10,$11)
     on conflict (id) do nothing`,
    [u.id, email, meta.full_name || "", meta.phone || null, meta.employer || null,
     meta.client || null, meta.job_title || null, meta.employee_code || null,
     meta.country || "US", meta.manager_name || null, meta.manager_email || null]
  );

  await setSessionCookie(await signSession(u));
  return NextResponse.json({ user: u });
}
