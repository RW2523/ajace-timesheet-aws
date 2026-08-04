// Render uploaded documents to previewable HTML (and photos to JPEG), in-process.
//
// Why not convert to PDF: LibreOffice is ~450 MB installed and needs 250-400 MB
// of RAM per conversion. This box is a 2 GB t4g.small whose kernel refuses
// swapon, so a conversion during month-end (alongside an AI extraction) is a
// plausible OOM. SheetJS is already a dependency and parses a timesheet in
// milliseconds; mammoth is ~1 MB. No system packages, no new infrastructure.
//
// SECURITY: the output is built FROM AN UPLOADED FILE, so it is untrusted.
// It is never injected into the app's DOM — the client renders it inside a
// sandboxed <iframe srcdoc>, which runs it in an opaque origin with scripting
// disabled. That is the same class of bug fixed in Tier 0 (an uploaded .html
// executing as the viewing admin), so it must not be reintroduced here.
//
// MEMORY: every limit in this file exists because the box has 2 GB and no swap.
// A workbook whose !ref claims 16384 columns, a .docx full of photos, or a cell
// holding 32k characters must all produce a BOUNDED preview, not an OOM.
import * as XLSX from "xlsx";
import { OFFICE_EXTENSIONS, extensionOf } from "./filetypes.js";

const SHEET_LIMIT = 12;
const ROW_LIMIT = 400;    // a month of timesheet rows is ~35; this is generous
const COL_LIMIT = 64;     // a timesheet is ~10 columns wide
const CELL_CHARS = 500;   // one cell can legally hold 32767 characters
const HTML_BUDGET = 1_500_000; // total characters of preview markup we will ship
const IMAGE_BUDGET = 700_000;  // total base64 characters of embedded .docx images

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A 1x1 transparent GIF, used in place of a .docx image we refused to inline.
const BLANK_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const ok = (html, fileName) => ({ kind: "html", html, fileName });
const fail = (reason, fileName) => ({ kind: "error", reason, fileName });

// Map a thrown parser error onto one of the preview vocabulary's reasons.
// Everything unrecognised is "unreadable" — never a stack trace, never a 500.
function reasonForError(e) {
  const m = String(e?.message || e || "").toLowerCase();
  if (m.includes("password") || m.includes("encrypt")) return "encrypted";
  return "unreadable";
}

// ---------------------------------------------------------------------------
// CONTENT SNIFFING — the extension is a claim, not a fact.
//
// SheetJS does NOT reject bytes that aren't a workbook: handed random binary or
// the source of a PDF, it falls back to its delimited-text reader and returns a
// "sheet" of garbage. The admin then sees a table of PDF internals next to the
// hours and has no idea the preview is meaningless. A file whose contents don't
// match its extension must produce the honest "we couldn't read this" card.
//
// The check is deliberately permissive for text: an .xls that is really an HTML
// table or a CSV is a genuine and common HR-system export, and SheetJS reads
// those correctly. Only clearly-binary-but-not-a-workbook is rejected.
// ---------------------------------------------------------------------------
const ZIP_MAGIC = ["504b0304", "504b0506", "504b0708"];  // OOXML (.xlsx/.docx)
const CFB_MAGIC = "d0cf11e0a1b11ae1";                     // OLE2 (.xls, encrypted)
const FOREIGN_MAGIC = ["25504446", "89504e47", "ffd8ff", "47494638", "424d", "1a45dfa3"];

const startsWith = (buf, hex) =>
  buf.length * 2 >= hex.length && buf.subarray(0, hex.length / 2).toString("hex") === hex;

/** @returns {string|null} a failure reason, or null when it is worth parsing. */
function sniffMismatch(buf, ext) {
  const isZip = ZIP_MAGIC.some((m) => startsWith(buf, m));
  // mammoth can only read an OOXML package; anything else is not a .docx.
  if (ext === "docx") return isZip ? null : "unreadable";
  if (isZip || startsWith(buf, CFB_MAGIC)) return null;
  if (FOREIGN_MAGIC.some((m) => startsWith(buf, m))) return "unreadable";
  // No known container and it contains NUL bytes: binary, so not a text export.
  if (buf.subarray(0, 8192).includes(0)) return "unreadable";
  return null;
}

