// Document preview (item 4): every file the uploader ACCEPTS must have a
// defined preview outcome, and every ugly input must degrade to a worded card
// instead of a blank pane, a hung spinner, a 500, or an OOM.
//
// Fixtures are GENERATED here — a real .xlsx, a real .xls, a real .csv, a real
// .docx, a real .pdf, a real password-protected workbook, corrupt bytes, an
// empty file, and a file whose extension lies about its contents. Nothing is
// checked in and nothing touches the database, so this runs standalone:
//     node test/preview.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";
import JSZip from "jszip";
// xlsx is CommonJS; the ESM namespace only surfaces the exports cjs-module-lexer
// can see, and XLSX.CFB isn't one of them. The CFB writer is needed to build a
// genuine password-protected workbook, so reach it through require().
const CFB = createRequire(import.meta.url)("xlsx").CFB;
import { renderOfficePreview, renderPhotoPreview } from "../lib/aws/officepreview.js";
import {
  ALLOWED_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, MAX_PREVIEW_BYTES,
  MAX_UPLOAD_BYTES, previewKindOf, previewProblem, previewNote, PREVIEW_NOTES,
  isAllowedExtension, isInlineServable, uploadProblem,
} from "../lib/aws/filetypes.js";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}   ${x}`)); };
const head = (s) => console.log(`\n── ${s} ──`);

// ---------------------------------------------------------------- fixtures --
function sheetBook(aoa, name = "Timesheet") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return wb;
}
const xlsxOf = (aoa) => XLSX.write(sheetBook(aoa), { type: "buffer", bookType: "xlsx" });
const xlsOf = (aoa) => XLSX.write(sheetBook(aoa), { type: "buffer", bookType: "xls" });

// A real, structurally valid minimal PDF.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

// A real .docx: an OOXML package mammoth actually parses.
async function makeDocx(paragraphs, extraXml = "") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`);
  zip.folder("_rels").file(".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`);
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}${extraXml}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

// A real password-protected workbook: an OLE/CFB container holding the
// EncryptedPackage stream, which is exactly what Excel writes and what SheetJS
// refuses to open without the password.
function makeEncryptedXlsx() {
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "/EncryptionInfo", Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]));
  CFB.utils.cfb_add(cfb, "/EncryptedPackage", Buffer.alloc(256, 7));
  return CFB.write(cfb, { type: "buffer" });
}

const countTd = (html) => (html.match(/<td>/g) || []).length;

// ============================================================ 1. the matrix ==
head("extension policy: one source of truth, no disagreements");

ok("every accepted extension classifies without throwing",
  ALLOWED_EXTENSIONS.every((e) => typeof previewKindOf(`f.${e}`) === "string"));

const KIND_EXPECT = {
  pdf: "pdf", png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  heic: "photo", heif: "photo",
  xlsx: "office", xls: "office", csv: "office", docx: "office",
  doc: "none",
};
for (const [ext, want] of Object.entries(KIND_EXPECT)) {
  ok(`.${ext} -> ${want}`, previewKindOf(`x.${ext}`) === want, previewKindOf(`x.${ext}`));
}
ok("every accepted extension is covered by the expectation table above",
  ALLOWED_EXTENSIONS.every((e) => e in KIND_EXPECT),
  ALLOWED_EXTENSIONS.filter((e) => !(e in KIND_EXPECT)).join(","));

// The old client-side lists offered these as previewable while the uploader
// rejected them: preview attempt, broken image, then a hard 400 at submit.
for (const ext of ["bmp", "tif", "tiff", "svg", "html"]) {
  ok(`.${ext} is not accepted and is not offered a preview`,
    !isAllowedExtension(`x.${ext}`) && previewProblem({ name: `x.${ext}`, size: 10 })?.reason === "unsupported");
}
ok("IMAGE_EXTENSIONS is derived from the inline-servable types",
  IMAGE_EXTENSIONS.every((e) => isInlineServable(`x.${e}`)) &&
  IMAGE_EXTENSIONS.join(",") === "png,jpg,jpeg,webp,gif", IMAGE_EXTENSIONS.join(","));
ok("heic is accepted but never served inline (no browser renders it)",
  isAllowedExtension("x.heic") && !isInlineServable("x.heic"));
