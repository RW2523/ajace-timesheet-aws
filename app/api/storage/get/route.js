import { currentUser } from "@/lib/aws/auth";
import { getObjectBytes } from "@/lib/aws/storage";
import { serveHeadersFor } from "@/lib/aws/filetypes";

export const runtime = "nodejs";

// Streams a stored file back through the app (same-origin → no S3 CORS).
// Owners may read their own {userId}/... files; admins may read anything.
export async function GET(request) {
  const user = await currentUser();
  if (!user) return new Response("not authenticated", { status: 401 });

  const url = new URL(request.url);
  const path = url.searchParams.get("path") || "";
  if (!path || path.includes("..") || path.startsWith("/"))
    return new Response("invalid path", { status: 400 });

  const owner = path.split("/")[0];
  if (owner !== user.id && user.role !== "admin")
    return new Response("forbidden", { status: 403 });

  try {
    const { bytes } = await getObjectBytes(path);
    // Content-Type comes from OUR extension table, never from the stored object
    // metadata — a file uploaded as text/html would otherwise execute on this
    // origin with the viewing admin's session. Anything not safely renderable
    // is sent as an attachment; nosniff stops the browser second-guessing us,
    // and the sandbox CSP neutralises anything that slips through.
    return new Response(bytes, {
      headers: {
        ...serveHeadersFor(path, url.searchParams.get("name")),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
