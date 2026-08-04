#!/usr/bin/env node
// Bulk weekday fill (lib/fill.js) — the manual-entry shortcut.
//
// THIS IS PAYROLL, so the point of this file is not "the button works". It is:
// after a bulk fill, what does the SERVER derive? lib/aws/data.js recomputes
// monthly_regular / monthly_overtime / monthly_total / days_worked from the
// submitted `days` and overwrites whatever the client sent, so the only thing
// that matters is what the filled `days` array makes that derivation produce.
// deriveTotals below is a byte-for-byte copy of the closure in
// lib/aws/data.js (~line 109); if that ever changes, this test must too.
//
// Needs no database, no network and no build.  Run: node test/bulk-fill.test.mjs

import assert from "node:assert/strict";
import { buildCalendar, rollup } from "../lib/engine.js";
import { emptyWeekdays, fillEmptyWeekdays, isEmptyWeekday } from "../lib/fill.js";

// --- verbatim copy of lib/aws/data.js deriveTotals ---------------------------
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
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

// March 2026: 31 days, 22 weekdays, no US federal holiday. Exactly the empty
// grid startManual() produces — buildCalendar(null, …), no extraction.
const MONTH = 3, YEAR = 2026;
const empty = buildCalendar(null, MONTH, YEAR);

console.log("bulk weekday fill");

test("the manual grid really does start with every weekday missing", () => {
  const weekdays = empty.filter((c) => !c.isWeekend && !c.isHoliday);
  assert.equal(weekdays.length, 22, "March 2026 should have 22 weekdays");
  assert.equal(emptyWeekdays(empty).length, 22, "all 22 should count as empty");
  assert.equal(rollup(empty).total, 0);
});

test("one fill turns the whole month into what the server will pay", () => {
  const { days, filled, error } = fillEmptyWeekdays(empty, 8);
  assert.equal(error, null);
  assert.equal(filled, 22);
  const t = deriveTotals(days);
  assert.equal(t.regular, 176, "22 weekdays x 8h");
  assert.equal(t.overtime, 0, "bulk fill must never invent overtime");
  assert.equal(t.other, 0);
  assert.equal(t.total, 176);
  assert.equal(t.daysWorked, 22);
  // the client's own rollup and the server's derivation must not disagree
  const r = rollup(days);
  assert.deepEqual(
    { regular: r.regular, overtime: r.overtime, total: r.total, daysWorked: r.daysWorked },
    { regular: t.regular, overtime: t.overtime, total: t.total, daysWorked: t.daysWorked },
  );
  assert.equal(emptyWeekdays(days).length, 0, "no amber weekdays left");
});

test("weekends and holidays are never given hours", () => {
  const { days } = fillEmptyWeekdays(empty, 8);
  for (const c of days) {
    if (c.isWeekend || c.isHoliday) {
      assert.equal(c.regular, null, `${c.date} (weekend/holiday) must stay empty`);
      assert.equal(c.total, null);
      assert.equal(c.filled, false);
    }
  }
  // ...and a month that HAS a federal holiday leaves it for the Worked /
  // Not-worked toggles. July 2026: the 3rd is the observed Independence Day.
  const july = buildCalendar(null, 7, 2026);
  const hol = july.filter((c) => c.isHoliday);
  assert.ok(hol.length > 0, "July 2026 should contain a federal holiday");
  const out = fillEmptyWeekdays(july, 8).days;
  for (const c of out.filter((x) => x.isHoliday)) {
    assert.equal(c.regular, null, `${c.date} is a holiday and must not be auto-filled`);
    assert.equal(c.workedOnHoliday, false);
  }
});

test("a day that already has anything on it is left alone", () => {
  const before = empty.map((c) => ({ ...c }));
  // an AI-extracted 6h day, an explicit 0 ("I did not work"), and a PTO day
  const extracted = before.find((c) => !c.isWeekend && !c.isHoliday);
  Object.assign(extracted, { regular: 6, total: 6, filled: true });
  const zeroed = before.filter((c) => !c.isWeekend && !c.isHoliday)[1];
  Object.assign(zeroed, { regular: 0, total: 0, filled: true });
  const pto = before.filter((c) => !c.isWeekend && !c.isHoliday)[2];
  Object.assign(pto, { regular: null, other: 8, total: 8, filled: true });

  assert.equal(isEmptyWeekday(extracted), false);
  assert.equal(isEmptyWeekday(zeroed), false, "an explicit 0 is an answer, not a gap");
  assert.equal(isEmptyWeekday(pto), false);

  const { days, filled } = fillEmptyWeekdays(before, 8);
  assert.equal(filled, 19, "22 weekdays minus the 3 already answered");
  const out = (d) => days.find((c) => c.date === d);
  assert.equal(out(extracted.date).regular, 6, "AI reading must survive");
  assert.equal(out(zeroed.date).regular, 0, "an explicit 0 must survive");
  assert.equal(out(pto.date).other, 8, "paid time off must survive");
  assert.equal(out(pto.date).regular, null);

  const t = deriveTotals(days);
  assert.equal(t.regular, 19 * 8 + 6, "only the empty days gained hours");
  assert.equal(t.other, 8, "PTO untouched");
  assert.equal(t.total, 19 * 8 + 6 + 8);
  assert.equal(t.daysWorked, 19 + 1 + 1, "the explicit-0 day is still not a worked day");
});

test("existing overtime on a filled day is preserved in the day total", () => {
  // defensive: `filled` should never be false while overtime sits on the day,
  // but if it ever were, the fill must add to it rather than erase it.
  const cal = empty.map((c) => ({ ...c }));
  const d = cal.find((c) => !c.isWeekend && !c.isHoliday);
  d.overtime = 2; // still filled === false
  const { days } = fillEmptyWeekdays(cal, 8);
  const hit = days.find((c) => c.date === d.date);
  assert.equal(hit.regular, 8);
  assert.equal(hit.overtime, 2);
  assert.equal(hit.total, 10, "total = regular + overtime + other");
  assert.equal(deriveTotals(days).overtime, 2, "the fill must not drop overtime");
});

test("out-of-range hours are refused, not silently clamped", () => {
  for (const bad of ["", "abc", 0, -1, 25, NaN, null, undefined]) {
    const { days, filled, error } = fillEmptyWeekdays(empty, bad);
    assert.ok(error, `${String(bad)} should be rejected`);
    assert.equal(filled, 0);
    assert.equal(days, empty, "the calendar must be returned untouched");
    assert.equal(rollup(days).total, 0);
  }
});

test("fractional hours round to cents, not to floating-point noise", () => {
  const { days } = fillEmptyWeekdays(empty, 7.35);
  const t = deriveTotals(days);
  assert.equal(t.regular, 161.7, "22 x 7.35");
  assert.equal(days.find(isEmptyWeekday), undefined);
});

test("filling twice is a no-op and never doubles anyone's hours", () => {
  const once = fillEmptyWeekdays(empty, 8).days;
  const twice = fillEmptyWeekdays(once, 8);
  assert.equal(twice.filled, 0);
  assert.ok(twice.error, "should say there is nothing to fill");
  assert.equal(deriveTotals(twice.days).total, 176, "still 176, not 352");
});

test("the input array is never mutated", () => {
  const snapshot = JSON.stringify(empty);
  fillEmptyWeekdays(empty, 8);
  assert.equal(JSON.stringify(empty), snapshot);
});

if (failures) { console.error(`\nbulk-fill: ${failures} failure(s)`); process.exit(1); }
console.log("bulk-fill: all checks passed");
