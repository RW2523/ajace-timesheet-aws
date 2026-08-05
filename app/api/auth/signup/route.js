import { NextResponse } from "next/server";
import { pool, queryOne } from "@/lib/aws/db";
import { hashPassword, signSession, setSessionCookie } from "@/lib/aws/auth";
import { rateLimit, clientIp } from "@/lib/aws/ratelimit";
import { passwordProblem } from "@/lib/aws/password";
import { hasNonAscii, emailShapeProblem } from "@/lib/roster";

export const runtime = "nodejs";

// Signup is CLOSED by default. Previously any visitor on the internet could
// create an account on the payroll system. Eligibility is now decided by
//   SIGNUP_ALLOWED_DOMAINS=ajace.com,contractor.example
// with one exception: while there are no users at all, the first signup is
// allowed and becomes the admin, so a fresh deployment can be bootstrapped.
function allowedDomains() {
  return (process.env.SIGNUP_ALLOWED_DOMAINS || "")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export async function POST(request) {
  const ip = clientIp(request);
  // Account creation is expensive (bcrypt) and abusable; cap it hard.
  const rl = rateLimit(`signup:ip:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many sign-up attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  const { email, password, meta = {} } = await request.json().catch(() => ({}));
  const addr = String(email || "").trim().toLowerCase();
  // THE SAME ADDRESS RULE AS /api/admin/people, and for a stronger reason.
  //
  // This route used to accept /^[^@\s]+@[^@\s]+\.[^@\s]+$/, and JavaScript's \s
  // does not match zero-width or format characters — so "no<U+200B>ra@ajace.com"
  // was a distinct account beside "nora@ajace.com", visually identical in the
  // review queue and the payroll CSV. Over there the twin at least cannot log in
  // (it carries the unusable-password marker); an account minted HERE chooses its
  // own password and is fully usable, so admitting a look-alike here is worse.
  //
  // The domain allow-list below is not a defence against it: a look-alike in the
  // LOCAL part leaves the domain untouched and sails through.
  if (!addr || hasNonAscii(addr) || emailShapeProblem(addr)) {
    return NextResponse.json({ error: "A valid work email is required." }, { status: 400 });
  }
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  // Bootstrap: the very first account may always be created, and becomes admin
  // so there is no chicken-and-egg problem on a fresh deployment.
  const first = await queryOne(`select count(*)::int as count from public.auth_users`);
  const isFirstUser = (first?.count ?? 0) === 0;

  if (!isFirstUser) {
    const domains = allowedDomains();
    const domain = addr.split("@")[1];
    if (!domains.length) {
      return NextResponse.json(
        { error: "Sign-up is closed. Ask your administrator to create your account." },
        { status: 403 }
      );
    }
    if (!domains.includes(domain)) {
      // Deliberately does not reveal which domains are permitted.
      return NextResponse.json(
        { error: "This email address isn't eligible to sign up. Contact your administrator." },
        { status: 403 }
      );
    }
  }

  const existing = await queryOne(`select id from public.auth_users where lower(email)=lower($1)`, [addr]);
  if (existing) return NextResponse.json({ error: "an account with that email already exists" }, { status: 400 });

  const role = isFirstUser ? "admin" : "employee";
  const hash = await hashPassword(password);

  // THE LOGIN AND THE PROFILE ARE ONE ACT, so they are ONE TRANSACTION.
  // These used to be two independent statements: if the second failed (a bad
  // `meta` value, a dropped connection, a restart between the two), the account
  // still existed and could log in and submit hours — but had no ts_profiles
  // row, and payroll reporting is keyed on that row. The result was an employee
  // who could work all month and then be missing from the export entirely.
  // Either both rows exist or neither does.
  const client = await pool().connect();
  let u;
  try {
    await client.query("begin");
    u = (await client.query(
      `insert into public.auth_users (email, password_hash, role) values ($1,$2,$3)
       returning id, email, role`,
      [addr, hash, role]
    )).rows[0];
    // provision the timesheet profile
    await client.query(
      `insert into public.ts_profiles
         (id,email,full_name,phone,role,employer,client,job_title,employee_code,country,manager_name,manager_email)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,'US'),$11,$12)
       on conflict (id) do nothing`,
      [u.id, addr, meta.full_name || "", meta.phone || null, role, meta.employer || null,
       meta.client || null, meta.job_title || null, meta.employee_code || null,
       meta.country || "US", meta.manager_name || null, meta.manager_email || null]
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("[auth] signup failed, nothing was created:", e?.message || e);
    return NextResponse.json(
      { error: "Couldn't create the account. Please try again." },
      { status: 500 }
    );
  } finally {
    client.release();
  }
  if (isFirstUser) console.warn(`[auth] bootstrap: first account ${addr} created as ADMIN`);

  await setSessionCookie(await signSession(u));
  return NextResponse.json({ user: u });
}
