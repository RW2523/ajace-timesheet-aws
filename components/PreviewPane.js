"use client";
import { useState } from "react";

// Renders the source document beside the form so the user can cross-verify.
// Two modes:
//   pages — engine-rendered PNGs (any format; needs the Python engine)
//   doc   — browser-native rendering:
//             { url, kind: "pdf" | "image" }  PDFs use the browser's viewer,
//                                             images render directly
//             { html, kind: "html" }          Excel/Word converted in-process
//             { kind: "other" }               nothing we can render
export default function PreviewPane({ pages, doc, loading, fileName, onClose }) {
  const [zoom, setZoom] = useState(1);
  const clamp = (z) => Math.min(4, Math.max(0.4, z));

  const hasPages = pages && pages.length > 0;
  const isPdf = !hasPages && doc?.kind === "pdf" && doc?.url;
  const isImage = !hasPages && doc?.kind === "image" && doc?.url;
  const isHtml = !hasPages && doc?.kind === "html" && doc?.html;
  const isOther = !hasPages && doc && !isPdf && !isImage && !isHtml;
  const zoomable = hasPages || isImage; // PDFs zoom via the browser's own viewer

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
        {!loading && isImage && <img src={doc.url} alt={fileName || "document"} />}
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
          <div className="pv-note">
            <div style={{ fontSize: 26 }}>📊</div>
            <b>No in-browser preview for this file type.</b>
            <span>
              This format can’t be rendered here
              {doc?.url ? " — open the original instead." : "."}
            </span>
            {doc?.url && (
              <a className="btn btn-ghost btn-sm" href={doc.url} target="_blank" rel="noreferrer">
                Open original ↗
              </a>
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
