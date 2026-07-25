// Server-side bridge to the Python AI engine (FastAPI /api/process-upload).
// Receives the raw file bytes, forwards them, and normalizes the engine's
// EmployeeMonth into the calendar shape the app edits/stores.

import { enumerateMonth } from "@/lib/month";
import { holidaysInMonth } from "@/lib/holidays";

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
    let total = num(src.total_hours);
    if (total == null && (reg != null || ot != null)) total = (reg || 0) + (ot || 0);
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
      total: total,
      note: src.note || null,
      filled: reg != null || ot != null || total != null,
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
export function rollup(cal) {
  let regular = 0, overtime = 0, total = 0, daysWorked = 0;
  for (const c of cal) {
    regular += c.regular || 0;
    overtime += c.overtime || 0;
    const t = c.total != null ? c.total : (c.regular || 0) + (c.overtime || 0);
    total += t;
    if (t > 0) daysWorked += 1;
  }
  return {
    regular: round2(regular),
    overtime: round2(overtime),
    total: round2(total),
    daysWorked,
  };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
