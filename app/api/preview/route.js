import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { previewUpload } from "@/lib/engine";

export const maxDuration = 120;

// Best-effort source-document preview. PDFs and images never reach this route
// (the browser renders them natively from the picked file); it exists only for
// Office/CSV files, which need the Python engine's page renderer. Without an
// engine — or if it fails — respond 200 with a graceful "no in-browser preview"
// doc instead of a 5xx: preview is a convenience, never an error.
export async function POST(request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
