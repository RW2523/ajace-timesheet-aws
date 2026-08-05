"use client";
import { useState } from "react";
import useDialogKeys from "@/components/useDialogKeys";

// "" / null / a non-numeric value all mean "no hours", never NaN — a NaN would
// propagate into `days` and land in the append-only edit row.
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function DayModal({ day, onSave, onClose }) {
  const [reg, setReg] = useState(day.regular ?? "");
  const [ot, setOt] = useState(day.overtime ?? "");
  // Paid-but-not-worked time (sick / vacation / holiday pay). It is summed into
  // the monthly total by lib/engine.js rollup() AND by lib/aws/data.js
  // deriveTotals(), i.e. it is PAID — but nothing in the UI ever showed it and
  // nothing here could clear it, so "Clear day" left payable hours behind on a
  // day that then rendered as empty. It is not free-text editable (the split
  // between sick/vacation/holiday only exists in the extraction), but it is now
  // visible and removable.
  const [otherHrs, setOtherHrs] = useState(day.other ?? null);
  const [note, setNote] = useState(day.note ?? "");
  // Escape to close, Tab kept inside the dialog, and focus returned to the day
  // that opened it. Shared with the app's other four dialogs, which had none of
  // it — see components/useDialogKeys.js.
  const dialogRef = useDialogKeys(onClose);

  function save() {
    const r = num(reg);
    const o = num(ot);
    const oth = num(otherHrs);
    // `other` MUST be part of both `total` and `filled`. It used to survive the
    // `...day` spread while being left out of both, so after any manual edit the
    // day reported fewer hours than the server would derive from it, and the
    // cell rendered "—" for a day that still paid.
    const any = r != null || o != null || (oth != null && oth !== 0);
    const total = any ? (r || 0) + (o || 0) + (oth || 0) : null;
    onSave({
      ...day,
      regular: r,
      overtime: o,
      other: oth,
      total,
      note: note || null,
      filled: any,
      // keep the holiday flag honest with the hours that are actually on the day
      workedOnHoliday: day.isHoliday ? (total || 0) > 0 : false,
      flagged: false, // manual edit clears the AI flag
    });
  }

  const d = new Date(day.date + "T00:00:00");
  const pretty = d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return (
    // stopPropagation: in the admin console this dialog is a DOM child of
    // another dialog's backdrop, so a click on THIS backdrop closed the day
    // editor and the panel underneath it — discarding a half-filled timesheet,
    // or an in-progress correction, with no confirmation. Backdrop-click is the
    // dismissal gesture the app teaches everywhere else.
    <div className="modal-bg" onClick={(e) => { e.stopPropagation(); onClose(); }}>
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
          {otherHrs ? (
            <div className="field">
              <label>Paid time off on this day</label>
              <div className="between">
                <span>
                  <b>{otherHrs}h</b>{" "}
                  <span className="muted">sick / vacation / holiday pay</span>
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => setOtherHrs(null)}>
                  Remove
                </button>
              </div>
              <span className="hint">
                Counted in your monthly total, but not in billable regular hours.
              </span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="day-note">Note (optional)</label>
            <input id="day-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. PTO, client site, sick" />
          </div>
          <div className="between" style={{ marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm"
              onClick={() => { setReg(""); setOt(""); setOtherHrs(null); setNote(""); }}>
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