ok("office extensions agree with the renderer",
  OFFICE_EXTENSIONS.every((e) => previewKindOf(`x.${e}`) === "office"));
ok("every reason has operator-facing wording",
  Object.keys(PREVIEW_NOTES).every((r) => previewNote(r).length > 10));
ok("an unknown reason still produces wording, never undefined",
  typeof previewNote("something_new") === "string" && previewNote("something_new").length > 10);

head("up-front guards (checked before any bytes are read)");
ok("0-byte file -> empty", previewProblem({ name: "a.xlsx", size: 0 })?.reason === "empty");
ok("oversized file -> too_large",
  previewProblem({ name: "a.xlsx", size: MAX_PREVIEW_BYTES + 1 })?.reason === "too_large");
ok("file at the cap is allowed", previewProblem({ name: "a.xlsx", size: MAX_PREVIEW_BYTES }) === null);
ok("unknown size is not guessed at", previewProblem({ name: "a.xlsx" }) === null);
ok("preview cap is below the upload cap, so big uploads still succeed",
  MAX_PREVIEW_BYTES <= Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024);

// ====================================================== 2. real files render ==
head("real fixtures render");

const ROWS = [["Date", "Regular", "Overtime"], ["2026-03-02", 8, 0], ["2026-03-03", 7, 1]];

let r = await renderOfficePreview(xlsxOf(ROWS), "march.xlsx");
ok(".xlsx renders to html", r.kind === "html", JSON.stringify(r.reason));
ok(".xlsx html contains the hours", r.kind === "html" && r.html.includes("<td>8</td>"));

r = await renderOfficePreview(xlsOf(ROWS), "march.xls");
ok(".xls renders to html", r.kind === "html", JSON.stringify(r.reason));

r = await renderOfficePreview(Buffer.from("Date,Regular\n2026-03-02,8\n"), "march.csv");
ok(".csv renders to html", r.kind === "html", JSON.stringify(r.reason));
ok(".csv html contains the hours", r.kind === "html" && r.html.includes("<td>8</td>"));

r = await renderOfficePreview(await makeDocx(["Manager approval: Jane Doe", "Total 160 hours"]), "march.docx");
ok(".docx renders to html", r.kind === "html", JSON.stringify(r.reason));
ok(".docx html contains the document text",
  r.kind === "html" && r.html.includes("Manager approval: Jane Doe"));

// ============================================================= 3. security ===
head("security: uploaded content must not become markup");

const XSS = '<script>alert(1)</script>';
r = await renderOfficePreview(xlsxOf([["Name", XSS], ['"><img src=x onerror=alert(1)>', "ok"]]), "evil.xlsx");
ok("xlsx renders despite hostile cell content", r.kind === "html", JSON.stringify(r.reason));
ok("no literal <script in the output", r.kind === "html" && !r.html.toLowerCase().includes("<script"),
  r.kind === "html" ? r.html.slice(0, 200) : "");
ok("the script tag is escaped, not dropped",
  r.kind === "html" && r.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
// "onerror=" survives as VISIBLE TEXT, which is correct — what must not survive
// is a tag. Assert on the markup, not on the words: no <img> element is emitted
// by the spreadsheet renderer at all, and the hostile cell appears wholly escaped.
ok("the img payload never becomes an element", r.kind === "html" && !/<img/i.test(r.html));
ok("the whole hostile cell is escaped into text",
  r.kind === "html" && r.html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"),
  r.kind === "html" ? (r.html.match(/<td>[^<]*img[^<]*<\/td>/) || ["not found"])[0] : r.reason);

r = await renderOfficePreview(xlsxOf([["a"]]), "sheetname.xlsx");
const wbEvil = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbEvil, XLSX.utils.aoa_to_sheet([["x"]]), "S1");
XLSX.utils.book_append_sheet(wbEvil, XLSX.utils.aoa_to_sheet([["y"]]), "S2<b>");
r = await renderOfficePreview(XLSX.write(wbEvil, { type: "buffer", bookType: "xlsx" }), "names.xlsx");
ok("sheet names are escaped too", r.kind === "html" && r.html.includes("S2&lt;b&gt;"),
  r.kind === "html" ? "no escaped name" : r.reason);

r = await renderOfficePreview(
  await makeDocx(["click me"], `<w:p><w:hyperlink r:id="rX"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>`),
  "link.docx");
