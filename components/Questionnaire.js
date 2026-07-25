"use client";

export default function Questionnaire({
  q, setQ, holidays, holidayWork, setHolidayWork, calendar, totals,
}) {
  const set = (k) => (e) =>
    setQ({ ...q, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const holidayList = Object.entries(holidays || {}).sort();

  function hoursOn(date) {
    const c = calendar.find((x) => x.date === date);
    return c?.total || 0;
  }

  return (
    <div className="stack">
      <div className="card card-pad">
        <h3 className="card-title">Your month at a glance</h3>
        <div className="grid-2">
          <div className="field">
            <label>How many regular hours did you work?</label>
            <input type="number" step="0.25" min="0" value={q.regularHours ?? ""}
              onChange={set("regularHours")} placeholder={String(totals.regular)} />
            <span className="hint">Calendar total: {totals.regular}h</span>
          </div>
          <div className="field">
            <label>How many overtime hours did you work?</label>
            <input type="number" step="0.25" min="0" value={q.overtimeHours ?? ""}
              onChange={set("overtimeHours")} placeholder={String(totals.overtime)} />
            <span className="hint">Calendar total: {totals.overtime}h</span>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Did you work on weekends?</label>
            <select value={q.workedWeekends || ""} onChange={set("workedWeekends")}>
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
      </div>

      {holidayList.length > 0 && (
        <div className="card card-pad">
          <h3 className="card-title">US holidays this month — did you work?</h3>
          <p className="muted" style={{ marginTop: -6, marginBottom: 12, fontSize: 13 }}>
            These US federal holidays fall in this period. Confirm whether you worked each one.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {holidayList.map(([date, name]) => {
              const d = new Date(date + "T00:00:00");
              const worked = !!holidayWork[date];
              return (
                <div key={date} className="between"
                  style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--purple-soft)" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                      {worked && ` · ${hoursOn(date)}h in calendar`}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className={"btn btn-sm " + (worked ? "btn-ghost" : "btn-primary")}
                      onClick={() => setHolidayWork({ ...holidayWork, [date]: false })}>
                      Off
                    </button>
                    <button className={"btn btn-sm " + (worked ? "btn-primary" : "btn-ghost")}
                      onClick={() => setHolidayWork({ ...holidayWork, [date]: true })}>
                      Worked
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
