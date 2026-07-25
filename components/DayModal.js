"use client";
import { useEffect, useRef, useState } from "react";

export default function DayModal({ day, onSave, onClose }) {
  const [reg, setReg] = useState(day.regular ?? "");
  const [ot, setOt] = useState(day.overtime ?? "");
  const [note, setNote] = useState(day.note ?? "");
  const dialogRef = useRef(null);
  const restoreFocusTo = useRef(null);

  // Escape to close, Tab kept inside the dialog, and focus returned to the day
  // that opened it. None of this existed: the modal could only be dismissed by
  // clicking, and Tab wandered into the page behind it.
  useEffect(() => {
    restoreFocusTo.current = document.activeElement;
    function onKeyDown(e) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const f = dialogRef.current?.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!f || !f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // hand focus back to where the user was, not to the top of the document
      if (restoreFocusTo.current?.focus) restoreFocusTo.current.focus();
    };
  }, [onClose]);

  function save() {
    const r = reg === "" ? null : Number(reg);
    const o = ot === "" ? null : Number(ot);
    const total = r == null && o == null ? null : (r || 0) + (o || 0);
    onSave({
      ...day,
      regular: r,
      overtime: o,
      total,
      note: note || null,
      filled: r != null || o != null,
      flagged: false, // manual edit clears the AI flag
    });
  }

  const d = new Date(day.date + "T00:00:00");
  const pretty = d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true"
           aria-label={`Edit hours for ${pretty}`}
           onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 16 }}>{pretty}</h3>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              {day.isWeekend && <span className="badge gray">Weekend</span>}
              {day.isHoliday && <span className="badge purple">{day.holidayName}</span>}
            </div>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="day-regular">Regular hours</label>
              <input id="day-regular" type="number" step="0.25" min="0" max="24" value={reg}
                onChange={(e) => setReg(e.target.value)} placeholder="0" autoFocus />
            </div>
            <div className="field">
              <label htmlFor="day-overtime">Overtime hours</label>
              <input id="day-overtime" type="number" step="0.25" min="0" max="24" value={ot}
                onChange={(e) => setOt(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="day-note">Note (optional)</label>
            <input id="day-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. PTO, client site, sick" />
          </div>
          <div className="between" style={{ marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { setReg(""); setOt(""); setNote(""); }}>
              Clear day
            </button>
            <div className="row">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save day</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
