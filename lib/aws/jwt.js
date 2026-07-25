// Edge-safe session token (used by middleware AND node routes). `jose` only —
// no bcrypt, no next/headers — so it loads in the Edge runtime.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ts_session";

// Lazy (never at module scope: middleware + every route imports this, and a
// module-level throw would fail `next build`). In production a missing, short,
// or still-placeholder secret is fatal — otherwise sessions would be signed
// with a value published in this repo and anyone could mint an admin cookie.
const DEV_FALLBACK = "dev-insecure-change-me-please-32bytes!!";
let cached;
const secret = () => {
  if (cached) return cached;
  const s = process.env.AUTH_JWT_SECRET;
  if (!s || s.length < 32 || s.startsWith("CHANGE_ME")) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_JWT_SECRET is missing, under 32 chars, or still the placeholder — refusing to sign/verify sessions."
      );
    }
    cached = new TextEncoder().encode(DEV_FALLBACK); // dev only
    return cached;
  }
  cached = new TextEncoder().encode(s);
  return cached;
};

export async function signSession({ id, email, role }) {
  return new SignJWT({ email, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

// -> { id, email, role } or null
export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { id: payload.sub, email: payload.email, role: payload.role || "employee" };
  } catch {
    return null;
  }
}
