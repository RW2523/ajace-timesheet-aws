// Offline self-test for the serverless Direct++ port. No API key needed:
// model calls are mocked; input parsing runs on REAL sample files when present.
//   node lib/directpp/selftest.mjs        (from app/)
import { readFileSync, existsSync } from "node:fs";
import { buildModelInput } from "./input.js";
import { directExtract, CFG } from "./extractor.js";
import { loadsLenient } from "./openrouter.js";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function mega({ days = 17, conf = 0.9, claimed = null, stated = null, month = 4 } = {}) {
  const entries = Array.from({ length: days }, (_, i) => ({
    date: `2026-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
    regular_hours: 8, overtime_hours: 0, total_hours: 8,
  }));
  return {
    document_type: "timesheet", is_timesheet: true,
    employee_name: "Test Person", client: "ACME",
    entries, weekly_totals: [],
    stated_total: stated, confidence: conf,
    self_check: { sum_of_daily_totals: claimed ?? days * 8,
                  matches_stated_total: stated != null, discrepancies: [] },
    ambiguities: [],
  };
}

// fetch mock: routes on the model name in the request body
function mockFetch(script) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const reply = script(body);
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { total_tokens: 100 },
      }),
    };
  };
}

const realFetch = globalThis.fetch;

async function run() {
  console.log("— flow logic (mocked models) —");

  // 1. clean read: clip + code sums; auto verify skipped at conf .95 (pdf, no scan)
  globalThis.fetch = mockFetch(() => mega({ days: 20, conf: 0.95 }));
  let calls = 0;
  const counting = globalThis.fetch;
  globalThis.fetch = async (u, o) => { calls++; return counting(u, o); };
  let r = await directExtract({
    input: { pdf: { filename: "x.pdf", dataUrl: "data:application/pdf;base64,eA==" }, images: [], extraText: "" },
    fileName: "x.pdf", month: 4, year: 2026 });
  ok(r.employee?.monthly_total === 160, "code-computed total = 160");
  ok(calls === 1, `auto-verify skipped on clean confident read (calls=${calls})`);
  ok(r.employee.review_status === "needs_review", "unverified -> needs_review (choke-point)");

  // 2. dedupe: a repeated day collapses
  globalThis.fetch = mockFetch(() => {
    const m = mega({ days: 5, conf: 0.9, stated: 40 });
    m.entries.push({ ...m.entries[0] });
    m.self_check.sum_of_daily_totals = 40;
    return m;
  });
  r = await directExtract({
    input: { pdf: { filename: "x.pdf", dataUrl: "d" }, images: [], extraText: "" },
    fileName: "x.pdf", month: 4, year: 2026 });
  ok(r.employee?.monthly_total === 40, "dedupe: repeated day counted once (40, not 48)");

  // 3. repair: model claims 160 but entries sum 136 -> repair round adopts 20 days
  globalThis.fetch = mockFetch((body) => {
    const sys = String(body.messages[0].content);
    if (sys.includes("double-checking")) return { monthly_total: 160, days_worked: 20, confidence: 0.9 };
    const isRepair = body.messages.some((m) => String(m.content).includes("CHECK: code summed"));
    if (isRepair) return mega({ days: 20, conf: 0.9 });
    return mega({ days: 17, conf: 0.9, claimed: 160, stated: 160 });
  });
  r = await directExtract({
    input: { pdf: { filename: "x.pdf", dataUrl: "d" }, images: [], extraText: "" },
    fileName: "x.pdf", month: 4, year: 2026 });
  ok(r.employee?.monthly_total === 160 &&
     r.employee.notes.some((n) => n.includes("arithmetic repair")),
     "arithmetic repair adopted (136 -> 160)");
  ok(r.employee.verification_status === "confirmed",
     "post-repair verify ran (repair = gray zone) and confirmed");

  // 4. verify disagreement flags for review (scan input -> gray zone)
  globalThis.fetch = mockFetch((body) => {
    const sys = String(body.messages[0].content);
    if (sys.includes("double-checking")) return { monthly_total: 96, days_worked: 12, confidence: 0.8 };
    return mega({ days: 17, conf: 0.92 });
  });
  r = await directExtract({
    input: { pdf: null, images: ["data:image/png;base64,eA=="], extraText: "" },
    fileName: "scan.png", month: 4, year: 2026 });
  ok(r.employee.verification_status !== "confirmed" && r.employee.confidence <= 0.6,
     "verify disagreement -> flagged");

  // 5. verify agreement on gray zone -> confirmed -> auto_accepted
  globalThis.fetch = mockFetch((body) => {
    const sys = String(body.messages[0].content);
    if (sys.includes("double-checking")) return { monthly_total: 136, days_worked: 17, confidence: 0.9 };
    return mega({ days: 17, conf: 0.88 });
  });
  r = await directExtract({
    input: { pdf: { filename: "x.pdf", dataUrl: "d" }, images: [], extraText: "" },
    fileName: "x.pdf", month: 4, year: 2026 });
  ok(r.employee.verification_status === "confirmed" && r.employee.review_status === "auto_accepted",
     "verify agreement -> confirmed -> auto_accepted");

  // 6. invoice rejected
  globalThis.fetch = mockFetch(() => ({ document_type: "invoice", is_timesheet: false }));
  r = await directExtract({
    input: { pdf: { filename: "x.pdf", dataUrl: "d" }, images: [], extraText: "" },
    fileName: "inv.pdf", month: 4, year: 2026 });
  ok(r.employee === null && /not a timesheet/.test(r.reason), "invoice rejected");

  // 7. lenient JSON
  ok(loadsLenient('```json\n{"a":1}\n```')?.a === 1, "lenient JSON parses fenced output");

  globalThis.fetch = realFetch;

  console.log("— input parsing (real files, no API) —");
  const base = "/Users/richardwatsonstephenamudha/Documents/aj_t/TimeSheet-May";
  const cases = [
    [`${base}/May -2026-HEX/Fw_ Timesheet approval request for May 2026.eml`,
      async (inp) => inp.extraText.includes("Approved 160 Hours") || inp.extraText.includes("Total Hours"),
      "eml body text extracted"],
    [`${base}/May -2026-HCPSS/Saravanan TimeSheet-May 2026.xlsx`,
      async (inp) => inp.extraText.includes("sheet:") && inp.extraText.length > 500,
      "xlsx -> CSV text"],
    [`${base}/May 2026- All employees/Justin-Thason-May-Timesheet-2026.docx`,
      async (inp) => inp.images.length > 0,
      "docx -> embedded images"],
    [`${base}/May -2026-HEX/Rajani -TS May -2026.png`,
      async (inp) => inp.images.length === 1 && inp.images[0].startsWith("data:image/"),
      "png -> (enhanced) image part"],
  ];
  for (const [path, check, name] of cases) {
    if (!existsSync(path)) { console.log(`  skip ${name} (file missing)`); continue; }
    const inp = await buildModelInput(readFileSync(path), path.split("/").pop());
    ok(await check(inp), name);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
