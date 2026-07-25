import { updateSession } from "@/lib/api/middleware";

export async function middleware(request) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // run on everything except static assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
