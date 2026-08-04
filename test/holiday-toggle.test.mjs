#!/usr/bin/env node
// US-holiday "Worked / Not worked" (ITEM 8) — lib/holidayhours.js + the holiday
// rules in lib/validate.js.
//
// THIS IS PAYROLL, so the question each case asks is not "does the toggle
// work". It is: after the click, what does the SERVER derive? lib/aws/data.js
// recomputes monthly_regular / monthly_overtime / monthly_total / days_worked
// from the submitted `days` and overwrites whatever the client sent, so the only
// thing that matters is what the transformed `days` array makes that derivation
// produce. deriveTotals below is a copy of the closure in lib/aws/data.js
// (~line 107); if that changes, this file must too.
//
// Needs no database, no network and no build.  Run: node test/holiday-toggle.test.mjs

import assert from "node:assert/strict";
import {
  clearWorkedHours, restoreWorkedHours, setWorkedHours, workedHoursOf, applyToDate,
} from "../lib/holidayhours.js";
import { validateTimesheet } from "../lib/validate.js";

// --- copy of lib/aws/data.js deriveTotals ------------------------------------
const deriveTotals = (days) => {
  let regular = 0, overtime = 0, other = 0, daysWorked = 0;
  for (const d of Array.isArray(days) ? days : []) {
    const reg = Number(d?.regular) || 0;
    const ot = Number(d?.overtime) || 0;
    const oth = Number(d?.other) || 0;
    regular += reg; overtime += ot; other += oth;
    if (reg + ot + oth > 0) daysWorked += 1;
  }
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  return { regular: r2(regular), overtime: r2(overtime), other: r2(other),
           total: r2(regular + overtime + other), daysWorked };
};

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message); }
}

const JUL4 = "2026-07-04";
const holidays = { [JUL4]: "Independence Day" };
const holiday = (over) => ({
  date: JUL4, day: 4, weekday: "Sat", isWeekend: false, isHoliday: true,
  holidayName: "Independence Day", regular: null, overtime: null, other: null,
  total: null, filled: false, workedOnHoliday: false, ...over,
});

console.log("holiday toggle — what the server derives");

// ---------------------------------------------------------------------------
// 1. "Not worked" must actually REMOVE the worked hours. The blocker was that
//    it only flipped a label: the day read "not worked" and was still paid.
// ---------------------------------------------------------------------------
test("Not worked drops 8h of worked time from what the server pays", () => {
  const before = [holiday({ regular: 8, total: 8, filled: true, workedOnHoliday: true })];
  assert.equal(deriveTotals(before).total, 8);

  const after = applyToDate(before, JUL4, clearWorkedHours);
  const t = deriveTotals(after);
  assert.equal(t.regular, 0, "regular hours must leave the days array");
  assert.equal(t.total, 0);
  assert.equal(t.daysWorked, 0);
  assert.equal(after[0].filled, false);
  assert.equal(after[0].workedOnHoliday, false);
});

