// Node-runtime auth helpers (passwords + cookie session). Imports next/headers
// and bcrypt, so use ONLY in route handlers / server components — never Edge.
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { SESSION_COOKIE, signSession, verifySession } from "./jwt.js";
import { queryOne } from "./db.js";

export { SESSION_COOKIE, signSession, verifySession };

const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

function cookieBase() {
  const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  // `secure` cookies are only sent over HTTPS. Set COOKIE_SECURE=false when
  // serving over plain HTTP (e.g. the raw EC2 URL with no domain/TLS yet),
  // otherwise login silently fails because the cookie never comes back.
  const secure = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    ...(domain ? { domain } : {}),
  };
}

export async function setSessionCookie(token) {
  (await cookies()).set(SESSION_COOKIE, token, { ...cookieBase(), maxAge: MAX_AGE });
}
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, "", { ...cookieBase(), maxAge: 0 });
}

// Current logged-in user from the cookie, or null.
// The ROLE is re-read from the database on every call rather than trusted from
// the 7-day JWT: otherwise promoting someone with make-admin.sh has no effect
// until they manually log out and back in (admin storage/reads would 403/404),
// and a demoted admin would keep admin powers until their token expired.
export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = await verifySession(token);
  if (!claims) return null;
  try {
    const row = await queryOne(
      `select u.id, u.email, coalesce(p.role, u.role, 'employee') as role
         from public.auth_users u
         left join public.ts_profiles p on p.id = u.id
        where u.id = $1`,
      [claims.id]
    );
    if (!row) return null; // user deleted -> session is no longer valid
    return { id: row.id, email: row.email, role: row.role };
  } catch {
    // DB blip: stay authenticated but fail CLOSED on privilege
    return { ...claims, role: "employee" };
  }
}
