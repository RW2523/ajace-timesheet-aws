import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { previewUpload } from "@/lib/engine";
import { renderOfficePreview, isOfficePreviewable } from "@/lib/aws/officepreview";

export const maxDuration = 120;

// Admin-only: download a stored source file and render it to page images (any
// format -> PDF -> PNGs via the engine) so an admin can verify a submission
// against the original document.
export async function POST(request) {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { data: prof } = await api
    .from("ts_profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const path = body?.path;
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });

  const fileName = path.split("/").pop() || "document";
  const ext = fileName.split(".").pop().toLowerCase();
  const IMG = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
  const kind = ext === "pdf" ? "pdf" : IMG.includes(ext) ? "image" : "other";

  // PDFs and images render natively in the browser -- hand back a short-lived
  // signed URL instead of engine-rendered PNGs (works with no engine at all).
  // Office files still need the engine's renderer; without one, return the
  // signed URL as a download so the admin can open the original.
  // Office files: fetch the stored object and render it to HTML in-process, so
  // the admin can read an .xlsx timesheet beside the calendar instead of having
  // to download it.
  if (kind === "other" && isOfficePreviewable(fileName)) {
    const { data: blob } = await api.storage.from("ts-uploads").download(path);
    if (blob) {
      const doc = await renderOfficePreview(Buffer.from(await blob.arrayBuffer()), fileName);
      if (doc) return NextResponse.json({ doc });
    }
  }

  if (kind !== "other" || !process.env.ENGINE_URL) {
    const { data: signed, error: serr } = await api.storage
      .from("ts-uploads").createSignedUrl(path, 600);
    if (serr || !signed?.signedUrl) {
      return NextResponse.json({ error: "file not found in storage" }, { status: 404 });
    }
    return NextResponse.json({ doc: { url: signed.signedUrl, kind, fileName } });
  }

  const { data: blob, error } = await api.storage.from("ts-uploads").download(path);
  if (error || !blob) {
    return NextResponse.json({ error: "file not found in storage" }, { status: 404 });
  }
  try {
    const result = await previewUpload(blob, fileName);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `preview failed: ${e.message || e}` }, { status: 502 });
  }
}
