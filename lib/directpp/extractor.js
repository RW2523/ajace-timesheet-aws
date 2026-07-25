// Serverless Direct++ — a 1:1 port of engine/tsengine/direct/extractor.py.
// One file -> primary read (model ladder) -> code-side clip/dedupe/summing ->
// one-shot arithmetic repair -> accept gate -> conditional cross-family blind
// verify -> review routing. No Python, no OCR, no server: just model calls.

import { chatJson, fileMessage } from "./openrouter.js";
import { daysInMonth, directExtractSystem, directRepairMessage,
         directVerifySystem } from "./prompts.js";

// mirror engine settings defaults (tsengine/settings.py)
export const CFG = {
  ladder: ["openai/gpt-5.4-nano", "openai/gpt-5.4-mini", "openai/gpt-5"],
  minConfidence: 0.75,
  autoAcceptConfidence: 0.85,
  agreementTolerance: 2.0,
  blockSpread: 5.0,                // cross-model spread above this hard-blocks
  verifyModel: "openai/gpt-5.4-mini",
  verifyMode: "auto",              // auto | always | off
  repair: true,
  ceilingHours: 230,
};

const USER_TEXT = "Extract the full mega-contract JSON for this document now.";

function userText(extraText) {
  if (!extraText) return USER_TEXT;
  return USER_TEXT + "\n\nThe document is an EMAIL or extracted text; its " +
    "content follows (attachments are included as file/image parts):\n\n" + extraText;
}

// ---------------------------------------------------------------------------
export async function directExtract({ input, fileName, month, year }) {
  const trace = [];
  const act = (agent, action, detail = "", model = null, ok = true) =>
    trace.push({ agent, action, detail: String(detail).slice(0, 300), model, ok });

  const { pdf, images, extraText } = input;
  if (!pdf && images.length === 0 && !extraText) {
    act("DirectReader", "rejected", "could not convert file for the model", null, false);
    return { employee: null, trace, reason: "could not convert file for the model" };
  }

  const system = directExtractSystem(month, year);
  let best = null;
  let bestData = null;
  const totalsSeen = [];
  let repaired = false;

  for (const model of CFG.ladder) {
    const { data, text, error } = await chatJson(model,
      [{ role: "system", content: system },
       fileMessage(userText(extraText), pdf, images)]);
    if (!data) {
      act("DirectReader", "escalated", `${model}: ${error || "no/invalid JSON"}`, model, false);
      continue;
    }
    if (data.is_timesheet === false || ["invoice", "other"].includes(data.document_type)) {
      act("DirectReader", "rejected", `${model}: document_type=${data.document_type}`, model, false);
      return { employee: null, trace, reason: `not a timesheet (${data.document_type})` };
    }

    let res = mapContract(data, month, year, model, act);

    // ARITHMETIC REPAIR (one shot per file): the code-computed sum of the
    // model's own entries disagrees with what the model claimed.
    if (CFG.repair && !repaired && needsRepair(data, res)) {
      repaired = true;
      const fixed = await repairRound(model, system, pdf, images, extraText,
                                      text, data, res, month, year, act);
      if (fixed) { res = fixed.res; Object.assign(data, fixed.data); }
    }

    if (res.total > 0) totalsSeen.push(res.total);

    const [ok, reason] = acceptGate(data, res);
    act("DirectReader", ok ? "accepted" : "escalated", reason, model, ok);
    if (ok) { best = res; bestData = data; break; }
    if (!best || res.total > best.total) { best = res; bestData = data; }
  }

  if (!best) {
    act("DirectReader", "rejected", "all models failed", null, false);
    return { employee: null, trace, reason: "all models failed" };
  }

  // cross-model disagreement, graded by size: a small spread (<=5h) on two
  // otherwise-plausible reads means "have a human glance" (needs_review), not
  // "blocked" -- only a real divergence hard-blocks. Either way the second
  // model already served as an independent opinion, so the verify call is
  // redundant and skipped.
  let spread = 0;
  if (totalsSeen.length >= 2) {
    spread = Math.max(...totalsSeen) - Math.min(...totalsSeen);
    if (spread > CFG.blockSpread) {
      best.notes.push(`models disagreed on monthly total by ${round2(spread)}h`);
      best.needsReview = true;
    } else if (spread > CFG.agreementTolerance) {
      best.notes.push(
        `models differed slightly on the monthly total (${round2(spread)}h) -- flagged for review`);
      best.confidence = Math.min(best.confidence, 0.8);   // -> needs_review, not blocked
    }
  }

  // conditional cross-family blind verify (skipped when two models already voted)
  if (spread <= CFG.agreementTolerance &&
      shouldVerify(best, images, repaired) && best.total > 0) {
    await verifyRound(best, pdf, images, extraText, month, year, act);
  }

  return { employee: shapeEmployee(best, bestData, fileName, month, year), trace, reason: null };
}

