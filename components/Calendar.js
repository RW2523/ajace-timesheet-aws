"use client";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Calendar({ calendar, month, year, onDayClick }) {
  if (!calendar || calendar.length === 0) return null;
  // weekday (0=Sun) of the 1st -> leading blanks
  const lead = new Date(year, month - 1, 1).getDay();

  return (
    <div className="cal">
      <div className="cal-grid" style={{ marginBottom: 6 }} aria-hidden="true">
        {WD.map((w) => (
          <div key={w} className="cal-head">{w}</div>
        ))}
      </div>
      <div className="cal-grid">
        {Array.from({ length: lead }).map((_, i) => (
          <div key={"b" + i} className="cell empty" aria-hidden="true" />
        ))}
        {calendar.map((c, idx) => {
          const cls = ["cell"];
          if (c.isWeekend) cls.push("weekend");
          if (c.isHoliday) cls.push("holiday");
          if (!c.isWeekend && !c.isHoliday && !c.filled) cls.push("missing");
          if (c.flagged) cls.push("flagged");

          // Spoken summary, so a day is comprehensible without seeing the
          // colour coding — and so the hours are announced, not just the date.
          const hours = c.regular == null && c.overtime == null
            ? "no hours entered"
            : `${c.regular || 0} regular${c.overtime ? `, ${c.overtime} overtime` : ""}`;
          const label = `${c.weekday} ${c.day}${c.isHoliday ? ` (${c.holidayName})` : ""} — ${hours}. Edit this day.`;

          return (
            // A real <button>: this was a plain <div onClick>, so there was no
            // way to reach or activate a day from the keyboard at all.
            <button
              key={c.date}
              type="button"
              className={cls.join(" ")}
              onClick={() => onDayClick(idx)}
              aria-label={label}
              title="Edit this day"
            >
              {c.flagged && <span className="dot-flag" aria-hidden="true" />}
              <div className="between" style={{ alignItems: "baseline" }}>
                <span className="dom">{c.day}</span>
                <span className="wd">{c.weekday}</span>
              </div>
              {c.isHoliday && <span className="hol-tag">{c.holidayName}</span>}
              <div className="hrs">
                {c.regular != null && <span className="reg">{c.regular}h</span>}
                {c.overtime ? <span className="ot">+{c.overtime} OT</span> : null}
                {c.regular == null && c.overtime == null && (
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>—</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
