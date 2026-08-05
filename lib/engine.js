// Server-side bridge to the Python AI engine (FastAPI /api/process-upload).
// Receives the raw file bytes, forwards them, and normalizes the engine's
// EmployeeMonth into the calendar shape the app edits/stores.

import { enumerateMonth } from "./month.js";
import { holidaysInMonth } from "./holidays.js";
// THE summation now lives in lib/hours.js, next to the bounds it must satisfy —
// re-exported here so the dozens of `import { rollup } from "@/lib/engine"` call
// sites keep working while there is only one copy of the arithmetic.
import { deriveTotals } from "./hours.js";

const ENGINE_URL = process.env.ENGINE_URL || "http://127.0.0.1:8078";
const ENGINE_API_KEY = process.env.ENGINE_API_KEY || "";

// X-API-Key header sent to the engine (required when it's behind a public tunnel)
function engineHeaders() {
  return ENGINE_API_KEY ? { "X-API-Key": ENGINE_API_KEY } : {};
}

export async function processUpload(fileBlob, fileName, month, year, flow) {
  const form = new FormData();
  form.append("file", fileBlob, fileName);
  form.append("month", String(month));
  form.append("year", String(year));
  if (flow) form.append("flow", flow);   // "budget" | "premium" (admin setting)

  const res = await fetch(`${ENGINE_URL}/api/process-upload`, {
    method: "POST",
    body: form,
    headers: engineHeaders(),
    // the LLM pipeline can take a while on scanned docs
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`engine ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

export async function previewUpload(fileBlob, fileName) {
  const form = new FormData();
  form.append("file", fileBlob, fileName);
  const res = await fetch(`${ENGINE_URL}/api/preview-upload`, {
    method: "POST",
    body: form,
    headers: engineHeaders(),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`engine ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// Merge the engine's per-day records onto a full month grid (so every day
// exists, weekends/holidays are marked, and missing days are explicit).
export function buildCalendar(employee, month, year) {
  const grid = enumerateMonth(year, month);
  const hol = holidaysInMonth(year, month);
  const byDate = {};
  for (const d of employee?.days || []) {
    if (d.date) byDate[d.date] = d;
  }
  return grid.map((g) => {
    const src = byDate[g.date] || {};
    const reg = num(src.regular_hours);
    const ot = num(src.overtime_hours);
    // paid but not worked — kept separate so it never counts as billable regular
    const other = (num(src.sick_hours) || 0) + (num(src.vacation_hours) || 0) +
                  (num(src.holiday_hours) || 0);
    let total = num(src.total_hours);
    if (total == null && (reg != null || ot != null || other)) total = (reg || 0) + (ot || 0) + other;
    return {
      date: g.date,
      day: g.day,
      weekday: g.weekdayName,
      isWeekend: g.isWeekend,
      isHoliday: !!hol[g.date],
      holidayName: hol[g.date] || null,
      workedOnHoliday: hol[g.date] ? total != null && total > 0 : false,
      regular: reg,
      overtime: ot,
      other: other || null,
      total: total,
      note: src.note || null,
      filled: reg != null || ot != null || total != null || !!other,
      flagged: Array.isArray(src.issues) && src.issues.length > 0,
    };
  });
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Roll a calendar up to monthly totals.
// THE single hours formula. Everything — the review tiles, what gets stored, the
// payroll export — must go through this. Two different summations used to
// coexist (validate.js added regular+overtime; this used the day's own total),
// so the number an employee reviewed could differ from the number that was paid.
//
// `other` is paid-but-not-worked time (sick / vacation / holiday). It counts
// toward the total the employee is paid, but must NOT inflate billable regular.
export function rollup(cal) {
  return deriveTotals(cal);
}
