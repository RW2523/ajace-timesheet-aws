import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { previewUpload } from "@/lib/engine";
import { renderOfficePreview, renderPhotoPreview } from "@/lib/aws/officepreview";
import {
  MAX_PREVIEW_BYTES, previewKindOf, previewNote,
} from "@/lib/aws/filetypes";
import { rateLimit } from "@/lib/aws/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

// Admin-only: preview the STORED source file behind a submission, so an admin
// can verify the hours against the original document before approving them.
//
// The URL handed back is always SAME-ORIGIN (/api/storage/get). It must never
// be an S3 presigned URL: the app CSP is `img-src 'self' data: blob:` and
// `frame-src 'self' blob:`, so an absolute amazonaws.com URL is silently
// refused by the browser and the admin gets a blank panel with no error at all.
// That is what "the preview sometimes breaks" was — PDFs and photos, i.e. the
// two commonest timesheet formats, never rendered in the admin console, while
// the same files worked for the employee (who previews from a local blob: URL).
//
// Routing bytes through /api/storage/get also keeps the property lib/aws/storage
// depends on: the browser never talks to S3 directly, so the bucket needs no CORS.
function storageUrl(path, fileName) {
  const q = new URLSearchParams({ path });
  if (fileName) q.set("name", fileName);        // keeps the real extension on download
  return `/api/storage/get?${q.toString()}`;
}

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

  const rl = rateLimit(`admin-preview:${user.id}`, { limit: 120, windowMs: 5 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too many previews, please wait a moment" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const path = String(body?.path || "");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  // Same guard as /api/storage/get, so a bad path fails here rather than deeper in.
  if (path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const fileName = String(body?.fileName || path.split("/").pop() || "document");
  const url = storageUrl(path, fileName);
  const kind = previewKindOf(fileName);

  // Every non-render outcome still carries the URL, so the panel's "Open
  // original" always works. A card with a working download is an acceptable
  // preview outcome; a blank pane is not.
  const note = (reason) =>
    NextResponse.json({ doc: { kind: "other", reason, message: previewNote(reason), url, fileName } });

  // PDFs and images: no download, no parsing, no engine — the browser renders
  // them straight from our own origin. This is the cheap path and the common one.
  if (kind === "pdf" || kind === "image") {
    return NextResponse.json({ doc: { kind, url, fileName } });
  }

  if (kind === "office" || kind === "photo") {
    let buf;
    try {
      // The server-side storage shim THROWS on a missing key rather than
      // returning { error }, so this must be guarded: an unguarded throw here
      // became an HTML 500 page, which the admin console tried to JSON.parse
      // and reported as `Unexpected token '<'`.
      const { data: blob, error } = await api.storage.from("ts-uploads").download(path);
      if (error || !blob) return note("missing");
      buf = Buffer.from(await blob.arrayBuffer());
    } catch (e) {
      console.warn(`[admin-preview] could not fetch ${path}:`, e?.message || e);
      return note("missing");
    }
    if (!buf.length) return note("empty");
    if (buf.length > MAX_PREVIEW_BYTES) return note("too_large");

    const doc = kind === "office"
      ? await renderOfficePreview(buf, fileName)
      : await renderPhotoPreview(buf, fileName);
    if (doc.kind === "html") return NextResponse.json({ doc: { ...doc, url } });
    if (doc.kind === "image") return NextResponse.json({ doc: { ...doc, fileName } });
    if (kind === "photo") return note(doc.reason);

    // An office file we could not parse: let the engine try, if there is one.
    if (process.env.ENGINE_URL) {
      const pages = await enginePages(buf, fileName);
      if (pages) return NextResponse.json(pages);
    }
    return note(doc.reason);
  }

  // Accepted at upload but unrenderable here (legacy .doc, or a legacy object
  // whose extension predates the allowlist).
  if (process.env.ENGINE_URL) {
    try {
      const { data: blob, error } = await api.storage.from("ts-uploads").download(path);
      if (error || !blob) return note("missing");
      const pages = await enginePages(Buffer.from(await blob.arrayBuffer()), fileName);
      if (pages) return NextResponse.json(pages);
    } catch (e) {
      console.warn(`[admin-preview] could not fetch ${path}:`, e?.message || e);
      return note("missing");
    }
  }
  return note(fileName.toLowerCase().endsWith(".doc") ? "legacy_doc" : "no_renderer");
}

// The engine is optional and best-effort. It must never turn a preview into a
// 502 the admin has to interpret — the caller falls back to a worded card.
async function enginePages(buf, fileName) {
  try {
    const result = await previewUpload(new Blob([buf]), fileName);
    return result?.pages?.length ? result : null;
  } catch (e) {
    console.warn(`[admin-preview] engine failed for ${fileName}:`, e?.message || e);
    return null;
  }
}
