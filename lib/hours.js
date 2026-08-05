// THE hours formula, and the bounds every payable number must satisfy.
//
// This file exists because the summation was hand-copied into four places
// (lib/engine.js rollup, lib/aws/data.js deriveTotals, and the deriveTotals in
// app/api/admin/{timesheet,review}/route.js) and NONE of the four applied a
// sanity bound. Deriving the total server-side stops the browser inventing a
// number, but it does not stop the browser inventing the DAYS: a submission of
// [{regular: -500}] derived faithfully to a total of -500 and, once approved,
// went straight into the payroll CSV, where a downstream import reads a
// negative as a clawback. [{regular: 1000000}] was equally acceptable.
//
// So derivation and validation belong together, in one place. Sum here, bound
// here, and every write path imports both.
//
// No server-only imports: lib/engine.js and lib/validate.js run in the browser
// too, and the employee must see the same limits the server enforces.

// A day is 24 hours. lib/fill.js (MAX_DAY_HOURS) and the DayModal inputs
// (min="0" max="24") already said so; the server simply never checked.
//
// THE BOUND IS PER CALENDAR DATE, NOT PER ARRAY ENTRY. It used to be per entry,
// which meant it was defeated by sending the same date twice: 48h refused as
// [{date:"2026-10-01",regular:48}] sailed through as
// [{date:"2026-10-01",regular:24},{date:"2026-10-01",regular:24}] — HTTP 200,
// approved, 48 payable hours on one calendar day in the payroll CSV. Scaled to
// forty entries dated 2026-06-01 it produced 720 payable hours and "40 days
// worked" in a 30-day month. The only thing standing in the way was the 744h
// monthly backstop, an order of magnitude too loose to notice.
export const MAX_HOURS_PER_DAY = 24;
// 31 * 24. A backstop for the shapes the per-day bound still cannot see — a
// summary correction with no days at all, or a grid whose dates are spread
// across more months than the one being filed.
export const MAX_HOURS_PER_MONTH = 744;

const FIELDS = ["regular", "overtime", "other"];

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// THE calendar date of one entry, or null if it does not have one.
//
// STRICT `YYYY-MM-DD`, because this string is the GROUPING KEY for the per-day
// bound and anything looser reopens the hole it closes: if "2026-10-01" and
// "2026-10-01T00:00:00Z" (or " 2026-10-01") were allowed to be two keys, they
// would be two 24-hour allowances for one day. The round-trip through Date also
// rejects a date that does not exist — "2026-02-30" would otherwise be a key of
// its own, and one nobody reading the CSV could reconcile against a calendar.
//
// This is exactly what every producer already emits: lib/month.js
// enumerateMonth() builds `${year}-${MM}-${DD}` and lib/engine.js buildCalendar()
// carries it through, so no legitimate grid loses an entry to this.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function dayKey(v) {
  if (typeof v !== "string") return null;
  if (!ISO_DATE.test(v)) return null;
  const t = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 10) === v ? v : null;
}

// "" / null / undefined all mean "no hours" (the day grid sends empty inputs
// that way); anything else must parse to a finite number.
function parseField(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const label = (d, i) => (d && typeof d.date === "string" && d.date) || `entry ${i + 1}`;

// Every reason `days` may not be turned into money, in human words. [] = clean.
// Reported, not thrown, so the browser can show them all at once in the review
// screen instead of the employee discovering them one failed save at a time.
export function hoursProblems(days) {
  if (!Array.isArray(days)) return ["The day entries are missing or malformed."];
  const problems = [];
  let total = 0;
  // date -> { hours, entries }. Insertion-ordered, so the problems come out in
  // the order the dates appear in the grid rather than shuffled.
  const byDate = new Map();
  const undated = { hours: 0, entries: 0, which: [] };
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      problems.push(`${label(d, i)}: not a day entry.`);
      continue;
    }
    let dayTotal = 0;
    for (const f of FIELDS) {
      const n = parseField(d[f]);
      if (Number.isNaN(n)) {
        problems.push(`${label(d, i)}: ${f} hours are not a number.`);
        continue;
      }
      if (n < 0) {
        problems.push(`${label(d, i)}: ${f} hours cannot be negative (${n}).`);
        continue;
      }
      if (n > MAX_HOURS_PER_DAY) {
        problems.push(
          `${label(d, i)}: ${n} ${f} hours — a single day cannot exceed ${MAX_HOURS_PER_DAY}.`,
        );
        continue;
      }
      dayTotal += n;
    }
    total += dayTotal;

    // WHICH DAY DO THESE HOURS BELONG TO? Hours that cannot be attributed to a
    // calendar date cannot be checked against the one-day ceiling at all, and
    // "40 entries of 18 hours, no dates" is the same attack with the labels
    // taken off. So an entry that CARRIES HOURS must say which day they were
    // worked. An entry with no hours on it needs no date: it adds nothing to
    // anybody's pay, and refusing it would only break blank rows.
    const date = dayKey(d.date);
    if (date === null) {
      // Collected, not pushed per entry: the shape this refuses is FORTY of them
      // at once, and forty copies of the same sentence is not a review screen
      // anybody reads — validate.js renders every problem it is given.
      if (dayTotal > 0) {
        undated.hours += dayTotal;
        undated.entries += 1;
        if (undated.which.length < 3) undated.which.push(label(d, i));
      }
      continue;
    }
    const agg = byDate.get(date);
    if (agg) { agg.hours += dayTotal; agg.entries += 1; }
    else byDate.set(date, { hours: dayTotal, entries: 1 });
  }

  if (undated.entries > 0) {
    const which = undated.which.join(", ") +
      (undated.entries > undated.which.length ? `, and ${undated.entries - undated.which.length} more` : "");
    problems.push(
      `${undated.entries} ${undated.entries === 1 ? "entry carries" : "entries carry"} ` +
      `${round2(undated.hours)} hours with no valid date (${which}) — every entry that carries ` +
      `hours must be dated YYYY-MM-DD, so it can be checked against the ` +
      `${MAX_HOURS_PER_DAY}-hour daily limit.`,
    );
  }

  // ---- the bound that actually protects a day, applied ONCE PER DATE -------
  for (const [date, agg] of byDate) {
    // A date appearing twice is a grid that disagrees with itself, and it is
    // reported even when the two entries add up to something legal: lib/engine.js
    // buildCalendar() keys days BY DATE and keeps only the last one, so the grid
    // an employee or auditor reads back would show fewer hours than the total
    // that was paid. One row per day, or it is not a timesheet.
    if (agg.entries > 1) {
      problems.push(
        `${date} appears ${agg.entries} times — each calendar date may only be entered once.`,
      );
    }
    if (round2(agg.hours) > MAX_HOURS_PER_DAY) {
      problems.push(
        agg.entries > 1
          ? `${date}: ${round2(agg.hours)} hours across ${agg.entries} entries — one calendar ` +
            `day cannot exceed ${MAX_HOURS_PER_DAY}.`
          : `${date}: ${round2(agg.hours)} hours in one day — the limit is ${MAX_HOURS_PER_DAY}.`,
      );
    }
  }
  if (round2(total) > MAX_HOURS_PER_MONTH) {
    problems.push(
      `${round2(total)} hours in one month — the limit is ${MAX_HOURS_PER_MONTH}.`,
    );
  }
  return problems;
}

