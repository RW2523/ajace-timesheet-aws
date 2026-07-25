// Upload policy for timesheet documents.
//
// The extension is the ONLY thing trusted here. The browser-supplied MIME type
// is attacker-controlled, and so is the file body — an .html upload served back
// on our own origin would run as the viewing admin (stored XSS), which is why
// the served Content-Type is derived from this table and never from the upload.

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024;

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
