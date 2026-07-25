import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { putObject } from "@/lib/aws/storage";
import { isAllowedExtension, ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, serveHeadersFor } from "@/lib/aws/filetypes";

export const runtime = "nodejs";

// Browser POSTs the file here (multipart); the server writes it to S3 with the
// instance role. No presigned URL, so no S3 CORS and no client-side checksum.
// Owners may only write under their own {userId}/... prefix; admins anywhere.
export async function POST(request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const path = String(form?.get("path") || "");
  const file = form?.get("file");
  if (!path || !file || typeof file === "string")
    return NextResponse.json({ error: "file and path required" }, { status: 400 });

  // Reject traversal and absolute keys outright.
  if (path.includes("..") || path.startsWith("/"))
    return NextResponse.json({ error: "invalid path" }, { status: 400 });

  const owner = path.split("/")[0];
  if (owner !== user.id && user.role !== "admin")
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Type allowlist by EXTENSION. The browser-supplied MIME is not trusted: an
  // .html upload served back on this origin would execute as the viewing admin.
  if (!isAllowedExtension(path)) {
    return NextResponse.json(
      { error: `That file type isn't supported. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` },
      { status: 400 }
    );
  }
  const tooBig = { error: `That file is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` };
  if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(tooBig, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) return NextResponse.json(tooBig, { status: 413 });

  // Store under the type our own extension table dictates, not the client's.
  const contentType = serveHeadersFor(path)["Content-Type"];
  await putObject(path, buf, contentType);
  return NextResponse.json({ path });
}