// Sum a day grid. TOLERANT: never throws, coerces junk to 0. Use this for
// DISPLAY and for reading rows that are already stored — a row written before
// the bounds existed must still be openable and correctable, not un-renderable.
// Never use it to decide what to pay: use deriveTotalsStrict for that.
export function deriveTotals(days) {
  let regular = 0, overtime = 0, other = 0;
  // DAYS WORKED IS A COUNT OF CALENDAR DAYS, not of array entries. Counting
  // entries printed "40 days worked" for forty rows all dated 2026-06-01 in a
  // 30-day month. hoursProblems() now refuses that grid outright, but this
  // function is the TOLERANT reader used to display rows ALREADY STORED — and
  // rows written before the fix are still in the database, so it must not repeat
  // the same miscount back to whoever opens them. An entry with no usable date
  // still counts once on its own: it is a worked day of unknown date, not zero.
  const worked = new Set();
  let undatedWorked = 0;
  for (const d of Array.isArray(days) ? days : []) {
    const reg = Number(d?.regular) || 0;
    const ot = Number(d?.overtime) || 0;
    const oth = Number(d?.other) || 0;
    regular += reg; overtime += ot; other += oth;
    if (reg + ot + oth > 0) {
      const date = dayKey(d?.date);
      if (date) worked.add(date);
      else undatedWorked += 1;
    }
  }
  return {
    regular: round2(regular), overtime: round2(overtime), other: round2(other),
    total: round2(regular + overtime + other),
    daysWorked: worked.size + undatedWorked,
  };
}

export class HoursRangeError extends Error {
  constructor(problems) {
    super(problems.join(" "));
    this.name = "HoursRangeError";
    this.problems = problems;
  }
}

// Sum a day grid that is ABOUT TO BE STORED as a payable figure. Refuses rather
// than rounds off: there is no safe way to guess what an employee meant by -500
// hours, and quietly clamping it to 0 would be its own wrong wage.
export function deriveTotalsStrict(days) {
  const problems = hoursProblems(days);
  if (problems.length) throw new HoursRangeError(problems.slice(0, 5));
  return deriveTotals(days);
}

// The same bound for a correction that has no day grid to sum — /api/admin/review's
// `summaryTotals` path, which exists for documents that only stated monthly figures.
export function checkSummaryTotals({ regular, overtime }) {
  const problems = [];
  for (const [name, v] of [["regular", regular], ["overtime", overtime]]) {
    const n = Number(v);
    if (!Number.isFinite(n)) problems.push(`corrected ${name} hours must be a number.`);
    else if (n < 0) problems.push(`corrected ${name} hours cannot be negative.`);
    else if (n > MAX_HOURS_PER_MONTH) {
      problems.push(`corrected ${name} hours (${n}) exceed the ${MAX_HOURS_PER_MONTH}-hour monthly limit.`);
    }
  }
  const total = (Number(regular) || 0) + (Number(overtime) || 0);
  if (!problems.length && round2(total) > MAX_HOURS_PER_MONTH) {
    problems.push(`corrected total (${round2(total)}) exceeds the ${MAX_HOURS_PER_MONTH}-hour monthly limit.`);
  }
  return problems;
}

// Is a figure already stored on a row safe to put in a payroll CSV? Rows written
// before these bounds existed are still in the database, so the export checks
// too — the write-path fix cannot reach backwards.
export function payableProblems(n, what) {
  const v = Number(n);
  if (n === null || n === undefined || n === "") return [];
  if (!Number.isFinite(v)) return [`${what} is not a number (${n})`];
  if (v < 0) return [`${what} is negative (${v})`];
  if (v > MAX_HOURS_PER_MONTH) return [`${what} is ${v}, over the ${MAX_HOURS_PER_MONTH}-hour monthly limit`];
  return [];
}
