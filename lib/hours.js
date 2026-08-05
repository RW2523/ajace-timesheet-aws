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
export const MAX_HOURS_PER_DAY = 24;
// 31 * 24. A backstop for the shapes the per-day bound cannot see — e.g. forty
// entries all bearing the same date, or a summary correction with no days at all.
export const MAX_HOURS_PER_MONTH = 744;

const FIELDS = ["regular", "overtime", "other"];

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
    if (dayTotal > MAX_HOURS_PER_DAY) {
      problems.push(
        `${label(d, i)}: ${round2(dayTotal)} hours in one day — the limit is ${MAX_HOURS_PER_DAY}.`,
      );
    }
    total += dayTotal;
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
  let regular = 0, overtime = 0, other = 0, daysWorked = 0;
  for (const d of Array.isArray(days) ? days : []) {
    const reg = Number(d?.regular) || 0;
    const ot = Number(d?.overtime) || 0;
    const oth = Number(d?.other) || 0;
    regular += reg; overtime += ot; other += oth;
    if (reg + ot + oth > 0) daysWorked += 1;
  }
  return {
    regular: round2(regular), overtime: round2(overtime), other: round2(other),
    total: round2(regular + overtime + other), daysWorked,
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
