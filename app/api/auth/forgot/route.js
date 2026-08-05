import { NextResponse } from "next/server";
import crypto from "crypto";
import { query, queryOne } from "@/lib/aws/db";
import { sendPasswordReset, emailEnabled } from "@/lib/aws/email";
import { isUnusablePassword } from "@/lib/aws/people";

export const runtime = "nodejs";

// Issues a one-hour reset token and emails the link via Amazon SES.
// The response never reveals whether the address exists (no account-enumeration
// oracle); `emailConfigured` is a config-level constant, identical for everyone,
// so the UI can stop claiming "check your inbox" when SES isn't set up yet.
export async function POST(request) {
  const { email } = await request.json().catch(() => ({}));
  const canEmail = emailEnabled();

  const u = await queryOne(
    `select id, email, password_hash from public.auth_users where lower(email)=lower($1)`,
    [email || ""]
  );
  // A payroll-only record (added by admin/HR so hours could be filed) has an
  // unusable password marker, not a hash. "Forgot password" MUST NOT be able to
  // turn one into a working login: nobody has verified that the person holding
  // that mailbox is the person on the payroll record, so issuing a token would
  // make control of an inbox sufficient to obtain an account on the payroll
  // system — and the address was typed by whoever added them, in a hurry.
  //
  // Refusing HERE as well as in /api/auth/reset is the point: reset consumes a
  // token, so if one is never minted the second gate is never even reached. No
  // reset_token is written, so the row is untouched.
  //
  // Activation stays a deliberate operator act: deploy/scripts/set-password.sh.
  // The response is the same {ok:true} everyone else gets — this branch must not
  // become an oracle for "which addresses are registered but dormant".
  if (u && isUnusablePassword(u.password_hash)) {
    console.warn(`[auth] reset refused: ${u.email} is a payroll-only record with no password set`);
    return NextResponse.json({ ok: true, emailConfigured: canEmail });
  }
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
