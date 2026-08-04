"use client";
import { useEffect, useState } from "react";
import { previewNote } from "@/lib/aws/filetypes";

// Renders the source document beside the form so the user can cross-verify.
//
// Modes:
//   pages — engine-rendered PNGs (any format; needs the Python engine)
//   doc   — browser-native rendering:
//             { url, kind: "pdf" | "image" }   PDFs use the browser's viewer,
//                                              images render directly
//             { html, kind: "html" }           Excel/Word converted in-process
//             { kind: "other", reason, message, url? }
//                                              nothing we can render — say WHY
//
// INVARIANT: there is no input for which this component shows a blank body.
// Every branch ends in a document, a spinner, or a worded card. A silent empty
// pane reads as "the preview is broken" and it is what item 4 was reported for.
//
// `file` is optional: when the caller is previewing a file that has not been
// uploaded yet, passing it lets the "Open original" link work from a local
// blob: URL instead of dead-ending.
export default function PreviewPane({ pages, doc, loading, fileName, file, onClose }) {
  const [zoom, setZoom] = useState(1);
  const clamp = (z) => Math.min(4, Math.max(0.4, z));

  // An image URL that 404s (a storage_path whose object is gone) would otherwise
  // render as the browser's broken-image icon, which reads as "the preview is
  // broken". Catch it and fall through to the worded card instead. Reset
  // whenever the document changes, or a stale failure would hide a good file.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => { setImgFailed(false); }, [doc?.url, doc?.html]);

  const hasPages = pages && pages.length > 0;
  const isPdf = !hasPages && doc?.kind === "pdf" && doc?.url;
  const isImage = !hasPages && doc?.kind === "image" && doc?.url && !imgFailed;
  const isHtml = !hasPages && doc?.kind === "html" && doc?.html;
  const isOther = !hasPages && doc && !isPdf && !isImage && !isHtml;
  const zoomable = hasPages || isImage; // PDFs zoom via the browser's own viewer

  // Local fallback link for a not-yet-uploaded file: the server has no URL to
  // give us before the upload happens, but the browser is holding the bytes.
  const [localUrl, setLocalUrl] = useState("");
  useEffect(() => {
    if (!file || !isOther || doc?.url) { setLocalUrl(""); return; }
    const u = URL.createObjectURL(file);
    setLocalUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, isOther, doc?.url]);

  // Bytes that never left this browser: a blob: URL made from the picked File.
  const isLocalDoc = !!doc?.url?.startsWith("blob:");

  const openUrl = doc?.url || localUrl;
  // "Local" also covers the fallback object URL above. Labelling either one
  // "Open original" implies it came back from the server; it didn't.
  const isLocal = isLocalDoc || (!doc?.url && !!localUrl);

  // An image the browser refused to decode. WHY depends on where the bytes came
  // from, and getting this wrong is worse than saying nothing:
  //   blob: — the file is on the user's own disk and has never been uploaded, so
  //           "not in storage" is simply false. The image is damaged, or its
  //           contents don't match its extension.
  //   http  — a stored object whose key no longer resolves: genuinely missing.
  const imgBroken = imgFailed && doc?.kind === "image";
  const cardReason = imgBroken ? (isLocalDoc ? "unreadable" : "missing") : doc?.reason;
  const cardMessage = imgBroken
    ? (isLocalDoc ? previewNote("unreadable") : "The document couldn’t be loaded from storage.")
    : (doc?.message || "This file can’t be shown here.");

  return (
    <div className="pv">
      <div className="pv-bar">
        <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fileName || "Source preview"}
        </span>
        <div className="row" style={{ gap: 4 }}>
          {zoomable && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => clamp(z * 0.8))} title="Zoom out">−</button>
              <span className="muted" style={{ fontSize: 11, minWidth: 38, textAlign: "center" }}>
                {Math.round(zoom * 100)}%
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => clamp(z * 1.25))} title="Zoom in">+</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setZoom(1)} title="Fit width">⤢</button>
            </>
          )}
          {doc?.url && (
            <a className="btn btn-ghost btn-sm" href={doc.url} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
          )}
          {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close">×</button>}
        </div>
      </div>
      <div className="pv-body" style={{ "--z": zoom }}>
        {loading && (
          <div style={{ color: "#e2e8f0", textAlign: "center", padding: 30, fontSize: 13 }}>
            <span className="spinner" style={{ marginRight: 8 }} /> Rendering preview…
          </div>
        )}
        {!loading && isPdf && (
          <iframe className="pv-frame" src={doc.url} title={fileName || "document"} />
        )}
        {!loading && isImage && (
          <img src={doc.url} alt={fileName || "document"} onError={() => setImgFailed(true)} />
        )}
        {!loading && isHtml && (
          // SANDBOXED. The markup is derived from an uploaded file, so it is
          // untrusted: `sandbox` with no allow-* tokens gives it an opaque
          // origin with scripting disabled, and srcdoc keeps it same-document
          // without a network fetch. Never render this via dangerouslySetInnerHTML.
          <iframe
            className="pv-frame"
            sandbox=""
            srcDoc={doc.html}
            title={fileName || "document"}
            style={{ background: "#fff" }}
          />
        )}
        {!loading && isOther && (
          // The server tells us WHY it declined, in words. Falling back to a
          // generic "no preview for this file type" was actively misleading:
          // it was shown for damaged files, oversized files and missing
          // objects, none of which are a file-type problem.
          <div className="pv-note">
            <div style={{ fontSize: 26 }}>{ICONS[cardReason] || "📄"}</div>
            <b>{HEADINGS[cardReason] || "No preview available"}</b>
            <span>{cardMessage}</span>
            {openUrl ? (
              <a
                className="btn btn-ghost btn-sm"
                href={openUrl}
                {...(isLocal ? { download: fileName || "document" } : { target: "_blank", rel: "noreferrer" })}
              >
                {isLocal ? "Open your file ↗" : "Open original ↗"}
              </a>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {doc.reason === "unsupported"
                  ? "Choose a PDF, photo, Excel or Word file."
                  : "You can still submit this file — only the preview is unavailable."}
              </span>
            )}
          </div>
        )}
        {!loading && !hasPages && !doc && (
          <div style={{ color: "#cbd5e1", textAlign: "center", padding: 30, fontSize: 13 }}>
            No preview available.
          </div>
        )}
        {!loading && hasPages &&
          pages.map((src, i) => <img key={i} src={src} alt={`page ${i + 1}`} />)}
      </div>
    </div>
  );
}

// Headings mirror lib/aws/filetypes.js PREVIEW_NOTES — the reason string is the
// contract between the two, so a new reason there needs a heading here (and
// falls back to a safe generic one if it doesn't get one).
const HEADINGS = {
  unsupported: "That file type isn’t accepted",
  empty: "This file is empty",
  too_large: "Too large to preview",
  unreadable: "We couldn’t read this file",
  encrypted: "This document is password-protected",
  no_content: "Nothing to show",
  legacy_doc: "Old .doc format",
  photo_unsupported: "This photo format can’t be shown",
  missing: "Document not in storage",
  no_renderer: "No in-browser preview for this file type",
  native: "Rendered by your browser",
  failed: "Preview unavailable",
};

const ICONS = {
  unsupported: "🚫", empty: "📭", too_large: "🏋️", unreadable: "⚠️",
  encrypted: "🔒", no_content: "📄", legacy_doc: "🗂️", photo_unsupported: "🖼️",
  missing: "🔍", no_renderer: "📊",
};
