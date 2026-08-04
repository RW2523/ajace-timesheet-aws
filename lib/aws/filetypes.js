// Upload policy for timesheet documents.
//
// The extension is the ONLY thing trusted here. The browser-supplied MIME type
// is attacker-controlled, and so is the file body — an .html upload served back
// on our own origin would run as the viewing admin (stored XSS), which is why
// the served Content-Type is derived from this table and never from the upload.

// This module is imported by CLIENT components (DashboardClient, PreviewPane)
// as well as by routes, so nothing here may assume `process` exists: a bare
// `process.env.X` at module scope would throw a ReferenceError in a browser that
// got no shim, and taking the whole dashboard down over a size constant is not a
// trade worth making. Server-side ENV is the live process.env object, so the
// values below still follow a restart exactly as before.
const ENV = (typeof process !== "undefined" && process.env) || {};

// NEXT_PUBLIC_MAX_UPLOAD_MB exists only so the BROWSER can read the same number
// (the picker refuses an oversized file before uploading it, and a client bundle
// can only see NEXT_PUBLIC_* vars). Written out in full rather than through ENV
// because the bundler inlines it by matching this exact text. The server still
// prefers MAX_UPLOAD_MB and remains the authority — if you raise the cap, set
// BOTH, or the browser will keep refusing at the old size.
const PUBLIC_MAX_UPLOAD_MB =
  typeof process !== "undefined" && process.env ? process.env.NEXT_PUBLIC_MAX_UPLOAD_MB : undefined;

export const MAX_UPLOAD_BYTES =
  Number(ENV.MAX_UPLOAD_MB || PUBLIC_MAX_UPLOAD_MB || 15) * 1024 * 1024;

// Separate, smaller cap for RENDERING a preview. Uploading a 15 MB workbook is
// cheap (bytes straight to S3); parsing one is not — SheetJS/mammoth hold the
// whole document plus its object graph in memory, and peak RSS is several times
// the file size. This box is a 2 GB t4g.small whose kernel refuses swapon, so an
// OOM here kills payroll for everyone, not just the preview. Over this limit we
// decline to render and tell the user to open the original.
export const MAX_PREVIEW_BYTES = Number(ENV.MAX_PREVIEW_MB || 8) * 1024 * 1024;

// extension -> { type, inline }
// inline:true is only for formats a browser renders safely in an <iframe>/<img>.
// Everything else is forced to download, so it can never execute in our origin.
const TYPES = {
  pdf:  { type: "application/pdf", inline: true },
  png:  { type: "image/png", inline: true },
  jpg:  { type: "image/jpeg", inline: true },
  jpeg: { type: "image/jpeg", inline: true },
  webp: { type: "image/webp", inline: true },
  gif:  { type: "image/gif", inline: true },
  heic: { type: "image/heic", inline: false }, // iPhone photos: no browser renders these inline
  heif: { type: "image/heif", inline: false },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false },
  xls:  { type: "application/vnd.ms-excel", inline: false },
  csv:  { type: "text/csv", inline: false },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false },
  doc:  { type: "application/msword", inline: false },
};

// NOTE: svg is deliberately absent — SVG is executable in a browser context.

export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

