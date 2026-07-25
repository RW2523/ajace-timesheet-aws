import { NextResponse } from "next/server";
import crypto from "crypto";
import { query, queryOne } from "@/lib/aws/db";
import { sendPasswordReset, emailEnabled } from "@/lib/aws/email";

export const runtime = "nodejs";

// Issues a one-hour reset token and emails the link via Amazon SES.
// The response never reveals whether the address exists (no account-enumeration
// oracle); `emailConfigured` is a config-level constant, identical for everyone,
// so the UI can stop claiming "check your inbox" when SES isn't set up yet.
export async function POST(request) {
  const { email } = await request.json().catch(() => ({}));
  const canEmail = emailEnabled();

  const u = await queryOne(`select id, email from public.auth_users where lower(email)=lower($1)`, [email || ""]);
  if (u) {
    const token = crypto.randomBytes(32).toString("hex");
    await query(
      `update public.auth_users set reset_token=$1, reset_expires=now()+interval '1 hour' where id=$2`,
      [token, u.id]
    );
    const link = `${process.env.SITE_URL || ""}/reset?token=${token}`;
    let delivered = false;
    try {
      if (canEmail) { await sendPasswordReset(u.email, link); delivered = true; }
    } catch (e) {
      console.error("SES send failed:", e?.message || e);
    }
    // Opt-in fallback so an operator can still recover an account before SES is
    // live. Off by default: a live reset token in the logs is a credential.
    if (!delivered && process.env.AUTH_LOG_RESET_LINKS === "1") {
      console.warn(`[password reset] ${u.email} -> ${link}`);
    }
  }
  return NextResponse.json({ ok: true, emailConfigured: canEmail });
}
