// Bulk weekday fill for manual entry.
//
// WHY THIS EXISTS: manual entry is the path EVERY user lands on when the AI
// fails, when NEXT_PUBLIC_AI_ENABLED is off, or when they simply have no
// document. It started from an empty grid (lib/engine.js buildCalendar(null,…))
// with no way to say "I worked a normal month": each of ~22 weekdays had to be
// opened, typed into and saved one at a time through DayModal — roughly 60
// interactions — and until that was finished every one of those days rendered
// amber (.cell.missing in Calendar.js) with a matching "N weekday(s) have no
// hours entered" warning from validate.js. The blank form presented as 22
// problems before the employee had done anything wrong.
//
// THIS IS PAYROLL. Everything below is a pure function over the `days` array
// that DashboardClient posts and that lib/aws/data.js re-derives
// monthly_regular / monthly_overtime / monthly_total / days_worked from. It
// never computes or returns a monthly figure, and it never mutates its input.
//
// The ONLY thing it changes about the derived payroll numbers: days that
// previously carried NOTHING now carry `regular` = the chosen figure. So
// monthly_regular and monthly_total each rise by (hours x days filled) and
// days_worked rises by (days filled). monthly_overtime is never touched —
// `overtime` is not written here.

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The most hours a single day may be given. Matches the per-day ceiling
// validate.js enforces (>24h on a day is a blocking error).
export const MAX_DAY_HOURS = 24;

// A weekday with nothing at all on it — exactly the days Calendar.js tints
// amber (.cell.missing) and validate.js counts in its missing-weekday warning,
// so "fill the amber ones" is literally true.
//
// Weekends and holidays are excluded ON PURPOSE, not as an oversight:
//   * weekend hours are cross-checked against the "did you work weekends?"
//     answer, and
//   * holidays are owned by the Worked / Not-worked toggles in Questionnaire.js
//     plus the holidayWork map,
// so writing hours onto either from here would contradict a question the
// employee still has to answer, and would immediately raise a validation
// warning about the very day it just filled.
//
// `!c.filled` (rather than "no hours") is deliberate: it means an explicit 0 —
// an employee stating "I did not work that day" — is never overwritten.
export function isEmptyWeekday(c) {
  return !!c && !c.isWeekend && !c.isHoliday && !c.filled;
}

export function emptyWeekdays(cal) {
  return (Array.isArray(cal) ? cal : []).filter(isEmptyWeekday);
}

// Put `hours` of REGULAR time on every empty weekday.
//
// Returns { days, filled, error }:
//   days   a NEW array (the input is never mutated), or the input unchanged
//          when nothing was filled
//   filled how many days were written
//   error  a message to show the employee, or null
//
// Existing `overtime` / `other` on a day are read and preserved rather than
// assumed to be zero, so the day's `total` stays consistent with the way
// lib/engine.js rollup() and lib/aws/data.js deriveTotals() add a day up
// (regular + overtime + other) even if `filled` ever drifts from its contents.
export function fillEmptyWeekdays(cal, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > MAX_DAY_HOURS) {
    return {
      days: cal,
      filled: 0,
      error: `Enter hours per day between 0 and ${MAX_DAY_HOURS}.`,
    };
  }
  const targets = new Set(emptyWeekdays(cal).map((c) => c.date));
  if (targets.size === 0) {
    return { days: cal, filled: 0, error: "Every weekday already has hours — nothing to fill." };
  }
  const hrs = round2(h);
  const days = cal.map((c) => {
    if (!targets.has(c.date)) return c;
    const ot = Number(c.overtime) || 0;
    const oth = Number(c.other) || 0;
    return {
      ...c,
      regular: hrs,
      total: round2(hrs + ot + oth),
      filled: true,
      workedOnHoliday: false, // never a holiday: excluded by isEmptyWeekday
      flagged: false,         // a human has now stated these hours
    };
  });
  return { days, filled: targets.size, error: null };
}
