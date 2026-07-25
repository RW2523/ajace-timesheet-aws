// File -> model input for the serverless Direct++ flow. Port of
// DirectExtractor._as_model_input (engine/tsengine/direct/extractor.py):
//   - PDF   -> native file part
//   - image -> image part (lightly enhanced when sharp is available)
//   - .eml  -> body TEXT + attachments as their own parts (the body often
//              carries the weekly table / "Approved N hours" line)
//   - .docx -> embedded word/media images (no LibreOffice on Vercel)
//   - .xlsx/.xls/.csv -> extracted sheet TEXT (the serverless trade-off:
//              no PDF render without LibreOffice; text keeps the cells exact)
// Returns {pdf: {filename,dataUrl}|null, images: [dataUrl], extraText: string}.

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]);
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff" };

function ext(name) {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function dataUrl(mime, buf) {
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

export async function buildModelInput(buffer, fileName) {
  const e = ext(fileName);
  if (IMAGE_EXTS.has(e)) {
    return { pdf: null, images: [await prepImage(buffer, e)], extraText: "" };
  }
  if (e === "pdf") {
    return { pdf: { filename: fileName, dataUrl: dataUrl("application/pdf", buffer) },
             images: [], extraText: "" };
  }
  if (e === "eml") return emlInput(buffer);
  if (e === "docx") return docxInput(buffer);
  if (e === "xlsx" || e === "xls") return sheetInput(buffer, fileName);
  if (e === "csv" || e === "txt") {
    return { pdf: null, images: [],
             extraText: Buffer.from(buffer).toString("utf8").slice(0, 40000) };
  }
  return { pdf: null, images: [], extraText: "" };
}

// -- email: body text + attachments -----------------------------------------
async function emlInput(buffer) {
  const { default: PostalMime } = await import("postal-mime");
  let pdf = null;
  const images = [];
  let text = "";
  try {
    const mail = await new PostalMime().parse(buffer);
    const hdr = [
      mail.subject ? `Subject: ${mail.subject}` : "",
      mail.from?.address ? `From: ${mail.from.name || ""} <${mail.from.address}>` : "",
      mail.date ? `Date: ${mail.date}` : "",
    ].filter(Boolean).join("\n");
    let body = mail.text || "";
    if (!body && mail.html) body = mail.html.replace(/<[^>]+>/g, " ");
    text = `${hdr}\n\n${body}`.trim().slice(0, 20000);
    for (const att of mail.attachments || []) {
      const ae = ext(att.filename || "");
      const buf = Buffer.from(att.content);
      if (ae === "pdf" && !pdf) {
        pdf = { filename: att.filename, dataUrl: dataUrl("application/pdf", buf) };
      } else if (IMAGE_EXTS.has(ae)) {
        images.push(await prepImage(buf, ae));
      }
    }
  } catch {
    // unparseable email -> nothing; the route reports "could not convert"
  }
  return { pdf, images, extraText: text };
}

// -- docx: embedded images + document text ----------------------------------
async function docxInput(buffer) {
  const { default: JSZip } = await import("jszip");
  const images = [];
  let text = "";
  try {
    const zip = await JSZip.loadAsync(buffer);
    const doc = zip.file("word/document.xml");
    if (doc) {
      const xml = await doc.async("string");
      text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
    }
    const media = Object.keys(zip.files)
      .filter((n) => n.startsWith("word/media/") && IMAGE_EXTS.has(ext(n)))
      .slice(0, 10);
    for (const name of media) {
      const buf = await zip.file(name).async("nodebuffer");
      images.push(await prepImage(buf, ext(name)));
    }
  } catch {
    // fall through with whatever we got
  }
  return { pdf: null, images, extraText: text };
}

// -- spreadsheets: every sheet as CSV text ----------------------------------
async function sheetInput(buffer, fileName) {
  const XLSX = await import("xlsx");
  let text = "";
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const parts = [];
    for (const name of wb.SheetNames.slice(0, 8)) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
      if (csv.trim()) parts.push(`===== sheet: ${name} =====\n${csv}`);
    }
    text = parts.join("\n\n").slice(0, 60000);
  } catch {
    // unreadable workbook -> nothing
  }
  return { pdf: null, images: [], extraText: text ? `Spreadsheet "${fileName}" contents (CSV per sheet):\n\n${text}` : "" };
}

// -- light image enhancement (faint scans/screenshots) -----------------------
// Uses sharp when present (bundled on Vercel with Next); falls back to the
// original bytes on any failure — enhancement is an optimization, never a gate.
async function prepImage(buffer, e) {
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(buffer, { failOn: "none" });
    const meta = await img.metadata();
    let p = img.rotate();                       // honor EXIF orientation
    if (Math.min(meta.width || 0, meta.height || 0) < 1400) {
      p = p.resize({ width: (meta.width || 700) * 2, kernel: "lanczos3" });
    }
    const out = await p.normalise().png().toBuffer();   // contrast stretch
    return dataUrl("image/png", out);
  } catch {
    return dataUrl(IMAGE_MIME[e] || "image/png", buffer);
  }
}