ok(".docx with a hyperlink still renders", r.kind === "html", JSON.stringify(r.reason));
ok("no javascript: href survives in docx output",
  r.kind !== "html" || !/href\s*=\s*["']\s*javascript:/i.test(r.html));

// ================================================== 4. bounds (2 GB, no swap) ==
head("bounds: a hostile or huge workbook must produce a BOUNDED preview");

// One stray cell far to the right makes !ref claim ~1000 columns. Unclipped,
// sheet_to_json sizes EVERY row to that width.
const wide = XLSX.utils.aoa_to_sheet([Array.from({ length: 1000 }, (_, i) => `c${i}`)]);
const wideWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wideWb, wide, "Wide");
r = await renderOfficePreview(XLSX.write(wideWb, { type: "buffer", bookType: "xlsx" }), "wide.xlsx");
ok("a 1000-column sheet renders", r.kind === "html", JSON.stringify(r.reason));
ok("columns are clipped to 64", r.kind === "html" && countTd(r.html) <= 64, `td=${r.kind === "html" ? countTd(r.html) : "-"}`);
ok("the clipping is disclosed to the reader",
  r.kind === "html" && /first 64 of 1000 columns/.test(r.html));
ok("output stays small (< 100 KB) despite the wide !ref",
  r.kind === "html" && r.html.length < 100_000, `${r.kind === "html" ? r.html.length : "-"} chars`);

const many = [["h"]].concat(Array.from({ length: 900 }, (_, i) => [`r${i}`]));
r = await renderOfficePreview(xlsxOf(many), "long.xlsx");
ok("a 900-row sheet is clipped to 400 rows", r.kind === "html" && countTd(r.html) <= 400,
  `td=${r.kind === "html" ? countTd(r.html) : "-"}`);
ok("the row clipping is disclosed", r.kind === "html" && /first 400 of 901 rows/.test(r.html));

r = await renderOfficePreview(xlsxOf([["x".repeat(30000)]]), "fatcell.xlsx");
ok("a 30k-character cell is truncated", r.kind === "html" && r.html.length < 5000,
  `${r.kind === "html" ? r.html.length : "-"} chars`);

// A genuinely enormous sheet: 400 rows x 64 cols of long strings must still be
// capped by the total output budget rather than shipped whole.
const bigAoa = Array.from({ length: 400 }, () => Array.from({ length: 64 }, () => "y".repeat(400)));
r = await renderOfficePreview(xlsxOf(bigAoa), "big.xlsx");
ok("total output is budgeted (< 2 MB)", r.kind === "html" && r.html.length < 2_000_000,
  `${r.kind === "html" ? r.html.length : "-"} chars`);

// ======================================================= 5. the ugly cases ====
head("failure cases: none of these may throw, 500, or return a blank pane");

const cases = [
  ["empty .xlsx (0 bytes)", Buffer.alloc(0), "empty.xlsx", "empty"],
  ["empty .csv (0 bytes)", Buffer.alloc(0), "empty.csv", "empty"],
  ["corrupt bytes named .xlsx", Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)), "corrupt.xlsx", "unreadable"],
  ["corrupt bytes named .docx", Buffer.from("not a zip at all, definitely not ooxml"), "corrupt.docx", "unreadable"],
  ["a PDF that claims to be .xlsx", PDF, "liar.xlsx", "unreadable"],
  ["a PDF that claims to be .docx", PDF, "liar.docx", "unreadable"],
  ["password-protected workbook", makeEncryptedXlsx(), "locked.xlsx", "encrypted"],
  ["legacy .doc (nothing can read it)", Buffer.from("\xd0\xcf\x11\xe0", "latin1"), "old.doc", "legacy_doc"],
  ["a .pdf sent to the office renderer", PDF, "x.pdf", "no_renderer"],
  ["a .heic sent to the office renderer", Buffer.from("ftypheic"), "x.heic", "no_renderer"],
];
for (const [label, buf, name, want] of cases) {
  let got, threw = "";
  try { got = await renderOfficePreview(buf, name); } catch (e) { threw = String(e?.message || e); }
  ok(`${label} -> ${want}`, !threw && got?.kind === "error" && got.reason === want,
    threw ? `THREW ${threw}` : `got ${got?.kind}/${got?.reason}`);
  if (got?.kind === "error") {
    ok(`   …and has wording to show the user`, previewNote(got.reason).length > 10);
  }
}

