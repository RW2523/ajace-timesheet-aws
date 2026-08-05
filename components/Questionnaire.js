"use client";
import { useEffect, useRef } from "react";
import { APPROVAL_MIN_CONFIDENCE } from "@/lib/approval";

// PROPS CONTRACT — this list must match the <Questionnaire> call in
// components/DashboardClient.js EXACTLY. Nothing here is decorative:
//   q, setQ            questionnaire answers (persisted verbatim to
//                      ts_employee_edits.questionnaire and ts_timesheets.questionnaire)
//   holidays           { "YYYY-MM-DD": "Holiday name" }
//   holidayWork        { "YYYY-MM-DD": boolean }  — true = the employee WORKED it
//   setHolidayWork     replaces the whole map
//   calendar, totals   the live day array + its rollup (READ-ONLY here)
//   approval           employee.approval / data.approval from /api/process.
//                      null on manual entry or a flow with no approval block.
//   showErrors         true once submit has been pressed once — gates the red
//                      "you must answer this" nag so a fresh form isn't a wall
//                      of red.
//   onClearDayHours    (date) => void            "Not worked"
//   onRestoreAiHours   (date) => number | null   "Worked", undo a mis-click
//   onSetDayHours      (date, {regular, overtime}) => void
//   onEditDay          (date) => void            opens DayModal
//   hoursOnDate        (date) => number  PAID hours    (regular+overtime+other)
//   workedHoursOnDate  (date) => number  WORKED hours  (regular+overtime)
//   aiHoursOnDate      (date) => number | null  WORKED hours the AI read
//
// THIS COMPONENT NEVER COMPUTES OR POSTS A TOTAL. Every hour change goes back
// through the callbacks above, which write only into `calendar` — the `days`
// array lib/aws/data.js re-derives monthly_* from.
//
// WHY THE LIST IS SPELLED OUT: React silently drops props a component doesn't
// destructure and silently applies defaults for ones the caller forgets, so a
// caller wired to a DIFFERENT contract compiles, builds and renders — with
// "Not worked" leaving the hours in `days` (the day reads "not worked" and is
// still paid) and every employee pushed to the "no approval" checkbox on a
// signed document. That is exactly what shipped once. If you change this list,
// change DashboardClient.js in the same commit.
export default function Questionnaire({
  q, setQ, holidays, holidayWork, setHolidayWork, calendar, totals,
  approval = null,
  showErrors = false,
  onClearDayHours = null,
  onRestoreAiHours = null,
  onSetDayHours = null,
  onEditDay = null,
  hoursOnDate = null,
  workedHoursOnDate = null,
  aiHoursOnDate = null,
}) {
  const set = (k) => (e) =>
    setQ({ ...q, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const holidayList = Object.entries(holidays || {}).sort();
  const fn = (f) => (typeof f === "function" ? f : null);
  // The holiday toggles can only move hours if BOTH the clear and the set
  // callback are wired; one without the other is a half-working toggle.
  const canEditDays = !!(fn(onClearDayHours) && fn(onSetDayHours));

  // ---- manager approval (ITEM 5) -------------------------------------------
  // Seed the answer from the extraction ONCE per detection object. The block
  // itself is read-only evidence: the employee can disagree with it, but never
  // edits it, so the admin can always see what the document actually said.
  const seeded = useRef(null);
  useEffect(() => {
    // No detection to seed. Clear the memo as well: "Start over" resets both
    // `q` and `approval`, and a stale key would then suppress re-seeding if the
    // next document produced an IDENTICAL detection — leaving an approved
    // timesheet showing "we couldn't find a manager approval".
    if (!approval) { seeded.current = null; return; }
    const key = JSON.stringify(approval);
    if (seeded.current === key) return;
    seeded.current = key;
    setQ((prev) => ({
      ...prev,
      approvalDetection: approval,
      // A detection that cleared the bar answers the question. Anything else —
      // not found, or found but under-confident — leaves it UNANSWERED, so the
      // employee has to acknowledge it explicitly. Never a silent default.
      managerApproval: approval.detected ? "detected" : null,
      managerApprovalAck: false,
      approvalOverride: false,
    }));
  }, [approval, setQ]);

  const det = q.approvalDetection || approval || null;
  const showDetected = q.managerApproval === "detected" && det?.detected === true;
  const ackChecked = q.managerApproval === "acknowledged_absent" && q.managerApprovalAck === true;
  // A positive-but-under-the-bar reading is a HINT, never an answer.
  const hint = det && det.present === true && det.detected !== true ? det : null;

  function rejectDetection() {
    setQ({ ...q, managerApproval: "acknowledged_absent",
      managerApprovalAck: false, approvalOverride: true });
  }
  function restoreDetection() {
    setQ({ ...q, managerApproval: "detected", managerApprovalAck: false,
      approvalOverride: false });
  }
  function toggleAck(e) {
    const on = e.target.checked;
    setQ({ ...q, managerApproval: on ? "acknowledged_absent" : null,
      managerApprovalAck: on });
  }

  // ---- US holidays (ITEM 8) -------------------------------------------------
  function dayFor(date) {
    return (calendar || []).find((x) => x.date === date) || null;
  }
  // WORKED hours (regular + overtime). Prefer the caller's reading so this
  // component and the calendar can never disagree about what "worked" means;
  // the local sum is only a fallback for a caller that didn't wire it.
  function workedHoursOn(date) {
    const f = fn(workedHoursOnDate);
    if (f) return round2(Number(f(date)) || 0);
    const c = dayFor(date);
    return round2((Number(c?.regular) || 0) + (Number(c?.overtime) || 0));
  }
  // ALL paid hours on a day (regular + overtime + other) — what data.js actually
  // folds into monthly_total.
  function paidHoursOn(date) {
    const f = fn(hoursOnDate);
    if (f) return round2(Number(f(date)) || 0);
    const c = dayFor(date);
    return round2((Number(c?.regular) || 0) + (Number(c?.overtime) || 0) + (Number(c?.other) || 0));
  }
  // Paid-but-NOT-worked time: holiday pay, PTO, sick. Derived as the gap between
  // the two callers' own readings rather than re-reading `other` here, so this
  // card can't drift from the calendar and the payroll sum.
  function paidNotWorkedOn(date) {
    return round2(Math.max(0, paidHoursOn(date) - workedHoursOn(date)));
  }
  // Overtime sits on the day but is NOT editable from this card — surfaced so a
  // holiday showing "8h worked" with 6 regular + 2 overtime isn't confusing.
  function overtimeOn(date) {
    return round2(Number(dayFor(date)?.overtime) || 0);
  }

  // "Not worked": the worked hours must LEAVE `days`, not just get a label —
  // otherwise the day reads "not worked" and is still paid, which is item 8's
  // complaint. DashboardClient.clearDayHours nulls regular + overtime and KEEPS
  // `other`: "I didn't work the holiday" is not "don't pay me for it", and
  // silently deleting holiday/PTO pay would cut someone's cheque.
  function markNotWorked(date) {
    const clear = fn(onClearDayHours);
    if (clear) clear(date);
    setHolidayWork({ ...holidayWork, [date]: false });
  }

  // "Worked": the flag alone proves nothing, so the hours box below becomes
  // required and validate.js refuses a worked holiday with 0 WORKED hours.
  //
  // "Not worked" genuinely deletes hours now, so this is also its undo: when the
  // day carries no worked hours, put back what the document said. That restores
  // the extraction's own regular/overtime SPLIT (DashboardClient.restoreAiHours
  // writes both fields) — merging 6h regular + 2h overtime into 8h regular would
  // keep monthly_total right while silently dropping the overtime premium.
  // It never overwrites hours already on the day, and never invents any: with
  // nothing to look up the box simply stays empty for the employee to fill in.
  function markWorked(date) {
    setHolidayWork({ ...holidayWork, [date]: true });
    const restore = fn(onRestoreAiHours);
    if (!restore || workedHoursOn(date) > 0) return;
    restore(date);
  }

  // The hours box. Writes REGULAR only and carries the day's existing overtime
  // through untouched — this control is not where overtime is edited, so it
  // must not zero it. "Edit day" opens DayModal for that.
  function setWorkedHours(date, raw) {
    const setHours = fn(onSetDayHours);
    if (!setHours) return;
    const c = dayFor(date);
    const ot = c?.overtime ?? null;
    if (raw === "") { setHours(date, { regular: null, overtime: ot }); return; }
    const reg = Number(raw);
    if (!Number.isFinite(reg) || reg < 0) return;
    setHours(date, { regular: round2(reg), overtime: ot });
  }

  return (
    <div className="stack">
      <div className="card card-pad">
        <h3 className="card-title">Your month at a glance</h3>
        <div className="grid-2">
          {/* The ids are load-bearing, not decoration: DashboardClient's
              focusFirstProblem() jumps to these exact ids when a submit is
              refused. Renaming one silently downgrades that jump to the
              generic banner. */}
          <div className="field">
            <label htmlFor="ts-regular-hours">How many regular hours did you work?<Req /></label>
            <input id="ts-regular-hours" type="number" step="0.25" min="0" value={q.regularHours ?? ""}
              onChange={set("regularHours")} aria-required="true"
              placeholder={String(totals.regular)} />
            <span className="hint">Calendar total: {totals.regular}h</span>
          </div>
          <div className="field">
            <label htmlFor="ts-overtime-hours">How many overtime hours did you work?<Req /></label>
            <input id="ts-overtime-hours" type="number" step="0.25" min="0" value={q.overtimeHours ?? ""}
              onChange={set("overtimeHours")} aria-required="true"
              placeholder={String(totals.overtime)} />
            <span className="hint">Calendar total: {totals.overtime}h</span>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="ts-worked-weekends">Did you work on weekends?<Req /></label>
            <select id="ts-worked-weekends" value={q.workedWeekends || ""}
              onChange={set("workedWeekends")} aria-required="true">
              <option value="">Select…</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
            <span className="hint">Calendar weekend hours: {totals.weekendHrs ?? 0}h</span>
          </div>
          <div className="field">
            <label>How many holidays did you take off?</label>
            <input type="number" min="0" value={q.holidaysTaken ?? ""}
              onChange={set("holidaysTaken")} placeholder="0" />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Were those holidays paid?</label>
            <select value={q.holidaysPaid || ""} onChange={set("holidaysPaid")}>
              <option value="">Select…</option>
              <option value="paid">Paid</option>
              <option value="unpaid">Unpaid</option>
              <option value="mixed">Some paid, some unpaid</option>
              <option value="na">Not applicable</option>
            </select>
          </div>
          <div className="field">
            <label>Any PTO / sick days this month?</label>
            <input type="number" min="0" value={q.ptoDays ?? ""}
              onChange={set("ptoDays")} placeholder="0" />
          </div>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label>Additional notes for your manager (optional)</label>
          <textarea rows={2} value={q.notes ?? ""} onChange={set("notes")}
            placeholder="Anything reviewers should know…" />
        </div>
        {/* NO second "* required" legend here. DashboardClient prints one, once,
            at the top of the review form (.req-note). Two legends in two
            different colours is how the marker stopped meaning anything. */}
      </div>

      {/* ---------------- manager approval ---------------- */}
      <div className="card card-pad">
        <h3 className="card-title">Manager approval<Req /></h3>

        {showDetected ? (
          <div style={{
            padding: "12px 14px", borderRadius: 8,
            border: "1px solid var(--green, #16a34a)",
            background: "var(--green-soft, #f0fdf4)",
          }}>
            <div style={{ fontWeight: 600 }}>
              ✓ Manager approval found in your document
              {det.approver_name ? ` — approved by ${det.approver_name}` : ""}
              {det.approved_on ? ` on ${det.approved_on}` : ""}
            </div>
            {det.verbatim && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Read from the document: “{det.verbatim}”
              </div>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {det.confidence != null && <>AI confidence {Math.round(det.confidence * 100)}% · </>}
              answered <b>Yes</b> for you — nothing to do here.
            </div>
            <div style={{ marginTop: 8 }}>
              <a role="button" tabIndex={0} style={{ fontSize: 12, cursor: "pointer" }}
                 onClick={rejectDetection}
                 onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && rejectDetection()}>
                That’s not right — this timesheet isn’t approved
              </a>
            </div>
          </div>
        ) : (
          <div style={{
            padding: "12px 14px", borderRadius: 8,
            border: "1px solid var(--amber, #f59e0b)",
            background: "var(--amber-soft, #fffbeb)",
          }}>
            <div style={{ fontWeight: 600 }}>
              {q.approvalOverride
                ? "You said this timesheet is not approved"
                : det
                  ? "We couldn’t find a manager approval or signature on this document"
                  : "No document was read, so no manager approval could be found"}
            </div>

            {hint && !q.approvalOverride && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {hint.reject_reason === "self_approval"
                  ? "The only signature we found looks like your own — an employee can’t approve their own timesheet."
                  : <>We may have seen{" "}
                      {hint.verbatim ? <>“{hint.verbatim}”</>
                        : hint.approver_name ? <>an approval by {hint.approver_name}</>
                        : "something that could be an approval"}
                      {hint.confidence != null &&
                        <> ({Math.round(hint.confidence * 100)}% sure — we only count it at{" "}
                        {Math.round(APPROVAL_MIN_CONFIDENCE * 100)}% or better)</>}
                      , so please confirm below.</>}
              </div>
            )}

            <label className="row" style={{ gap: 8, alignItems: "flex-start", marginTop: 10, cursor: "pointer" }}>
              {/* focusFirstProblem() jumps here: this checkbox is the single
                  most common thing blocking a submit. data-scroll-target keeps
                  the sticky topbar off it (globals.css). */}
              <input id="ts-manager-approval" data-scroll-target=""
                type="checkbox" checked={ackChecked} onChange={toggleAck}
                style={{ marginTop: 3 }} />
              <span style={{ fontSize: 13 }}>
                I confirm this timesheet has <b>not</b> been approved by my manager,
                and I’m submitting it anyway.
              </span>
            </label>

            {/* Held back until the first submit attempt: the card opens in this
                branch on every manual entry, so showing the red line straight
                away paints an untouched form as an error. validate.js blocks
                the submit either way. */}
            {!ackChecked && showErrors && (
              <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
                Tick the box to continue — you can’t submit until this is answered.
              </div>
            )}

            {q.approvalOverride && (
              <div style={{ marginTop: 8 }}>
                <a role="button" tabIndex={0} style={{ fontSize: 12, cursor: "pointer" }}
                   onClick={restoreDetection}
                   onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && restoreDetection()}>
                  Undo — the approval we found
                  {det?.approver_name ? ` (${det.approver_name})` : ""} is valid after all
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------- US holidays ---------------- */}
      {holidayList.length > 0 && (
        <div className="card card-pad">
          <h3 className="card-title">US holidays this month — did you work?</h3>
          <p className="muted" style={{ marginTop: -6, marginBottom: 12, fontSize: 13 }}>
            {/* Say exactly what the buttons do, including the part people lose
                money on. AJACE does not pay a federal holiday that was not
                worked (operator decision, 2026-08-05), so "Not worked" empties
                the day completely — the holiday pay goes with the hours. Saying
                only "removes those hours" would hide the pay change. */}
            These US federal holidays fall in this period. Mark each one{" "}
            <b>Worked</b> (then enter the hours you worked) or <b>Not worked</b>,
            which empties the day — the hours <i>and</i> any holiday or PTO pay
            on it. Pressing <b>Worked</b> again puts back what the document said.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {holidayList.map(([date, name]) => {
              const d = new Date(date + "T00:00:00");
              const worked = !!holidayWork[date];
              const hrs = workedHoursOn(date);
              const paid = paidNotWorkedOn(date);
              const ot = overtimeOn(date);
              const needsHours = worked && hrs <= 0;
              return (
                <div key={date}
                  style={{
                    padding: "10px 12px", borderRadius: 8,
                    border: "1px solid " + (needsHours ? "var(--red)" : "var(--line)"),
                    background: "var(--purple-soft)",
                  }}>
                  <div className="between" style={{ gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                        {worked && ` · ${hrs}h worked in calendar`}
                        {!worked && paid > 0 && ` · ${paid}h holiday/PTO pay — cleared if you mark this Not worked`}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button"
                        className={"btn btn-sm " + (worked ? "btn-ghost" : "btn-primary")}
                        aria-pressed={!worked}
                        onClick={() => markNotWorked(date)}>
                        Not worked
                      </button>
                      <button type="button"
                        className={"btn btn-sm " + (worked ? "btn-primary" : "btn-ghost")}
                        aria-pressed={worked}
                        onClick={() => markWorked(date)}>
                        Worked
                      </button>
                    </div>
                  </div>

                  {worked && (
                    <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <label htmlFor={`hol-${date}`} style={{ fontSize: 13 }}>
                        Hours worked on this holiday<Req />
                      </label>
                      {canEditDays ? (
                        <input id={`hol-${date}`} type="number" step="0.25" min="0" max="24"
                          style={{ width: 110 }}
                          value={dayFor(date)?.regular ?? ""}
                          placeholder="0"
                          onChange={(e) => setWorkedHours(date, e.target.value)} />
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>
                          Open {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} in
                          the calendar above to enter the hours.
                        </span>
                      )}
                      {needsHours && (
                        <span style={{ color: "var(--red)", fontSize: 12 }}>
                          Enter the hours you worked — this day currently has none.
                        </span>
                      )}
                      {ot > 0 && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          plus {ot}h overtime on this day
                        </span>
                      )}
                      {paid > 0 && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          plus {paid}h holiday/PTO pay already on this day
                        </span>
                      )}
                      {/* The box above edits REGULAR hours only. Overtime and
                          holiday/PTO pay are changed in the day editor, so
                          there has to be a way to reach it from here. */}
                      {fn(onEditDay) && (
                        <a role="button" tabIndex={0}
                           style={{ fontSize: 12, cursor: "pointer" }}
                           onClick={() => onEditDay(date)}
                           onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onEditDay(date)}>
                          Edit day →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// The ONE required-field marker. Colour comes from `.req` / `--req` in
// globals.css (indigo, deliberately not --red: "you still have to fill this in"
// must not look like "what you typed is wrong"). Do not restore an inline
// colour here — that is what made the same screen show two different asterisks.
function Req() {
  return <span className="req" title="Required" aria-hidden="true">*</span>;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
