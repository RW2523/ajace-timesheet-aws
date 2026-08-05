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

export async function signSession({ id, email, role, session_version }) {
  return new SignJWT({ email, role, sv: session_version ?? 1 })
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
    // Everything below is signed with the SAME secret, so a token minted for
    // another purpose (the AI verdict receipt) would otherwise verify here and
    // stand in for a session. An audience claim means "not a session cookie".
    if (payload.aud) return null;
    return { id: payload.sub, email: payload.email, role: payload.role || "employee",
             sv: payload.sv ?? 1 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE AI VERDICT RECEIPT
//
// `fields.review_status` is the AI's verdict on ONE extraction. It is computed
// on the server (/api/process) but reaches the database THROUGH THE BROWSER,
// which used to make it simply whatever the browser said: any employee could
// POST /api/data with fields.review_status:"auto_accepted" beside hours they
// typed themselves, and the row wore "AI found no problems" in the admin queue.
//
// So /api/process hands back a signed receipt for its own verdict, bound to the
// user it ran for, and lib/aws/data.js takes the verdict FROM THE RECEIPT — the
// review_status sitting next to it in the payload is ignored. Same shape of
// rule as the money guard: the number of record is derived, never accepted.
const AI_AUD = "ts:ai-verdict";

export async function signAiVerdict({ userId, reviewStatus, flow }) {
  return new SignJWT({ rs: reviewStatus ?? null, flow: flow ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setAudience(AI_AUD)
    .setIssuedAt()
    .setExpirationTime("7d")   // matches the session; an expired one just means "no AI ran"
    .sign(secret());
}

// -> { reviewStatus, flow } or null.
// `userId` MUST be the user performing the write: a receipt is proof that the
// AI ran for THAT person, not a bearer token anyone holding it can staple onto
// their own submission.
export async function readAiVerdict(token, userId) {
  if (!token || typeof token !== "string" || !userId) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AI_AUD });
    if (!payload.sub || payload.sub !== String(userId)) return null;
    return { reviewStatus: payload.rs ?? null, flow: payload.flow ?? null };
  } catch {
    return null;
  }
}