// A workbook whose sheets exist but hold nothing at all.
const blankWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(blankWb, XLSX.utils.aoa_to_sheet([[]]), "Blank");
r = await renderOfficePreview(XLSX.write(blankWb, { type: "buffer", bookType: "xlsx" }), "blank.xlsx");
ok("a workbook with no content -> no_content (not a blank pane)",
  r.kind === "error" && r.reason === "no_content", `${r.kind}/${r.reason}`);

r = await renderOfficePreview(await makeDocx([]), "blank.docx");
ok("an empty .docx -> no_content", r.kind === "error" && r.reason === "no_content", `${r.kind}/${r.reason}`);

ok("renderOfficePreview never returns null/undefined",
  (await renderOfficePreview(null, "x.xlsx")) != null);

// ========================================================== 6. photo path ====
head("photo transcode (heic/heif): render it or say why, never a broken image");

let sharpPng = null;
try {
  const sharp = (await import("sharp")).default;
  sharpPng = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#336699" } })
    .png().toBuffer();
} catch (e) { console.log(`  (sharp unavailable here: ${e?.message || e})`); }

if (sharpPng) {
  const p = await renderPhotoPreview(sharpPng, "photo.png");
  ok("a real image transcodes to a JPEG data URL",
    p.kind === "image" && p.url.startsWith("data:image/jpeg;base64,"), `${p.kind}/${p.reason}`);
}
// A real HEIF-family container (AVIF), renamed .heic. This exercises the actual
// decode path rather than a fake magic string. Whether an iPhone HEIC (HEVC)
// decodes depends on the sharp build, which is exactly why the code probes at
// runtime instead of assuming — either outcome below is a defined outcome.
if (sharpPng) {
  const sharp = (await import("sharp")).default;
  let heif = null;
  try { heif = await sharp(sharpPng).avif({ quality: 40 }).toBuffer(); } catch { /* no avif encoder */ }
  if (heif) {
    const res = await renderPhotoPreview(heif, "phone.heic");
    ok("a real HEIF-container photo either transcodes or gives a worded card",
      (res.kind === "image" && res.url.startsWith("data:image/jpeg;base64,")) ||
      (res.kind === "error" && res.reason === "photo_unsupported"), `${res.kind}/${res.reason}`);
    console.log(`  (this sharp build ${res.kind === "image" ? "CAN" : "cannot"} decode HEIF containers)`);
  }
}

let p = await renderPhotoPreview(Buffer.from("ftypheic not really a photo"), "phone.heic");
ok("undecodable photo -> photo_unsupported (no throw, no broken <img>)",
  p.kind === "error" && p.reason === "photo_unsupported", `${p.kind}/${p.reason}`);
p = await renderPhotoPreview(Buffer.alloc(0), "empty.heic");
ok("0-byte photo -> empty", p.kind === "error" && p.reason === "empty", `${p.kind}/${p.reason}`);

// ============================== 7. end-to-end: every accepted extension ======
head("end-to-end: every extension the uploader accepts has a defined outcome");

const BYTES = {
  pdf: PDF, png: sharpPng || PDF, jpg: sharpPng || PDF, jpeg: sharpPng || PDF,
  webp: sharpPng || PDF, gif: sharpPng || PDF,
  heic: Buffer.from("ftypheic"), heif: Buffer.from("ftypheif"),
  xlsx: xlsxOf(ROWS), xls: xlsOf(ROWS), csv: Buffer.from("a,b\n1,2\n"),
  docx: await makeDocx(["hello"]), doc: Buffer.from("\xd0\xcf\x11\xe0", "latin1"),
};
const table = [];
for (const ext of ALLOWED_EXTENSIONS) {
  const name = `sample.${ext}`;
  const kind = previewKindOf(name);
  let outcome;
  if (kind === "pdf" || kind === "image") {
    // Served same-origin by /api/storage/get and rendered by the browser.
    outcome = isInlineServable(name) ? `render (${kind}, inline)` : "BUG: not inline-servable";
  } else if (kind === "office") {
    const res = await renderOfficePreview(BYTES[ext], name);
    outcome = res.kind === "html" ? "render (html)" : `card: ${res.reason}`;
  } else if (kind === "photo") {
    const res = await renderPhotoPreview(BYTES[ext], name);
    outcome = res.kind === "image" ? "render (transcoded)" : `card: ${res.reason}`;
  } else {
    outcome = `card: ${ext === "doc" ? "legacy_doc" : "no_renderer"}`;
  }
  table.push([ext, kind, outcome]);
  const defined = outcome.startsWith("render") ||
    (outcome.startsWith("card: ") && previewNote(outcome.slice(6)).length > 10);
  ok(`.${ext.padEnd(4)} -> ${outcome}`, defined, outcome);
}

