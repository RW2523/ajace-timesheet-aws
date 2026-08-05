// The US-holiday "Worked / Not worked" hour transforms (ITEM 8).
//
// THIS IS PAYROLL. Each function below takes ONE day out of the `days` array
// and returns a new one; `days` is what submit() posts and what
// lib/aws/data.js deriveTotals() re-derives monthly_regular / monthly_overtime /
// monthly_total / days_worked from, overwriting anything the client claims. So
// these transforms ARE the pay change — nothing here computes a monthly figure,
// and nothing else in the UI may edit a holiday's hours.
//
// They live in lib/ rather than inside DashboardClient.js so they can be tested
// without a browser, a build or a database — see test/holiday-toggle.test.mjs.
//
// THE TWO KINDS OF HOURS, NEVER MERGED:
//   regular + overtime = WORKED hours. "Did you work this holiday?" is only ever
//                        a question about these.
//   other              = PAID-BUT-NOT-WORKED time: holiday pay, PTO, sick. It is
//                        paid — app/api/admin/export sums
//                        total = regular + overtime + other — but it is not work.
// Answering "did you work?" with a reading that includes `other` (c.total, or
// Calendar.js dayHours()) treats holiday pay as work, which is what made the
// toggles disagree with the calendar in the first place.

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// WORKED hours on a day. The counterpart to Calendar.js dayHours(), which adds
// `other` because that is how a day is PAID.
export function workedHoursOf(day) {
  return round2((Number(day?.regular) || 0) + (Number(day?.overtime) || 0));
}

// Paid-but-not-worked hours sitting on a day.
export function otherHoursOf(day) {
  return round2(Number(day?.other) || 0);
}

// "Not worked" — the day is emptied: worked hours AND the paid-but-not-worked
// hours both leave `days`.
//
// OPERATOR DECISION, 2026-08-05: "not worked should remove the holiday pay".
// This function previously kept `other` on the reasoning that "I didn't work it"
// is not "don't pay me for it" — a defensible default, but it is a policy call
// about what people are paid and it belongs to the operator, not to this file.
// AJACE does not pay a holiday that was not worked, so the day goes to zero.
//
// Everything on the day goes, not just `regular`: leaving `other` behind would
// mean the calendar still showed 8 paid hours on a day the employee has just
// declared they did not work, and app/api/admin/export sums
// total = regular + overtime + other, so those hours WOULD be paid.
//
// This is reversible: "Worked" restores from the extraction's own baseline (see
// restoreWorkedHours), and DayModal can still set any of the three by hand for
// the genuine exception — a holiday taken as PTO, say.
export function clearWorkedHours(day) {
  return {
    ...day,
    regular: null,
    overtime: null,
    other: null,
    total: null,
    filled: false,
    workedOnHoliday: false,
    flagged: false,
  };
}

// "Worked" — undo for a mis-clicked "Not worked": put back what the document
// said, as the extraction's own regular/overtime SPLIT. Merging 6h regular + 2h
// overtime into 8h regular would keep monthly_total right while silently
// dropping the overtime premium from someone's pay.
//
// Returns the day UNCHANGED when there is nothing to restore, so a caller can
// never invent hours: with no baseline the employee types them instead.
//
// `other`: the DAY's value wins, and the baseline is the fallback.
//
// Both directions matter and they pull opposite ways. Since "Not worked" clears
// `other`, reading it off the cleared day alone would always find null and a
// mis-click would permanently cost the employee whatever paid-not-worked hours
// the document recorded — so the baseline has to be consulted. But a value
// sitting on the day was put there deliberately in DayModal, and the baseline
// is only what the AI first read, so the baseline must not overwrite it.
// Day-first-then-baseline satisfies both; taking either one alone does not.
export function restoreWorkedHours(day, source) {
  const worked = workedHoursOf(source);
  if (!source || worked <= 0) return day;
  const oth = (Number(day?.other) || 0) || (Number(source?.other) || 0);
  return {
    ...day,
    regular: source.regular ?? null,
    overtime: source.overtime ?? null,
    other: oth > 0 ? round2(oth) : null,
    total: round2(worked + oth),
    filled: true,
    workedOnHoliday: !!day?.isHoliday,
    flagged: false,
  };
}

// Explicit hours for one day, same shape DayModal.save() produces.
//
// The holiday card's box types REGULAR only and passes the day's existing
// overtime straight back through, so typing in it cannot zero the overtime
// beside it. A blank box means "no hours", not "zero the day": `other` survives.
export function setWorkedHours(day, { regular, overtime } = {}) {
  const n = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const r = n(regular);
  const o = n(overtime);
  const oth = Number(day?.other) || 0;
  const any = r != null || o != null || oth > 0;
  return {
    ...day,
    regular: r,
    overtime: o,
    total: any ? round2((r || 0) + (o || 0) + oth) : null,
    filled: any,
    // WORKED hours decide this flag, not the total: the total carries `other`,
    // so a paid-but-not-worked holiday would otherwise mark itself worked and
    // contradict the toggle the employee just set.
    workedOnHoliday: day?.isHoliday ? (r || 0) + (o || 0) > 0 : false,
    flagged: false,
  };
}

// Apply one of the transforms above to a single date in a `days` array.
export function applyToDate(days, date, fn) {
  return (days || []).map((c) => (c.date === date ? fn(c) : c));
}
