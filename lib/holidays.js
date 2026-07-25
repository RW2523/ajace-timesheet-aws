// US federal holidays, computed (no external API). Used to annotate the calendar
// with "this is a holiday — did you work?" prompts.

function nthWeekdayOfMonth(year, month, weekday, n) {
  // month: 1-12, weekday: 0=Sun..6=Sat, n: 1-based occurrence
  const first = new Date(Date.UTC(year, month - 1, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + shift + (n - 1) * 7));
}
function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - shift));
}
function iso(d) {
  return d.toISOString().slice(0, 10);
}

export function usHolidays(year) {
  return [
    { date: iso(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day" },
    { date: iso(nthWeekdayOfMonth(year, 1, 1, 3)), name: "Martin Luther King Jr. Day" },
    { date: iso(nthWeekdayOfMonth(year, 2, 1, 3)), name: "Presidents' Day" },
    { date: iso(lastWeekdayOfMonth(year, 5, 1)), name: "Memorial Day" },
    { date: iso(new Date(Date.UTC(year, 5, 19))), name: "Juneteenth" },
    { date: iso(new Date(Date.UTC(year, 6, 4))), name: "Independence Day" },
    { date: iso(nthWeekdayOfMonth(year, 9, 1, 1)), name: "Labor Day" },
    { date: iso(nthWeekdayOfMonth(year, 10, 1, 2)), name: "Columbus Day" },
    { date: iso(new Date(Date.UTC(year, 10, 11))), name: "Veterans Day" },
    { date: iso(nthWeekdayOfMonth(year, 11, 4, 4)), name: "Thanksgiving Day" },
    { date: iso(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day" },
  ];
}

// Map of 'YYYY-MM-DD' -> holiday name for the given month.
export function holidaysInMonth(year, month) {
  const out = {};
  for (const h of usHolidays(year)) {
    const [hy, hm] = h.date.split("-").map(Number);
    if (hy === year && hm === month) out[h.date] = h.name;
  }
  return out;
}