// ============ 8. the regression that caused "the preview sometimes breaks" ====
// The admin console showed a BLANK panel for every PDF and every photo because
// /api/admin-preview handed the browser an absolute S3 presigned URL, which the
// app CSP (`img-src 'self' data: blob:`, `frame-src 'self' blob:`) silently
// refuses to load. Same files, same code path, worked for the employee — who
// previews from a local blob: URL. These guards pin the fix in place.
head("regression guard: the admin preview URL must be same-origin");

// Comments are stripped first: every one of these files *explains* the bug it
// fixes, so matching raw source would just find the prose. Only real code counts.
const src = (f) =>
  readFileSync(new URL(f, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")        // block comments
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"); // line comments (not https://)
const adminRoute = src("../app/api/admin-preview/route.js");
const csp = src("../next.config.js");

ok("admin-preview builds a same-origin /api/storage/get URL",
  adminRoute.includes("/api/storage/get?"));
ok("admin-preview never hands out an S3 presigned URL",
  !/createSignedUrl|signedUrl|amazonaws/.test(adminRoute));
ok("admin-preview passes the file name through, so downloads keep their extension",
  /q\.set\("name"/.test(adminRoute));
ok("the app CSP still allows only same-origin frames and images (so the above matters)",
  /img-src 'self' data: blob:/.test(csp) && /frame-src 'self' blob:/.test(csp));
ok("no S3 host was added to the CSP as a shortcut", !/amazonaws|s3\./.test(csp));

const getRoute = src("../app/api/storage/get/route.js");
ok("storage/get keeps the sandbox CSP for attachment types",
  getRoute.includes(`"default-src 'none'; sandbox"`));
ok("storage/get only relaxes to allow-scripts for inline-servable types",
  getRoute.includes("isInlineServable(path)") &&
  getRoute.includes(`"default-src 'none'; sandbox allow-scripts"`));
ok("nothing scriptable is inline-servable, which is what makes that safe",
  !isInlineServable("x.html") && !isInlineServable("x.svg") &&
  IMAGE_EXTENSIONS.concat("pdf").every((e) => isInlineServable(`x.${e}`)));

const pane = src("../components/PreviewPane.js");
ok("PreviewPane still renders untrusted HTML in a sandboxed iframe",
  /sandbox=""/.test(pane) && /srcDoc=\{doc\.html\}/.test(pane));
ok("PreviewPane never uses dangerouslySetInnerHTML", !/dangerouslySetInnerHTML/.test(pane));

const office = src("../lib/aws/officepreview.js");
ok("officepreview still escapes by hand and does not use sheet_to_html",
  !/utils\.sheet_to_html/.test(office) && /escapeHtml\(/.test(office));

// ===== 9. one wrong file, one message: the PICKER must refuse what the =======
//        UPLOADER refuses, and say so first.
//
// The bug this pins down: DashboardClient kept its OWN image list
// (png,jpg,jpeg,webp,gif,bmp,tif,tiff) and an accept attribute led by
// `image/*`, so a .tif or .bmp was selectable. It was classed "image", got a
// blob: preview no browser can decode, PreviewPane's onError then reported
// "Document not in storage — the document couldn't be loaded from storage"
// about a file sitting on the user's own disk that had never been uploaded,
// /api/storage/upload rejected it on the extension allowlist as a non-fatal
// amber note, and /api/process ran anyway. Three messages for one file, one of
// them false, and the source document silently detached from a PAYROLL record.
// Same shape for size: no client-side cap at all, so a 40 MB scan previewed
// fine, 413'd into the same amber note, and still went to the AI.
head("regression guard: the picker refuses what the uploader refuses, once");

const dash = src("../components/DashboardClient.js");

ok("the picker gates on uploadProblem() before anything else happens",
  /uploadProblem\(\{\s*name: f\.name, size: f\.size\s*\}\)/.test(dash));
ok("the picker classifies with previewKindOf(), not a local list",
  /previewKindOf\(f\.name\)/.test(dash));
ok("no hand-written image-extension list survives in DashboardClient",
  !/["'](bmp|tiff?)["']/.test(dash));
ok("the accept attribute is derived from ALLOWED_EXTENSIONS",
  /accept=\{ACCEPT_ATTR\}/.test(dash) &&
  /ALLOWED_EXTENSIONS\.map\(\(e\) => `\.\$\{e\}`\)\.join\(","\)/.test(dash));
ok("accept no longer leads with image/*, which offered bmp/tif",
  !/accept="[^"]*image\/\*/.test(dash));
ok("the dropzone states the size limit it will enforce",
  /up to \{MAX_UPLOAD_MB\} MB/.test(dash));
ok("a refused file is not kept, so /api/process can never run on it",
  /const bad = uploadProblem\([\s\S]{0,400}?setFile\(null\)/.test(dash));

// PreviewPane must not blame storage for a file that never left the browser.
ok("a blob: image that fails to decode is called unreadable, not missing",
  /isLocalDoc = !!doc\?\.url\?\.startsWith\("blob:"\)/.test(pane) &&
  /isLocalDoc \? "unreadable" : "missing"/.test(pane));
ok("only a SERVER url can produce the 'not in storage' wording",
  /isLocalDoc \? previewNote\("unreadable"\) : "The document/.test(pane));

// …and the behaviour behind those guards.
for (const ext of ["bmp", "tif", "tiff", "svg", "html", "exe", "zip"]) {
  const p = uploadProblem({ name: `sheet.${ext}`, size: 1000 });
  ok(`.${ext} is refused at pick time with wording`,
    p?.reason === "unsupported" && p.message.includes(`sheet.${ext}`) && p.message.length > 30,
    JSON.stringify(p));
}
for (const ext of ALLOWED_EXTENSIONS) {
  ok(`.${ext} is accepted at pick time (picker and uploader agree)`,
    uploadProblem({ name: `sheet.${ext}`, size: 1000 }) === null);
}
ok("a file with no extension is refused (it would be stored as .bin and 400)",
  uploadProblem({ name: "scan", size: 1000 })?.reason === "unsupported");
ok("0 bytes -> empty, before any upload is attempted",
  uploadProblem({ name: "a.pdf", size: 0 })?.reason === "empty");
ok("over the upload cap -> too_large, before any upload is attempted",
  uploadProblem({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 })?.reason === "too_large");
ok("a 40 MB scan is refused by the picker, not by a 413 after the AI ran",
  uploadProblem({ name: "scan.pdf", size: 40 * 1024 * 1024 })?.reason === "too_large");
ok("exactly at the cap is allowed (the server allows it too)",
  uploadProblem({ name: "a.pdf", size: MAX_UPLOAD_BYTES }) === null);
ok("unknown size is not guessed at", uploadProblem({ name: "a.pdf" }) === null);
ok("the too_large wording names both the file size and the limit",
  /15 MB/.test(uploadProblem({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 }).message) &&
  /16 MB/.test(uploadProblem({ name: "a.pdf", size: 16 * 1024 * 1024 }).message),
  uploadProblem({ name: "a.pdf", size: 16 * 1024 * 1024 }).message);

// The upload ROUTE is the authority; the picker only front-runs it.
const uploadRoute = src("../app/api/storage/upload/route.js");
ok("the upload route still enforces the extension allowlist itself",
  /isAllowedExtension\(path\)/.test(uploadRoute));
ok("the upload route still enforces MAX_UPLOAD_BYTES itself",
  /file\.size > MAX_UPLOAD_BYTES/.test(uploadRoute) && /buf\.length > MAX_UPLOAD_BYTES/.test(uploadRoute));

console.log("\n  file kind   preview kind   outcome");
for (const [a, b, c] of table) console.log(`  .${a.padEnd(10)} ${b.padEnd(14)} ${c}`);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
