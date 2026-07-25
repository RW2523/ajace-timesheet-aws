import { NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/aws/jwt";

// Edge-safe route guard: verify the session JWT cookie and gate routes.
// (jose only — no bcrypt / no next/headers — so it runs in the Edge runtime.)
export async function updateSession(request) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const user = await verifySession(token);

  const path = request.nextUrl.pathname;
  const isAuthPage = path.startsWith("/login") || path.startsWith("/signup");
  const isProtected = path.startsWith("/dashboard") || path.startsWith("/admin");

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request });
}