// -- contract -> normalized read (clip to month + dedupe, sums in code) ------
function mapContract(data, month, year, model, act) {
  const mm = String(month).padStart(2, "0");
  const prefix = `${year}-${mm}-`;
  const nd = daysInMonth(month, year);
  const byDate = new Map();
  let dropped = 0, conflicts = 0;
  for (const ent of data.entries || []) {
    const d = normDate(ent.date, month, year);
    if (!d || !d.startsWith(prefix)) continue;              // clip to month
    const day = Number(d.slice(8, 10));
    if (!(day >= 1 && day <= nd)) continue;
    const total = num(ent.total_hours) ?? sumParts(ent);
    if (byDate.has(d)) {                                    // dedupe in code
      dropped++;
      if ((byDate.get(d).total || 0) !== (total || 0)) conflicts++;
      continue;
    }
    // an unsplit day total counts as regular time (mirror the engine's
    // split_regular_overtime), so summary tiles don't show "Regular 0".
    let reg = num(ent.regular_hours);
    let ot = num(ent.overtime_hours);
    if (total != null && reg == null && ot == null) { reg = total; ot = 0; }
    byDate.set(d, {
      date: d,
      regular_hours: reg,
      overtime_hours: ot,
      total_hours: total,
      note: ent.note || null,
      raw: ent.raw || null,
      total,
    });
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const worked = days.filter((e) => (e.total || 0) > 0).length;
  const total = round2(days.reduce((s, e) => s + (e.total || 0), 0));
  const notes = [];
  // a printed total implausibly small next to a full daily grid is a misread of
  // some other box ("Total hours in the day 8:00"), not the month's total --
  // discard it instead of raising a false TOTAL_MISMATCH (and instead of letting
  // it trigger a pointless repair round).
  let statedTotal = num(data.stated_total);
  if (statedTotal != null && days.length && total >= 40 &&
      statedTotal < 40 && statedTotal < 0.5 * total) {
    notes.push(`discarded implausible printed total ${statedTotal}h ` +
      `(the daily grid sums to ${total}h)`);
    statedTotal = null;
  }
  if (dropped) {
    const n = `deduped ${dropped} repeated day entr${dropped === 1 ? "y" : "ies"}` +
      (conflicts ? ` (${conflicts} conflicting -- kept the first reading)` : "");
    notes.push(n);
    act("DirectReader", "deduped", n, model);
  }
  for (const a of data.ambiguities || []) notes.push(`ambiguity: ${a}`);
  for (const d of data.self_check?.discrepancies || []) notes.push(`self-check: ${d}`);
  return {
    model, days, worked, total, notes,
    statedTotal,
    confidence: num(data.confidence) ?? 0.65,
    needsReview: conflicts > 2,
    verification: "unverified",
  };
}

function needsRepair(data, res) {
  if (!res.days.length) return false;
  const tol = CFG.agreementTolerance;
  const claimed = num(data.self_check?.sum_of_daily_totals);
  if (claimed != null && Math.abs(claimed - res.total) > tol) return true;
  if (data.self_check?.matches_stated_total && res.statedTotal != null &&
      Math.abs(res.statedTotal - res.total) > tol) return true;
  return false;
}

async function repairRound(model, system, pdf, images, extraText, rawText,
                           data, res, month, year, act) {
  const msg = directRepairMessage(res.total, res.worked,
    data.self_check?.sum_of_daily_totals ?? null, data.stated_total ?? null);
  const { data: fixedData } = await chatJson(model, [
    { role: "system", content: system },
    fileMessage(userText(extraText), pdf, images),
    { role: "assistant", content: String(rawText).slice(0, 30000) },
    { role: "user", content: msg },
  ]);
  if (!fixedData) { act("DirectRepair", "failed", "no corrected JSON", model, false); return null; }
  const fixed = mapContract(fixedData, month, year, model, act);
  if (!fixed.days.length) {
    act("DirectRepair", "rejected", "correction lost the entries", model, false);
    return null;
  }
  fixed.notes.push(`arithmetic repair: entries re-read (${res.total}h -> ${fixed.total}h)`);
  act("DirectRepair", "corrected", `${res.total}h -> ${fixed.total}h`, model);
  return { res: fixed, data: fixedData };
}

function acceptGate(data, res) {
  const conf = num(data.confidence) ?? res.confidence ?? 0;
  const hasData = res.days.length > 0 || res.statedTotal != null;
  if (!hasData) return [false, "no usable data"];
  if (conf < CFG.minConfidence) return [false, `confidence ${conf.toFixed(2)} < ${CFG.minConfidence}`];
  if (res.worked > 23 || res.total > 300 || (res.days.length && res.total < 8)) {
    return [false, `implausible (${res.total}h/${res.worked}d)`];
  }
  if (res.days.length && res.total < 40 && res.statedTotal == null) {
    return [false, `suspiciously sparse (${res.total}h/${res.worked}d, no printed total)`];
  }
  return [true, `confidence ${conf.toFixed(2)}, ${res.total}h/${res.worked}d`];
}

// -- conditional cross-family blind verify ----------------------------------
function shouldVerify(best, images, repaired) {
  if (best.needsReview) return false;
  const mode = CFG.verifyMode;
  if (mode === "off") return false;
  if (mode === "always") return true;
  return best.confidence < 0.9 || images.length > 0 || repaired ||
    (best.total > 0 && best.total < 60 && best.worked < 8);
}

function verifyModelFor(best) {
  if (CFG.verifyModel !== best.model) return CFG.verifyModel;
  return CFG.ladder.find((m) => m !== best.model) || CFG.verifyModel;
}

async function verifyRound(best, pdf, images, extraText, month, year, act) {
  const model = verifyModelFor(best);
  const { data } = await chatJson(model, [
    { role: "system", content: directVerifySystem(month, year) },
    fileMessage("Give the verification JSON now." +
      (extraText ? `\n\nDocument text:\n\n${extraText}` : ""), pdf, images),
  ], { maxTokens: 2000 });
  const vt = num(data?.monthly_total);
  if (vt == null) return;
  if (Math.abs(vt - best.total) <= CFG.agreementTolerance) {
    best.verification = "confirmed";
    best.confidence = Math.max(best.confidence, 0.9);
    best.notes.push(`verified: an independent re-read agrees (${best.total}h ≈ ${vt}h)`);
    act("DirectVerifier", "confirmed", `${best.total}h ≈ ${vt}h`, model);
  } else {
    best.confidence = Math.min(best.confidence, 0.6);
    best.notes.push(`verification DISAGREED: primary ${best.total}h vs re-read ${vt}h -- please confirm`);
    act("DirectVerifier", "disagree", `${best.total}h vs ${vt}h`, model, false);
  }
}

// -- routing + employee shaping (port of the validator's essentials) ---------
function route(best, month, year) {
  const issues = [];
  const weekdays = countWeekdays(month, year);
  if (best.total > CFG.ceilingHours) {
    issues.push({ code: "OUT_OF_RANGE", severity: "warning",
      message: `month total ${best.total}h is unusually high (>${CFG.ceilingHours}h); verify` });
  }
  if (best.worked > weekdays) {
    issues.push({ code: "INVALID", severity: "error",
      message: `${best.worked} days worked exceeds ${weekdays} weekdays in the month` });
  }
  if (best.statedTotal != null && Math.abs(best.statedTotal - best.total) > 0.5 && best.days.length) {
    issues.push({ code: "TOTAL_MISMATCH", severity: "warning",
      message: `source states monthly total ${best.statedTotal} but computed ${best.total}` });
  }
  const hasError = issues.some((i) => i.severity === "error");
  const hasWarning = issues.some((i) => i.severity === "warning");
  let review;
  if (hasError || best.needsReview || best.confidence < 0.6) review = "blocked";
  else if (best.verification !== "confirmed") review = "needs_review";
  else if (hasWarning || best.confidence < CFG.autoAcceptConfidence) review = "needs_review";
  else review = "auto_accepted";
  return { review, issues };
}

function shapeEmployee(best, data, fileName, month, year) {
  const { review, issues } = route(best, month, year);
  const regular = round2(best.days.reduce((s, e) => s + (e.regular_hours || 0), 0));
  const overtime = round2(best.days.reduce((s, e) => s + (e.overtime_hours || 0), 0));
  return {
    employee_name: data?.employee_name || null,
    employee_id: data?.employee_id || null,
    clients: data?.client ? [data.client] : [],
    projects: data?.project ? [data.project] : [],
    month, year,
    days: best.days.map(({ total, ...d }) => ({ ...d, issues: [] })),
    monthly_regular: regular || best.total,
    monthly_overtime: overtime,
    monthly_total: best.total || best.statedTotal || 0,
    days_worked: best.worked,
    confidence: round2(best.confidence),
    flow: "direct_serverless",
    review_status: review,
    verification_status: best.verification,
    issues,
    notes: best.notes,
    source_files: [fileName],
    extraction_methods: [`direct:${best.model}`],
  };
}

// -- small helpers ------------------------------------------------------------
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function sumParts(ent) {
  const parts = ["regular_hours", "overtime_hours", "sick_hours",
    "vacation_hours", "holiday_hours"].map((k) => num(ent[k]) || 0);
  const s = parts.reduce((a, b) => a + b, 0);
  return s > 0 ? s : null;
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function countWeekdays(month, year) {
  const nd = daysInMonth(month, year);
  let c = 0;
  for (let d = 1; d <= nd; d++) {
    const w = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (w !== 0 && w !== 6) c++;
  }
  return c;
}
// Accept ISO or M/D-ish dates the model echoes; anchor to the target month.
function normDate(s, month, year) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (m) {
    let [a, b, y] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : year];
    if (y < 100) y += 2000;
    // choose the order that lands in the target month
    let mo, day;
    if (a === month && b <= 31) { mo = a; day = b; }
    else if (b === month && a <= 31) { mo = b; day = a; }
    else if (a >= 1 && a <= 12) { mo = a; day = b; }
    else { mo = b; day = a; }
    return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}
