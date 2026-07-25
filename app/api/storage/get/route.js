import { currentUser } from "@/lib/aws/auth";
import { getObjectBytes } from "@/lib/aws/storage";

export const runtime = "nodejs";

// Streams a stored file back through the app (same-origin → no S3 CORS).
// Owners may read their own {userId}/... files; admins may read anything.
export async function GET(request) {
  const user = await currentUser();
  if (!user) return new Response("not authenticated", { status: 401 });

  const path = new URL(request.url).searchParams.get("path") || "";
  if (!path) return new Response("path required", { status: 400 });

  const owner = path.split("/")[0];
  if (owner !== user.id && user.role !== "admin")
    return new Response("forbidden", { status: 403 });

  try {
    const { bytes, contentType } = await getObjectBytes(path);
    return new Response(bytes, {
      headers: { "Content-Type": contentType, "Content-Disposition": "inline", "Cache-Control": "private, max-age=60" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
