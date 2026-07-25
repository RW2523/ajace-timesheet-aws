// Cross-check the populated calendar against the employee's answers + holidays.
// Returns errors (must fix before submit), warnings, and infos.

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function sum(cal, key) {
  return cal.reduce((a, c) => a + (Number(c[key]) || 0), 0);
}

export function validateTimesheet({ fields, calendar, questionnaire, holidayWork, holidays }) {
  const errors = [];
  const warnings = [];
  const infos = [];

  // ---- identity ----
  if (!fields.employee_name || !fields.employee_name.trim())
    errors.push("Employee name is required.");
  if (!fields.client || !fields.client.trim())
    warnings.push("Client / placement is empty.");

  // ---- calendar vs. stated hours ----
  const calReg = round2(sum(calendar, "regular"));
  const calOt = round2(sum(calendar, "overtime"));
  const calTotal = round2(calReg + calOt);

  const qReg = num(questionnaire.regularHours);
  const qOt = num(questionnaire.overtimeHours);
  if (qReg != null && Math.abs(qReg - calReg) > 0.5)
    errors.push(`Stated regular hours (${qReg}) don't match the calendar total (${calReg}).`);
  if (qOt != null && Math.abs(qOt - calOt) > 0.5)
    errors.push(`Stated overtime hours (${qOt}) don't match the calendar total (${calOt}).`);

  // ---- weekends ----
  const weekendHrs = round2(
    calendar.filter((c) => c.isWeekend).reduce((a, c) => a + (Number(c.total) || 0), 0)
  );
  if (questionnaire.workedWeekends === "yes" && weekendHrs <= 0)
    errors.push("You indicated weekend work, but no weekend hours are in the calendar.");
  if (questionnaire.workedWeekends === "no" && weekendHrs > 0)
    warnings.push(`Calendar has ${weekendHrs}h on weekends, but you indicated no weekend work.`);

  // ---- holidays ----
  for (const [date, name] of Object.entries(holidays || {})) {
    const cell = calendar.find((c) => c.date === date);
    const hrs = Number(cell?.total) || 0;
    const worked = !!holidayWork[date];
    if (worked && hrs <= 0)
      errors.push(`${name} is marked "worked", but the calendar shows 0 hours that day.`);
    if (!worked && hrs > 0)
      warnings.push(`${name} has ${hrs}h in the calendar, but it isn't marked as worked.`);
  }

  // ---- holidays taken count sanity ----
  const taken = num(questionnaire.holidaysTaken);
  if (taken != null && taken < 0) errors.push("Holidays taken cannot be negative.");

  // ---- missing weekday data ----
  const missing = calendar.filter((c) => !c.isWeekend && !c.isHoliday && !c.filled).length;
  if (missing > 0) infos.push(`${missing} weekday(s) have no hours entered yet.`);

  return {
    errors,
    warnings,
    infos,
    ok: errors.length === 0,
    calReg,
    calOt,
    calTotal,
    weekendHrs,
  };
}