export function extensionOf(nameOrPath) {
  const base = String(nameOrPath || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}

export function isAllowedExtension(nameOrPath) {
  return Object.prototype.hasOwnProperty.call(TYPES, extensionOf(nameOrPath));
}

/** True when serveHeadersFor() will send this extension with `inline` disposition. */
export function isInlineServable(nameOrPath) {
  return !!TYPES[extensionOf(nameOrPath)]?.inline;
}

// ---------------------------------------------------------------------------
// PREVIEW POLICY — one source of truth for "what can we show for this file?"
//
// These lists used to be re-declared in four places (DashboardClient, the
// admin-preview route, officepreview, and this table) and they disagreed: bmp/
// tif/tiff were offered as previewable but rejected at upload, while heic/heif
// were accepted at upload and offered nowhere. Everything that decides how to
// render a file must read it from here, so the sets cannot drift apart again.
// ---------------------------------------------------------------------------

// Derived, not hand-written, so it can never disagree with TYPES: an image the
// browser is allowed to render inline.
export const IMAGE_EXTENSIONS = Object.keys(TYPES)
  .filter((e) => TYPES[e].type.startsWith("image/") && TYPES[e].inline);

// Accepted photo formats that NO browser renders (Safari aside). We transcode
// these to JPEG server-side when the image library supports it.
export const PHOTO_TRANSCODE_EXTENSIONS = ["heic", "heif"];

// Rendered to sanitised HTML in-process by lib/aws/officepreview.js.
export const OFFICE_EXTENSIONS = ["xlsx", "xls", "csv", "docx"];

/**
 * How this file should be previewed.
 * "pdf"   — browser's own PDF viewer
 * "image" — <img>
 * "photo" — needs a server-side transcode to become an "image"
 * "office"— parsed to HTML in-process
 * "none"  — accepted for upload, but nothing here can render it (.doc)
 * @returns {"pdf"|"image"|"photo"|"office"|"none"}
 */
export function previewKindOf(nameOrPath) {
  const ext = extensionOf(nameOrPath);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (PHOTO_TRANSCODE_EXTENSIONS.includes(ext)) return "photo";
  if (OFFICE_EXTENSIONS.includes(ext)) return "office";
  return "none";
}

// Operator-facing wording for every way a preview can decline to render. The
// pane must never show a blank panel or a raw exception, so every path that
// gives up has to pick one of these.
export const PREVIEW_NOTES = {
  unsupported: "This isn’t a file type the timesheet uploader accepts, so there’s nothing to preview.",
  empty: "This file is empty (0 bytes).",
  too_large: "This file is too large to render a preview of — open the original instead.",
  unreadable: "We couldn’t read this file. It may be damaged, or its contents may not match its file extension.",
  encrypted: "This document is password-protected, so it can’t be previewed.",
  no_content: "This document has no readable content to show.",
  legacy_doc: "Old-style .doc files can’t be previewed in the browser — open the original instead.",
  photo_unsupported: "HEIC/HEIF photos can’t be displayed by browsers, and this server can’t convert them.",
  missing: "The original document is no longer in storage, so there’s nothing to preview.",
  no_renderer: "There’s no in-browser preview for this file type.",
  native: "This file type is rendered directly by the browser — no server preview is needed.",
  failed: "The preview couldn’t be generated. The file itself is unaffected.",
};

export function previewNote(reason) {
  return PREVIEW_NOTES[reason] || PREVIEW_NOTES.no_renderer;
}

/**
 * Cheap up-front reasons NOT to attempt a render, checked before any bytes are
 * read into memory. Returns null when it is safe to try.
 * @param {{name:string, size?:number}} f
 * @returns {{reason:string, message:string}|null}
 */
export function previewProblem({ name, size } = {}) {
  const deny = (reason) => ({ reason, message: previewNote(reason) });
  if (!isAllowedExtension(name)) return deny("unsupported");
  if (typeof size === "number") {
    if (size <= 0) return deny("empty");
    if (size > MAX_PREVIEW_BYTES) return deny("too_large");
  }
  return null;
}

// ---------------------------------------------------------------------------
// UPLOAD POLICY — the same three refusals /api/storage/upload makes, in words,
// so the FILE PICKER can make them first.
//
// Before this existed the browser had no idea what the uploader accepts: a .tif
// or a 40 MB scan was selectable, got a working local preview, and was only
// refused after /api/process had already run — the employee's hours saved with
// the source document silently detached. The picker must refuse the same files
// the route refuses, using the same table, or the two drift apart again.
//
// A human-readable size, e.g. "0.4 MB" / "41 MB".
const mb = (bytes) => {
  const n = bytes / 1024 / 1024;
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} MB`;
};

/**
 * Why this file cannot be uploaded, or null when it can.
 * `size` is optional; the server re-checks the real byte length regardless.
 * @param {{name:string, size?:number}} f
 * @returns {{reason:"unsupported"|"empty"|"too_large", message:string}|null}
 */
export function uploadProblem({ name, size } = {}) {
  const label = String(name || "that file");
  if (!isAllowedExtension(name)) {
    return {
      reason: "unsupported",
      message:
        `We can’t accept “${label}”. Choose a PDF, a photo, an Excel/CSV file or a Word document — ` +
        `accepted types: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
    };
  }
  if (typeof size === "number") {
    if (size <= 0) {
      return {
        reason: "empty",
        message: `“${label}” is empty (0 bytes). Check that it saved or exported correctly, then try again.`,
      };
    }
    if (size > MAX_UPLOAD_BYTES) {
      return {
        reason: "too_large",
        message:
          `“${label}” is ${mb(size)}, and the limit is ${mb(MAX_UPLOAD_BYTES)}. ` +
          `Please attach a smaller file — a lower-resolution scan or export is usually enough.`,
      };
    }
  }
  return null;
}

/** Content-Type + disposition to SERVE a stored object with. Never trusts stored metadata. */
export function serveHeadersFor(path, fileName) {
  const t = TYPES[extensionOf(path)];
  const safeName = String(fileName || "document").replace(/[^\w.\-]+/g, "_");
  if (!t) {
    // Unknown/legacy object: force a download as an opaque blob.
    return {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
    };
  }
  return {
    "Content-Type": t.type,
    "Content-Disposition": `${t.inline ? "inline" : "attachment"}; filename="${safeName}"`,
  };
}
