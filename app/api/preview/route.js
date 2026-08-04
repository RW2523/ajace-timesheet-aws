import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { previewUpload } from "@/lib/engine";
import { renderOfficePreview, renderPhotoPreview } from "@/lib/aws/officepreview";
import {
  MAX_PREVIEW_BYTES, previewKindOf, previewNote, previewProblem,
} from "@/lib/aws/filetypes";
import { rateLimit, clientIp } from "@/lib/aws/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

// Source-document preview for a file the employee has JUST PICKED — it has not
// been uploaded yet, so there is no storage path and no URL to fall back to.
//
// Contract: this route answers 200 with a `doc` for every input it is given.
// PDFs and images are normally rendered straight from the picked File by the
// browser and never arrive here; spreadsheets, Word documents and iPhone photos
// are rendered here. Anything we cannot render comes back as
// { doc: { kind: "other", reason, message } } so the pane can say WHY in words.
// The only non-200s are authentication, rate limiting and a malformed request:
// a preview failure is never an error the user has to deal with.
const note = (reason) =>
  NextResponse.json({ doc: { kind: "other", reason, message: previewNote(reason) } });

export async function POST(request) {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Parsing an uploaded document is the most expensive thing an authenticated
  // user can make this box do, so it is metered. /api/storage/get is not: it
  // only copies bytes.
  const rl = rateLimit(`preview:${user.id}`, { limit: 60, windowMs: 5 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too many previews, please wait a moment" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  const name = file.name || "upload";

  // Checked BEFORE any bytes are read: an unaccepted extension, an empty file,
  // or one too big to parse safely. Reading arrayBuffer() first is what made a
  // single oversized workbook able to OOM the process.
  const problem = previewProblem({ name, size: typeof file.size === "number" ? file.size : undefined });
  if (problem) return note(problem.reason);

  const kind = previewKindOf(name);

  // Shouldn't happen (the client renders these from the File directly), but if
  // one arrives, say so rather than returning an empty doc.
  if (kind === "pdf" || kind === "image") return note("native");

  if (kind === "office" || kind === "photo") {
    let buf;
    try {
      buf = Buffer.from(await file.arrayBuffer());
    } catch {
      return note("unreadable");
    }
    // file.size can be absent or wrong; re-check against what we actually read.
    if (!buf.length) return note("empty");
    if (buf.length > MAX_PREVIEW_BYTES) return note("too_large");

    const doc = kind === "office"
      ? await renderOfficePreview(buf, name)
      : await renderPhotoPreview(buf, name);
    if (doc.kind === "html" || doc.kind === "image") return NextResponse.json({ doc });
    // Fall through to the engine only for office files: it may render a format
    // we could not. A photo we failed to transcode has nothing left to try.
    if (kind === "photo") return note(doc.reason);
    if (!process.env.ENGINE_URL) return note(doc.reason);
    try {
      const result = await previewUpload(file, name);
      if (result?.pages?.length) return NextResponse.json(result);
    } catch (e) {
      console.warn(`[preview] engine failed for ${name}:`, e?.message || e);
    }
    return note(doc.reason);
  }

  // Accepted at upload, but nothing in this stack can read it (legacy .doc).
  if (!process.env.ENGINE_URL) {
    return note(previewKindOf(name) === "none" && name.toLowerCase().endsWith(".doc")
      ? "legacy_doc" : "no_renderer");
  }
  try {
    const result = await previewUpload(file, name);
    if (result?.pages?.length) return NextResponse.json(result);
  } catch (e) {
    console.warn(`[preview] engine failed for ${name}:`, e?.message || e);
  }
  return note("no_renderer");
}
