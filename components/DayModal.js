"use client";
import { useState } from "react";

export default function DayModal({ day, onSave, onClose }) {
  const [reg, setReg] = useState(day.regular ?? "");
  const [ot, setOt] = useState(day.overtime ?? "");
  const [note, setNote] = useState(day.note ?? "");

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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 16 }}>{pretty}</h3>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              {day.isWeekend && <span className="badge gray">Weekend</span>}
              {day.isHoliday && <span className="badge purple">{day.holidayName}</span>}
            </div>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="grid-2">
            <div className="field">
              <label>Regular hours</label>
              <input type="number" step="0.25" min="0" value={reg}
                onChange={(e) => setReg(e.target.value)} placeholder="0" autoFocus />
            </div>
            <div className="field">
              <label>Overtime hours</label>
              <input type="number" step="0.25" min="0" value={ot}
                onChange={(e) => setOt(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="field">
            <label>Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
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
