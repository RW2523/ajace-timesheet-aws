import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/aws/db";
import { hashPassword } from "@/lib/aws/auth";

export const runtime = "nodejs";

export async function POST(request) {
  const { token, password } = await request.json().catch(() => ({}));
  if (!token || !password || password.length < 6) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const u = await queryOne(
    `select id from public.auth_users where reset_token=$1 and reset_expires > now()`,
    [token]
  );
  if (!u) return NextResponse.json({ error: "this reset link is invalid or has expired" }, { status: 400 });

  await query(
    `update public.auth_users set password_hash=$1, reset_token=null, reset_expires=null where id=$2`,
    [await hashPassword(password), u.id]
  );
  return NextResponse.json({ ok: true });
}
