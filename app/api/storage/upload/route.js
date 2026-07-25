import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { putObject } from "@/lib/aws/storage";

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

  const owner = path.split("/")[0];
  if (owner !== user.id && user.role !== "admin")
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const buf = Buffer.from(await file.arrayBuffer());
  await putObject(path, buf, file.type || "application/octet-stream");
  return NextResponse.json({ path });
}