// The table is built by hand from cell VALUES rather than via
// XLSX.utils.sheet_to_html, because that helper writes cell text into the
// markup unescaped — a cell containing "<script>…" ends up as real markup
// (xlsx 0.18.5 emits cell.h raw, and injects cell.l.Target into an href raw).
// The sandboxed frame would stop it executing, but escaping at the source means
// the preview is safe even if it is ever rendered somewhere less protected.
// DO NOT "simplify" this to sheet_to_html.
function spreadsheetToHtml(buf, fileName) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, cellStyles: false });
  const names = (wb.SheetNames || []).slice(0, SHEET_LIMIT);
  if (!names.length) return null;

  let budget = HTML_BUDGET;
  let rendered = 0;          // cells actually emitted, to detect an empty book
  let budgetHit = false;
  const parts = [];

  for (const name of names) {
    if (budgetHit) break;
    const ws = wb.Sheets[name];
    const ref = ws && ws["!ref"];
    if (!ref) continue;

    // Clip the READ RANGE, not the parsed result. sheet_to_json sizes every row
    // to the sheet's declared width, so a single stray cell at column XFD would
    // otherwise materialise 400 x 16384 = 6.5M array entries before we ever got
    // the chance to slice them. Some HR exports really do carry a wide !ref.
    const full = XLSX.utils.decode_range(ref);
    const clipped = {
      s: { r: full.s.r, c: full.s.c },
      e: {
        r: Math.min(full.e.r, full.s.r + ROW_LIMIT - 1),
        c: Math.min(full.e.c, full.s.c + COL_LIMIT - 1),
      },
    };
    const totalRows = full.e.r - full.s.r + 1;
    const totalCols = full.e.c - full.s.c + 1;

    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: "", raw: false, blankrows: false, range: clipped,
    });

    const trs = [];
    for (const row of rows) {
      const cells = (Array.isArray(row) ? row : []).slice(0, COL_LIMIT);
      let tr = "<tr>";
      for (const cell of cells) {
        const text = String(cell ?? "");
        tr += `<td>${escapeHtml(text.length > CELL_CHARS ? text.slice(0, CELL_CHARS) + "…" : text)}</td>`;
        rendered++;
      }
      tr += "</tr>";
      if (tr.length > budget) { budgetHit = true; break; }
      budget -= tr.length;
      trs.push(tr);
    }

    const notes = [];
    if (totalRows > ROW_LIMIT) notes.push(`the first ${ROW_LIMIT} of ${totalRows} rows`);
    if (totalCols > COL_LIMIT) notes.push(`the first ${COL_LIMIT} of ${totalCols} columns`);
    if (budgetHit) notes.push("as much as fits — this sheet is unusually large");
    const clip = notes.length ? `<p class="trunc">Showing ${notes.join(" and ")}.</p>` : "";
    const title = names.length > 1 ? `<h3>${escapeHtml(name)}</h3>` : "";
    parts.push(`${title}<table>${trs.join("")}</table>${clip}`);
  }

  if (!rendered) return null;   // a workbook of entirely empty sheets

  const note = (wb.SheetNames || []).length > SHEET_LIMIT
    ? `<p class="trunc">Showing the first ${SHEET_LIMIT} of ${wb.SheetNames.length} sheets.</p>` : "";
  return wrap(parts.join("\n") + note);
}

