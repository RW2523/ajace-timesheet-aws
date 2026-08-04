"use client";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A standard working day. Exported so the calendar tint, the legend and any
// caller measure "short day" against the same number instead of a literal 8
// buried in a view file.
export const STANDARD_DAY = 8;

// THE per-day hours reading. regular + overtime + other — exactly how
// lib/engine.js rollup() and lib/aws/data.js deriveTotals() sum a day, which is
// what actually gets paid.
//
// Deliberately NOT c.total: `total` is a stored convenience value that can lag
// behind its own components (see DayModal), so anything that must agree with
// payroll has to add the three buckets itself.
export function dayHours(c) {
  return (Number(c?.regular) || 0) + (Number(c?.overtime) || 0) + (Number(c?.other) || 0);
}

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
          const hrs = dayHours(c);

          // A weekday that WAS filled in but came out under a standard day.
          // Purely a colour hint (item 7) — it is not a warning, produces no
          // validation entry, and never blocks a submission.
          //   - weekdays only: a 4h Saturday is normal, and a worked holiday is
          //     irregular by definition and already carries the purple tint.
          //   - hrs > 0 only: an empty weekday is already amber (.missing);
          //     two cues on one cell would read as an error.
          //   - hrs includes `other`, so a full 8h PTO day is NOT tinted — it is
          //     a full paid day.
          const isShort =
            !c.isWeekend && !c.isHoliday && c.filled && hrs > 0 && hrs < STANDARD_DAY;

          const cls = ["cell"];
          if (c.isWeekend) cls.push("weekend");
          if (c.isHoliday) cls.push("holiday");
          if (!c.isWeekend && !c.isHoliday && !c.filled) cls.push("missing");
          if (isShort) cls.push("short");
          if (c.flagged) cls.push("flagged");

          // Spoken summary, so a day is comprehensible without seeing the
          // colour coding — and so the hours are announced, not just the date.
          // The short-day hint is spoken too: the tint must never be the only
          // way to perceive it.
          const parts = [];
          if (c.regular != null) parts.push(`${c.regular} regular`);
          if (c.overtime) parts.push(`${c.overtime} overtime`);
          if (c.other) parts.push(`${c.other} paid time off`);
          const hours = parts.length ? parts.join(", ") : "no hours entered";
          const short = isShort ? `, under ${STANDARD_DAY} hours` : "";
          const label =
            `${c.weekday} ${c.day}${c.isHoliday ? ` (${c.holidayName})` : ""} — ${hours}${short}. Edit this day.`;

          return (
            // A real <button>: this was a plain <div onClick>, so there was no
            // way to reach or activate a day from the keyboard at all.
            <button
              key={c.date}
              type="button"
              className={cls.join(" ")}
              onClick={() => onDayClick(idx)}
              aria-label={label}
              title={isShort ? `Under ${STANDARD_DAY}h — edit this day` : "Edit this day"}
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
                {/* `other` is paid time that the server DOES include in the
                    monthly total. It was never rendered, so a day could show
                    "—" and still be paid. */}
                {c.other ? <span className="oth">+{c.other} PTO</span> : null}
                {c.regular == null && !c.overtime && !c.other && (
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
