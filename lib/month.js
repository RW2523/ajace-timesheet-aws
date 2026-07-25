// Period auto-selection rule.
//
// Employees submit the PRIOR month's timesheet during a grace window. So:
//   - on days 1..10 of a month  -> default to the PREVIOUS month
//   - on day 11 onward          -> default to the CURRENT month
// (handles January -> previous December year rollover correctly)

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(m) {
  return MONTHS[m - 1] || "";
}

export function defaultPeriod(today = new Date()) {
  let y = today.getFullYear();
  let m = today.getMonth() + 1; // 1-12
  if (today.getDate() <= 10) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return { month: m, year: y };
}

export function periodLabel(month, year) {
  return `${monthName(month)} ${year}`;
}

// Number of days in a month + the weekday (0=Sun) the 1st falls on.
export function monthGrid(year, month) {
  const days = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=Sun
  return { days, firstWeekday };
}

// Build a list of every date in the month with weekday metadata.
export function enumerateMonth(year, month) {
  const { days } = monthGrid(year, month);
  const out = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(year, month - 1, d);
    const wd = date.getDay(); // 0=Sun..6=Sat
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    out.push({
      date: iso,
      day: d,
      weekday: wd,
      weekdayName: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd],
      isWeekend: wd === 0 || wd === 6,
    });
  }
  return out;
}
