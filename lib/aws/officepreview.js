// Render Office documents to previewable HTML, in-process.
//
// Why not convert to PDF: LibreOffice is ~450 MB installed and needs 250-400 MB
// of RAM per conversion. This box is a 2 GB t4g.small whose kernel refuses
// swapon, so a conversion during month-end (alongside an AI extraction) is a
// plausible OOM. SheetJS is already a dependency and parses a timesheet in
// milliseconds; mammoth is ~1 MB. No system packages, no new infrastructure.
//
// SECURITY: the output is built FROM AN UPLOADED FILE, so it is untrusted.
// It is never injected into the app's DOM — the client renders it inside a
// sandboxed <iframe srcdoc>, which runs it in an opaque origin with scripts
// disabled. That is the same class of bug fixed in Tier 0 (an uploaded .html
// executing as the viewing admin), so it must not be reintroduced here.
import * as XLSX from "xlsx";

const SHEET_LIMIT = 12;
const ROW_LIMIT = 400;   // a month of timesheet rows is ~35; this is generous

const PAGE_CSS = `
  :root { color-scheme: light; }
  body { margin:0; padding:14px; background:#fff; color:#0f172a;
         font:13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.05em;
       color:#64748b; margin:18px 0 6px; }
  h3:first-child { margin-top:0; }
  table { border-collapse:collapse; width:100%; margin-bottom:10px; }
  td, th { border:1px solid #e2e8f0; padding:5px 8px; text-align:left;
           vertical-align:top; white-space:nowrap; }
  tr:first-child td { background:#f8fafc; font-weight:600; }
  p { margin:0 0 8px; } img { max-width:100%; }
  .trunc { color:#b45309; font-size:12px; margin:6px 0 0; }
`;

const wrap = (inner) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>${PAGE_CSS}</style>${inner}`;

// The table is built by hand from cell VALUES rather than via
// XLSX.utils.sheet_to_html, because that helper writes cell text into the
// markup unescaped — a cell containing "<script>…" ends up as real markup.
// The sandboxed frame would stop it executing, but escaping at the source means
// the preview is safe even if it is ever rendered somewhere less protected.
function spreadsheetToHtml(buf, fileName) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, cellStyles: false });
  const names = wb.SheetNames.slice(0, SHEET_LIMIT);
  if (!names.length) return null;

  const parts = names.map((name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    const shown = rows.slice(0, ROW_LIMIT);
    const body = shown.map((row) =>
      "<tr>" + row.map((cell) => `<td>${escapeHtml(cell ?? "")}</td>`).join("") + "</tr>"
    ).join("");
    const clipped = rows.length > ROW_LIMIT
      ? `<p class="trunc">Showing the first ${ROW_LIMIT} of ${rows.length} rows.</p>` : "";
    const title = names.length > 1 ? `<h3>${escapeHtml(name)}</h3>` : "";
    return `${title}<table>${body}</table>${clipped}`;
  });

  const note = wb.SheetNames.length > SHEET_LIMIT
    ? `<p class="trunc">Showing the first ${SHEET_LIMIT} of ${wb.SheetNames.length} sheets.</p>` : "";
  return wrap(parts.join("\n") + note);
}

async function docxToHtml(buf) {
  // Imported lazily so a Word upload is the only thing that ever loads mammoth.
  const mammoth = (await import("mammoth")).default || (await import("mammoth"));
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  if (!value || !value.trim()) return null;
  return wrap(value);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const OFFICE_EXTENSIONS = ["xlsx", "xls", "csv", "docx"];

export function isOfficePreviewable(nameOrPath) {
  const ext = String(nameOrPath || "").split(".").pop()?.toLowerCase();
  return OFFICE_EXTENSIONS.includes(ext);
}

/**
 * @returns {Promise<{kind:'html', html:string, fileName:string} | null>}
 *          null when the format isn't supported or the file can't be read —
 *          callers fall back to "open the original", never to an error.
 */
export async function renderOfficePreview(buffer, fileName) {
  const ext = String(fileName || "").split(".").pop()?.toLowerCase();
  try {
    let html = null;
    if (ext === "xlsx" || ext === "xls" || ext === "csv") html = spreadsheetToHtml(buffer, fileName);
    else if (ext === "docx") html = await docxToHtml(buffer);
    return html ? { kind: "html", html, fileName } : null;
  } catch (e) {
    console.warn(`[preview] could not render ${fileName}:`, e?.message || e);
    return null;
  }
}
