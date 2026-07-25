import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { previewUpload } from "@/lib/engine";
import { renderOfficePreview, isOfficePreviewable } from "@/lib/aws/officepreview";

export const maxDuration = 120;

// Best-effort source-document preview. PDFs and images never reach this route
// (the browser renders them natively from the picked file); it exists only for
// Office/CSV files, which need the Python engine's page renderer. Without an
// engine — or if it fails — respond 200 with a graceful "no in-browser preview"
// doc instead of a 5xx: preview is a convenience, never an error.
export async function POST(request) {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const fallback = { doc: { kind: "other" } };
  const name = file.name || "upload";

  // Spreadsheets and Word documents render in-process (SheetJS / mammoth) — no
  // Python engine and no LibreOffice needed. This is the common case: most
  // timesheets arrive as .xlsx.
  if (isOfficePreviewable(name)) {
    const doc = await renderOfficePreview(Buffer.from(await file.arrayBuffer()), name);
    if (doc) return NextResponse.json({ doc });
  }

  if (!process.env.ENGINE_URL) {
    return NextResponse.json(fallback);   // pure-serverless deployment
  }
  try {
    const result = await previewUpload(file, file.name || "upload");
    if (result?.pages?.length) return NextResponse.json(result);
    return NextResponse.json(fallback);
  } catch {
    return NextResponse.json(fallback);
  }
}
