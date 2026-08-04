import { NextResponse } from "next/server";
import { createClient } from "@/lib/api/server";
import { processUpload, buildCalendar, rollup } from "@/lib/engine";

export const maxDuration = 300; // allow long LLM runs

export async function POST(request) {
  // must be signed in
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad form data" }, { status: 400 });
  }
  const file = form.get("file");
  const month = parseInt(form.get("month"), 10);
  const year = parseInt(form.get("year"), 10);
  if (!file || !month || !year) {
    return NextResponse.json({ error: "file, month, year required" }, { status: 400 });
  }

  // Admin-chosen AI flow. "consensus" = two independent agreeing derivations
  // (deterministic Key A + blind model Key B) with a $0 printed-total exit;
  // "direct_serverless" = Direct++ ported to THIS serverless function (no
  // Python engine at all); "premium_plus"/"premium"/"direct"/"budget" as
  // before. The admin setting wins; this is only the fallback when no row exists.
  let flow = "consensus";
  try {
    const { data: fs } = await api
      .from("ts_app_settings").select("value").eq("key", "ai_flow").single();
    if (["direct","premium_plus","budget","premium","consensus","direct_serverless"]
        .includes(fs?.value)) flow = fs.value;
  } catch { /* keep default */ }

  // Serverless Direct++ runs when chosen explicitly, forced by env, or when
  // this is a Vercel deployment with no engine configured (pure-Vercel mode).
  const serverless = flow === "direct_serverless" ||
    process.env.DIRECT_SERVERLESS === "true" ||
    (!!process.env.VERCEL && !process.env.ENGINE_URL);
  if (serverless) {
    return processServerless(file, month, year);
  }

  try {
    const result = await processUpload(file, file.name || "upload", month, year, flow);
    const employee = result.employee;
    const calendar = buildCalendar(employee, month, year);
    return NextResponse.json({
      ok: true,
      employee,
      employee_count: result.employee_count,
      calendar,
      totals: rollup(calendar),
      llm_used: result.llm_used,
      flow: result.flow || flow,
      review_status: result.review_status || null,
      // Manager approval, lifted to the top level so the client doesn't have to
      // dig for it. null = this flow never looked (the Python engine has no
      // approval block yet) — which the UI must treat as "ask the employee",
      // never as "approved".
      approval: employee?.approval || null,
      agent_trace: result.agent_trace || null,
      file_name: result.file_name,
      raw_employees: result.employees,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `processing failed: ${e.message || e}` },
      { status: 502 }
    );
  }
}

// -- Direct++ inside this function: no Python engine, no server --------------
async function processServerless(file, month, year) {
  const fileName = file.name || "upload";
  try {
    const { buildModelInput } = await import("@/lib/directpp/input.js");
    const { directExtract } = await import("@/lib/directpp/extractor.js");
    // ITEM 9 — the two stages worth a stopwatch: turning the file into model
    // input (image upsampling is the only non-trivial CPU cost) and the model
    // calls themselves. Timing only; nothing here reads or writes hours.
    const t0 = Date.now();
    const buffer = Buffer.from(await file.arrayBuffer());
    const input = await buildModelInput(buffer, fileName);
    const inputMs = Date.now() - t0;
    const { employee, trace, timings, reason } = await directExtract({
      input, fileName, month, year,
    });
    if (!employee) {
      return NextResponse.json(
        { error: `processing failed: ${reason || "unreadable file"}` },
        { status: 422 }
      );
    }
    const calendar = buildCalendar(employee, month, year);
    return NextResponse.json({
      ok: true,
      employee,
      employee_count: 1,
      calendar,
      totals: rollup(calendar),
      llm_used: true,
      flow: "direct_serverless",
      review_status: employee.review_status,
      approval: employee.approval || null,
      timings: { input_ms: inputMs,
                 model_ms: timings?.model_ms ?? null,
                 total_ms: Date.now() - t0,
                 calls: timings?.calls || [] },
      agent_trace: { file: fileName, flow: "direct_serverless",
                     handled_by: "DirectReader", actions: trace,
                     timings: { input_ms: inputMs,
                                model_ms: timings?.model_ms ?? null,
                                total_ms: Date.now() - t0,
                                calls: timings?.calls || [] } },
      file_name: fileName,
      raw_employees: [employee],
    });
  } catch (e) {
    return NextResponse.json(
      { error: `processing failed: ${e.message || e}` },
      { status: 502 }
    );
  }
}
