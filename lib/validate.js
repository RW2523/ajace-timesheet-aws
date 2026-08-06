// Cross-check the populated calendar against the employee's answers + holidays.
// Returns errors (must fix before submit), warnings, and infos.
//
// The point of the questionnaire is to be an INDEPENDENT check on the AI's
// reading. It is therefore never pre-filled from the extraction, and the hour
// answers are REQUIRED — otherwise the comparison silently skips and a misread
// document self-certifies as correct.
import { rollup } from "./engine.js";
import { approvalErrors } from "./approval.js";
import { hoursProblems } from "./hours.js";

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

// ---------------------------------------------------------------------------
// `onBehalf` — THE ONE DELIBERATE RELAXATION, AND ITS EXACT EDGE.
//
// The stated-hours and weekend questions are written in the employee's voice
// and exist to be an INDEPENDENT check on the AI: the employee says what they
// worked, and this function compares that against what the document was read to
// say. An admin filing FOR someone has no independent knowledge to contribute —
// they are reading the same document a second time — so asking them to retype
// its totals does not check anything, and recording the answer in
// ts_employee_edits.questionnaire manufactures an attestation by a person who
// did not work the month. So when `onBehalf` is true these are dropped:
//
//     * "Enter the total regular hours you worked this month."
//     * the stated-vs-calendar regular mismatch
//     * "Enter your total overtime hours (enter 0 if none)."
//     * the stated-vs-calendar overtime mismatch
//     * "Answer whether you worked any weekends."   (+ its yes/no-hours check)
//
// NOTHING ELSE MOVES, and in particular none of these:
//     * employee_name required
//     * no hours at all on the month
//     * hoursProblems() — the same bounds the server refuses to store
//     * per-day > 24h and negative hours
//     * the holiday Worked / Not-worked cross-checks
//     * approvalErrors() — the MANAGER-APPROVAL question stays a blocker,
//       because lib/approval.js compares the detected approver against the
//       DOCUMENT's employee_name and never against the session, so it is
//       answerable from the document in the admin's hand.
//
// This weakens no server-enforced control. /api/admin/timesheet requires none
// of the dropped answers, derives its totals with deriveTotalsStrict (the same
// bounds as hoursProblems), writes its own validation blob, and carries a
// MANDATORY note, the `fields.entry` provenance stamp and a ts_admin_edits row
// — which are the on-behalf integrity story.
// ---------------------------------------------------------------------------
export function validateTimesheet({ fields, calendar, questionnaire, holidayWork, holidays,
                                    onBehalf = false }) {
  const errors = [];
  const warnings = [];
  const infos = [];

  // ---- identity ----
  if (!fields.employee_name || !fields.employee_name.trim())
    errors.push("Employee name is required.");
  if (!fields.client || !fields.client.trim())
    warnings.push("Client / placement is empty.");

  // ---- calendar vs. stated hours ----
  // ONE formula for hours, shared with what actually gets stored (lib/engine.js).
  const r = rollup(calendar);
  const calReg = r.regular;
  const calOt = r.overtime;
  const calOther = r.other;
  const calTotal = r.total;

  if (calTotal <= 0)
    errors.push("No hours are entered for this month.");

  // The server REFUSES to store hours that cannot be real (lib/hours.js), so say
  // so here rather than letting the employee find out from a failed save. Same
  // function, same limits — the screen and the database cannot disagree.
  for (const p of hoursProblems(calendar)) errors.push(p);

  const weekendHrs = round2(
    calendar.filter((c) => c.isWeekend).reduce((a, c) => a + (Number(c.total) || 0), 0)
  );

  // ---- THE SELF-ATTESTATION BLOCK — see the `onBehalf` note above ----------
  // Everything in here is the worker's own statement about their own month.
  // Nobody else can make it, so nobody else is asked for it.
  if (!onBehalf) {
    const qReg = num(questionnaire.regularHours);
    const qOt = num(questionnaire.overtimeHours);
    if (qReg == null)
      errors.push("Enter the total regular hours you worked this month.");
    else if (Math.abs(qReg - calReg) > 0.5)
      errors.push(`Your stated regular hours (${qReg}) don't match the calendar (${calReg}).`);
    if (qOt == null)
      errors.push("Enter your total overtime hours (enter 0 if none).");
    else if (Math.abs(qOt - calOt) > 0.5)
      errors.push(`Your stated overtime hours (${qOt}) don't match the calendar (${calOt}).`);

    // ---- weekends ----
    if (!questionnaire.workedWeekends)
      errors.push("Answer whether you worked any weekends.");
    if (questionnaire.workedWeekends === "yes" && weekendHrs <= 0)
      errors.push("You indicated weekend work, but no weekend hours are in the calendar.");
  }
  // A WARNING, so it survives on both paths: it describes the calendar against
  // an answer that was actually given, and if one was given it is worth saying.
  if (questionnaire.workedWeekends === "no" && weekendHrs > 0)
    warnings.push(`Calendar has ${weekendHrs}h on weekends, but you indicated no weekend work.`);

  // ---- manager approval ----
  // Either the document carried an approval we could quote, or the employee has
  // ticked the box saying it did not. Silence is not an answer. The question is
  // always answerable: Questionnaire renders the approval card unconditionally,
  // on the AI path and the manual path alike.
  for (const e of approvalErrors(questionnaire)) errors.push(e);

  // ---- holidays ----
  // "Worked" is a statement about WORKED hours (regular + overtime) only.
  // `other` is paid-but-not-worked time — holiday pay, PTO, sick — and a
  // not-worked federal holiday routinely carries 8h of it. Measuring these two
  // checks against c.total (which includes `other`) made holiday pay look like
  // work: the warning below fired on every paid holiday and the employee had no
  // way to clear it except by deleting hours they are owed. Neither check
  // touches what gets paid; both only describe the same `days` array the server
  // derives the money from.
  for (const [date, name] of Object.entries(holidays || {})) {
    const cell = calendar.find((c) => c.date === date);
    const hrs = round2((Number(cell?.regular) || 0) + (Number(cell?.overtime) || 0));
    const worked = !!holidayWork[date];
    if (worked && hrs <= 0)
      errors.push(`${name} is marked "worked", but the calendar shows 0 hours worked that day.`);
    if (!worked && hrs > 0)
      warnings.push(`${name} has ${hrs}h worked in the calendar, but it isn't marked as worked.`);
  }

  // ---- holidays taken count sanity ----
  const taken = num(questionnaire.holidaysTaken);
  if (taken != null && taken < 0) errors.push("Holidays taken cannot be negative.");

  // ---- per-day sanity ----
  for (const c of calendar) {
    const t = (Number(c.regular) || 0) + (Number(c.overtime) || 0) + (Number(c.other) || 0);
    if (t > 24) errors.push(`${c.date} has ${t}h — more than a day.`);
    else if (t > 16) warnings.push(`${c.date} has ${t}h — please confirm that's right.`);
    if ((Number(c.regular) || 0) < 0 || (Number(c.overtime) || 0) < 0)
      errors.push(`${c.date} has negative hours.`);
  }

  // ---- missing weekday data ----
  // A warning, not an info: `infos` is rendered nowhere, so unfilled weekdays
  // used to produce no visible signal at all.
  const missing = calendar.filter((c) => !c.isWeekend && !c.isHoliday && !c.filled).length;
  if (missing > 0)
    warnings.push(`${missing} weekday(s) have no hours entered — confirm that's correct.`);

  return {
    errors,
    warnings,
    infos,
    ok: errors.length === 0,
    calReg,
    calOt,
    calOther,
    calTotal,
    weekendHrs,
  };
}
