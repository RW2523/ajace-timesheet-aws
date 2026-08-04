import { currentUser } from "@/lib/aws/auth";
import { getObjectBytes } from "@/lib/aws/storage";
import { serveHeadersFor, isInlineServable } from "@/lib/aws/filetypes";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";

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

  // Record only cross-user access: an admin opening an employee's document.
  if (owner !== user.id) {
    await audit({ actor: user, action: "file.read", subjectId: owner,
                  detail: { path }, ip: clientIp(request) });
  }

  try {
    const { bytes } = await getObjectBytes(path);
    // Content-Type comes from OUR extension table, never from the stored object
    // metadata — a file uploaded as text/html would otherwise execute on this
    // origin with the viewing admin's session. Anything not safely renderable
    // is sent as an attachment; nosniff stops the browser second-guessing us,
    // and the sandbox CSP neutralises anything that slips through.
    //
    // `allow-scripts` for the inline types ONLY, because the in-browser PDF
    // viewers (Chrome's PDFium frame, Firefox's pdf.js) are script-driven: a
    // bare `sandbox` renders a PDF as a blank page, which is exactly how the
    // admin preview looked. The response is still in an OPAQUE ORIGIN — no
    // `allow-same-origin`, so it cannot read this app's cookies, storage or
    // DOM — and `default-src 'none'` blocks every subresource and every
    // outbound connection it could make.
    //
    // This reasoning holds only while nothing SCRIPTABLE is inline-servable.
    // The inline set is pdf + png/jpeg/webp/gif; html and svg are deliberately
    // absent from the type table (see lib/aws/filetypes.js). If either is ever
    // added there, this header must go back to a bare `sandbox` first.
    const inline = isInlineServable(path);
    return new Response(bytes, {
      headers: {
        ...serveHeadersFor(path, url.searchParams.get("name")),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": inline
          ? "default-src 'none'; sandbox allow-scripts"
          : "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    // A storage_path recorded for an object that never landed in S3 (or was
    // removed by hand) must be a clean 404, not a 500 the caller has to parse.
    console.warn(`[storage] could not read ${path}:`, e?.message || e);
    return new Response("not found", { status: 404 });
  }
}