async function docxToHtml(buf) {
  // Imported lazily so a Word upload is the only thing that ever loads mammoth.
  const mammoth = (await import("mammoth")).default || (await import("mammoth"));

  // mammoth inlines EVERY embedded image as a base64 data: URI by default, so a
  // .docx containing photographed timesheets can produce tens of MB of markup
  // from a small file. Spend a fixed budget, then swap the rest for a placeholder.
  let imageBudget = IMAGE_BUDGET;
  const convertImage = mammoth.images.imgElement(async (image) => {
    try {
      const b64 = await image.read("base64");
      if (b64.length > imageBudget) {
        return { src: BLANK_PX, alt: "image omitted — too large to preview" };
      }
      imageBudget -= b64.length;
      return { src: `data:${image.contentType};base64,${b64}` };
    } catch {
      return { src: BLANK_PX, alt: "image could not be read" };
    }
  });

  const { value } = await mammoth.convertToHtml({ buffer: buf }, { convertImage });
  if (!value || !value.trim()) return null;

  // mammoth escapes document text, but it copies hyperlink targets from the
  // document verbatim. Scripting is already disabled by the sandbox; neutralise
  // javascript:/data: hrefs anyway so the markup is safe on its own terms.
  let html = value.replace(/href\s*=\s*(["'])\s*(?:javascript|data|vbscript):[^"']*\1/gi, 'href="#"');
  if (html.length > HTML_BUDGET) {
    html = html.slice(0, HTML_BUDGET) +
      `<p class="trunc">This document is too long to show in full — open the original for the rest.</p>`;
  }
  return wrap(html);
}

export { OFFICE_EXTENSIONS };

export function isOfficePreviewable(nameOrPath) {
  return OFFICE_EXTENSIONS.includes(extensionOf(nameOrPath));
}

/**
 * Render a spreadsheet or Word document to sandboxed preview HTML.
 *
 * ALWAYS resolves — never throws, never returns null. Callers get either
 * {kind:"html"} or {kind:"error", reason}, and every reason has operator-facing
 * wording in filetypes.PREVIEW_NOTES. A preview is a convenience; a preview
 * failure must never surface as a 5xx or a blank pane.
 *
 * @returns {Promise<{kind:'html', html:string, fileName:string}
 *                 | {kind:'error', reason:string, fileName:string}>}
 */
export async function renderOfficePreview(buffer, fileName) {
  const ext = extensionOf(fileName);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return fail("empty", fileName);
  if (!OFFICE_EXTENSIONS.includes(ext)) {
    return fail(ext === "doc" ? "legacy_doc" : "no_renderer", fileName);
  }
  const mismatch = sniffMismatch(buf, ext);
  if (mismatch) return fail(mismatch, fileName);
  try {
    const html = (ext === "docx") ? await docxToHtml(buf) : spreadsheetToHtml(buf, fileName);
    return html ? ok(html, fileName) : fail("no_content", fileName);
  } catch (e) {
    // Corrupt bytes, a .pdf renamed .xlsx, an encrypted workbook — all land here.
    console.warn(`[preview] could not render ${fileName}:`, e?.message || e);
    return fail(reasonForError(e), fileName);
  }
}

/**
 * Transcode an accepted-but-undisplayable photo (HEIC/HEIF from an iPhone) into
 * a JPEG data: URL an <img> can show. Capability is probed at RUNTIME rather
 * than assumed: sharp's prebuilt binaries ship HEIF *container* support but not
 * always an HEVC decoder, and that differs between this laptop and the arm64
 * box. If it can't be done we say so plainly instead of showing a broken image.
 *
 * @returns {Promise<{kind:'image', url:string, fileName:string}
 *                 | {kind:'error', reason:string, fileName:string}>}
 */
export async function renderPhotoPreview(buffer, fileName) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return fail("empty", fileName);
  try {
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp(buf, {
      failOn: "none",
      // A 48 MP phone photo decodes to ~150 MB of raw RGB. Refuse the absurd
      // ones rather than let a decompression bomb take the box down.
      limitInputPixels: 40_000_000,
    })
      .rotate()                                   // honour the EXIF orientation
      .resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return { kind: "image", url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, fileName };
  } catch (e) {
    console.warn(`[preview] could not transcode ${fileName}:`, e?.message || e);
    return fail("photo_unsupported", fileName);
  }
}