test("Not worked drops overtime too, not just regular", () => {
  const before = [holiday({ regular: 6, overtime: 2, total: 8, filled: true })];
  const t = deriveTotals(applyToDate(before, JUL4, clearWorkedHours));
  assert.deepEqual([t.regular, t.overtime, t.total], [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// 2. ...but it must NOT delete holiday pay. `other` is paid-but-not-worked
//    time, and app/api/admin/export pays total = regular + overtime + other.
//    Clearing it would cut 8h off the cheque of everyone who honestly said they
//    did not work a federal holiday.
// ---------------------------------------------------------------------------
test("Not worked KEEPS holiday pay — the cheque does not shrink", () => {
  const before = [holiday({ regular: 8, other: 8, total: 16, filled: true })];
  const after = applyToDate(before, JUL4, clearWorkedHours);
  const t = deriveTotals(after);
  assert.equal(t.regular, 0, "the 8h of work is gone");
  assert.equal(t.other, 8, "the 8h of holiday pay is NOT gone");
  assert.equal(t.total, 8);
  assert.equal(t.daysWorked, 1, "still a paid day");
  assert.equal(after[0].filled, true, "so the day does not render as empty");
});

test("a holiday with ONLY holiday pay is untouched by Not worked", () => {
  const before = [holiday({ other: 8, total: 8, filled: true })];
  const t = deriveTotals(applyToDate(before, JUL4, clearWorkedHours));
  assert.equal(t.total, 8);
});

// ---------------------------------------------------------------------------
// 3. "Worked" looks the hours up from what the AI read, keeping the document's
//    own regular/overtime SPLIT. Merging 6+2 into 8 regular keeps the total
//    right while silently dropping the overtime premium.
// ---------------------------------------------------------------------------
test("Worked restores the document's regular/overtime split, not a merged total", () => {
  const cleared = applyToDate(
    [holiday({ regular: 6, overtime: 2, total: 8, filled: true })], JUL4, clearWorkedHours);
  const baseline = holiday({ regular: 6, overtime: 2, total: 8, filled: true });

  const back = applyToDate(cleared, JUL4, (c) => restoreWorkedHours(c, baseline));
  const t = deriveTotals(back);
  assert.equal(t.regular, 6, "overtime must not be folded into regular");
  assert.equal(t.overtime, 2, "the overtime premium survives the round trip");
  assert.equal(t.total, 8);
  assert.equal(back[0].workedOnHoliday, true);
});

test("Worked restores nothing when the document had no worked hours", () => {
  const day = holiday({ other: 8, total: 8, filled: true });
  // a baseline carrying only holiday PAY is not evidence of work
  assert.deepEqual(restoreWorkedHours(day, holiday({ other: 8 })), day);
  assert.deepEqual(restoreWorkedHours(day, null), day);
});

test("restoring onto a day that kept its holiday pay adds, never replaces", () => {
  const day = holiday({ other: 8, total: 8, filled: true });
  const t = deriveTotals([restoreWorkedHours(day, holiday({ regular: 4 }))]);
  assert.equal(t.regular, 4);
  assert.equal(t.other, 8, "holiday pay still there");
  assert.equal(t.total, 12);
});

// ---------------------------------------------------------------------------
// 4. Typing in the card's hours box. It edits REGULAR only and carries the
//    day's existing overtime through — it is not where overtime is edited, so
//    it must not zero it.
// ---------------------------------------------------------------------------
test("typing regular hours does not zero the overtime beside it", () => {
  const day = holiday({ regular: 4, overtime: 2, total: 6, filled: true });
  const t = deriveTotals([setWorkedHours(day, { regular: 7, overtime: day.overtime })]);
  assert.equal(t.regular, 7);
  assert.equal(t.overtime, 2);
  assert.equal(t.total, 9);
});

test("clearing the box leaves no worked hours but keeps holiday pay", () => {
  const day = holiday({ regular: 8, other: 8, total: 16, filled: true });
  const out = setWorkedHours(day, { regular: "", overtime: null });
  const t = deriveTotals([out]);
  assert.equal(t.regular, 0);
  assert.equal(t.other, 8);
  assert.equal(out.workedOnHoliday, false);
});

test("hours are rounded to cents-of-an-hour, not float noise", () => {
  const out = setWorkedHours(holiday({ other: 0.2 }), { regular: 0.1 });
  assert.equal(out.total, 0.3);
});

// ---------------------------------------------------------------------------
// 5. workedHoursOf never counts `other` as work.
// ---------------------------------------------------------------------------
test("workedHoursOf ignores holiday/PTO pay", () => {
  assert.equal(workedHoursOf(holiday({ other: 8 })), 0);
  assert.equal(workedHoursOf(holiday({ regular: 6, overtime: 2, other: 8 })), 8);
});

// ---------------------------------------------------------------------------
// 6. validate.js must agree, or the employee gets a warning they cannot clear.
//    Its holiday checks read WORKED hours; against c.total (which includes
//    `other`) every paid holiday warned "has 8h in the calendar, but it isn't
//    marked as worked" and the only way to silence it was to delete real pay.
// ---------------------------------------------------------------------------
const baseQ = {
  regularHours: 0, overtimeHours: 0, workedWeekends: "no",
  managerApproval: "acknowledged_absent", managerApprovalAck: true,
};
const check = (calendar, holidayWork, q = {}) => validateTimesheet({
  fields: { employee_name: "A", client: "C" },
  calendar, questionnaire: { ...baseQ, ...q }, holidayWork, holidays,
});

test("a not-worked holiday carrying only holiday pay raises NO warning", () => {
  const v = check([holiday({ other: 8, total: 8, filled: true })], { [JUL4]: false });
  assert.equal(v.warnings.filter((w) => w.includes("Independence Day")).length, 0,
    "got: " + JSON.stringify(v.warnings));
});

test("a not-worked holiday that still has WORKED hours does warn", () => {
  const v = check([holiday({ regular: 8, total: 8, filled: true })], { [JUL4]: false });
  assert.equal(v.warnings.some((w) => w.includes("Independence Day")), true);
});

test("marking Worked with only holiday pay on the day is an ERROR", () => {
  const v = check([holiday({ other: 8, total: 8, filled: true })], { [JUL4]: true },
    { regularHours: 0, overtimeHours: 0 });
  assert.equal(v.errors.some((e) => e.includes("Independence Day")), true,
    "8h of holiday PAY must not satisfy 'I worked it'");
  assert.equal(v.ok, false);
});

test("marking Worked with real worked hours passes", () => {
  const v = check([holiday({ regular: 8, total: 8, filled: true })], { [JUL4]: true },
    { regularHours: 8, overtimeHours: 0 });
  assert.equal(v.errors.some((e) => e.includes("Independence Day")), false,
    "got: " + JSON.stringify(v.errors));
});

// ---------------------------------------------------------------------------
// 7. End to end: the click sequence the operator described.
// ---------------------------------------------------------------------------
test("full round trip: 8h worked -> Not worked -> Worked -> back to 8h", () => {
  const start = [holiday({ regular: 8, total: 8, filled: true, workedOnHoliday: true })];
  const baseline = { ...start[0] };

  const off = applyToDate(start, JUL4, clearWorkedHours);
  assert.equal(deriveTotals(off).total, 0);
  assert.equal(check(off, { [JUL4]: false }).warnings
    .some((w) => w.includes("Independence Day")), false, "no unclearable warning");

  const on = applyToDate(off, JUL4, (c) => restoreWorkedHours(c, baseline));
  assert.equal(deriveTotals(on).total, 8, "the hours come back, unchanged");
  assert.deepEqual(deriveTotals(on), deriveTotals(start));
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
