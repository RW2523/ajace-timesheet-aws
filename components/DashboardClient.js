"use client";
import { useMemo, useRef, useState } from "react";
import Topbar from "@/components/Topbar";
import Calendar from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import Questionnaire from "@/components/Questionnaire";
import PreviewPane from "@/components/PreviewPane";
import { createClient } from "@/lib/api/client";
import { defaultPeriod, periodLabel, MONTHS } from "@/lib/month";
import { holidaysInMonth } from "@/lib/holidays";
import { buildCalendar, rollup } from "@/lib/engine";
import { validateTimesheet } from "@/lib/validate";

export default function DashboardClient({ profile }) {
  const supabase = createClient();
  const uid = profile.id;
  const fileInput = useRef(null);

  // AI document processing needs the separately-hosted Python engine. When it's
  // not configured (e.g. on Vercel), the app degrades to manual entry only.
  const AI_ENABLED = ["true", "1"].includes(process.env.NEXT_PUBLIC_AI_ENABLED);

  const [period, setPeriod] = useState(defaultPeriod());
  const { month, year } = period;
  const holidays = useMemo(() => holidaysInMonth(year, month), [year, month]);

  const [mode, setMode] = useState("upload"); // upload | review
  const [file, setFile] = useState(null);
  const [previewPages, setPreviewPages] = useState([]);
  const [previewDoc, setPreviewDoc] = useState(null); // browser-native preview
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [drag, setDrag] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  // non-fatal: the hours still save, but the original document didn't attach
  const [attachWarn, setAttachWarn] = useState("");
  const [aiMeta, setAiMeta] = useState(null);

  const [fields, setFields] = useState({
    employee_name: profile.full_name || "", employee_id: profile.employee_code || "",
    client: profile.client || "", project: "", employer: profile.employer || "",
  });
  const [calendar, setCalendar] = useState([]);
  const [q, setQ] = useState({});
  const [holidayWork, setHolidayWork] = useState({});
  const [dayIdx, setDayIdx] = useState(null);

  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [timesheetId, setTimesheetId] = useState(null);

  // live validation + totals
  const validation = useMemo(
    () => validateTimesheet({ fields, calendar, questionnaire: q, holidayWork, holidays }),
    [fields, calendar, q, holidayWork, holidays]
  );
  const totals = {
    regular: validation.calReg, overtime: validation.calOt,
    total: validation.calTotal, weekendHrs: validation.weekendHrs,
  };
  const setField = (k) => (e) => setFields({ ...fields, [k]: e.target.value });

  // ---------- file selection + preview ----------
  // PDFs and images render natively in the browser (no server round-trip at
  // all); Office files fall back to the engine's page renderer when one is
  // configured, else a friendly "open the original" notice.
  const IMG_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
  function docKind(name) {
    const ext = (name || "").split(".").pop().toLowerCase();
    if (ext === "pdf") return "pdf";
    if (IMG_EXTS.includes(ext)) return "image";
    return "other";
  }
  function dropPreviewDoc() {
    setPreviewDoc((d) => {
      if (d?.url?.startsWith("blob:")) URL.revokeObjectURL(d.url);
      return null;
    });
  }

  async function onPickFile(f) {
    if (!f) return;
    setFile(f);
    storedRef.current = null;      // new file -> needs its own storage upload
    setPreviewPages([]);
    dropPreviewDoc();
    const kind = docKind(f.name);
    if (kind === "pdf" || kind === "image") {
      setPreviewDoc({ url: URL.createObjectURL(f), kind });
      setShowPreview(true);
      return;                          // browser renders it -- no server needed
    }
    // Office/CSV: only the engine can render pages; try it, degrade gracefully.
    setShowPreview(true);
    setPreviewLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.pages?.length) setPreviewPages(data.pages);
      else setPreviewDoc(data?.doc || { kind: "other" });
    } catch {
      setPreviewDoc({ kind: "other" });
    } finally {
      setPreviewLoading(false);
    }
  }

  // ---------- source-document storage (once per picked file, every path) ----
  const storedRef = useRef(null); // { fileName, path } for the current file
  async function ensureStored(f) {
    if (!f) return null;
    if (storedRef.current?.fileName === f.name) return storedRef.current.path;
    const ext = f.name.includes(".") ? f.name.split(".").pop() : "bin";
    const path = `${uid}/${year}-${String(month).padStart(2, "0")}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("ts-uploads").upload(path, f, {
      contentType: f.type || "application/octet-stream", upsert: true,
    });
    // Only memoize on success, so a retry actually re-uploads instead of
    // recording a storage_path that points at a key which was never written.
    if (error) throw new Error(`couldn't save your file (${error.message || "upload failed"})`);
    storedRef.current = { fileName: f.name, path };
    return path;
  }

  // ---------- AI processing ----------
  async function processAI() {
    if (!file) return;
    setProcessing(true);
    setProcessError("");
    setAttachWarn("");
    let storagePath = null;
    try {
      // 1) keep the source in storage (memoized -- never re-uploads).
      // A storage failure must NOT abort extraction: carry on with a null path
      // so we never record a ts_files row pointing at a key that isn't there.
      try {
        storagePath = await ensureStored(file);
      } catch (e) {
        storagePath = null;
        setAttachWarn(
          `${e.message || e} — your hours will still be saved, but your manager won't see the original document.`
        );
      }

      // 2) run the engine
      const fd = new FormData();
      fd.append("file", file);
      fd.append("month", String(month));
      fd.append("year", String(year));
      const res = await fetch("/api/process", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "processing failed");

      const emp = data.employee;
      const cal = data.calendar;
      setCalendar(cal);
      if (emp) {
        setFields((prev) => ({
          ...prev,
          employee_name: emp.employee_name || prev.employee_name,
          employee_id: emp.employee_id || prev.employee_id,
          client: (emp.clients && emp.clients[0]) || prev.client,
          project: (emp.projects && emp.projects[0]) || prev.project,
        }));
      }
      const t = data.totals || rollup(cal);
      setQ((prev) => ({
        ...prev,
        regularHours: t.regular,
        overtimeHours: t.overtime,
        workedWeekends: cal.some((c) => c.isWeekend && c.total > 0) ? "yes" : "no",
      }));
      // default holiday-worked from the calendar
      const hw = {};
      for (const date of Object.keys(holidays)) {
        const c = cal.find((x) => x.date === date);
        hw[date] = !!(c && c.total > 0);
      }
      setHolidayWork(hw);
      setAiMeta({
        confidence: emp?.confidence, llm_used: data.llm_used,
        count: data.employee_count, fileName: data.file_name,
        flow: data.flow || null, agentTrace: data.agent_trace || null,
        reviewStatus: data.review_status || null,
      });

      // 3) persist the AI baseline
      await saveBaseline({
        cal, emp, storagePath, file,
        aiStatus: emp ? "ok" : "failed", confidence: emp?.confidence ?? null,
      });
      setMode("review");
    } catch (e) {
      setProcessError(String(e.message || e));
    } finally {
      setProcessing(false);
    }
  }

  async function startManual() {
    const emptyCal = buildCalendar(null, month, year);
    // a file was attached: ALWAYS keep it in storage + record it, so the admin
    // can cross-verify the submission against the original document -- manual
    // entry included (previously only when AI was disabled, which left admins
    // with nothing to preview for manual submissions).
    setAttachWarn("");
    if (file) {
      try {
        const storagePath = await ensureStored(file);
        await saveBaseline({ cal: emptyCal, emp: null, storagePath, file, aiStatus: "manual", confidence: null });
      } catch (e) {
        // non-fatal: proceed to manual entry, but say so instead of going quiet
        setAttachWarn(
          `${e.message || e} — you can still enter your hours, but your manager won't see the original document.`
        );
      }
    }
    setCalendar(emptyCal);
    setQ({ regularHours: "", overtimeHours: "", workedWeekends: "" });
    setHolidayWork({});
    setAiMeta(null);
    setMode("review");
  }

  // ---------- persistence ----------
  async function saveBaseline({ cal, emp, storagePath, file, aiStatus, confidence }) {
    let fileId = null;
    if (storagePath && file) {
      const { data: fr, error: fileErr } = await supabase
        .from("ts_files")
        .insert({
          user_id: uid, month, year, file_name: file.name,
          storage_path: storagePath, mime_type: file.type || null,
          size_bytes: file.size || null, status: "processed",
        })
        .select("id").single();
      if (fileErr) throw new Error(fileErr.message || "couldn't record the uploaded file");
      fileId = fr?.id || null;
    }
    const r = rollup(cal);
    const { data: tr, error: tsErr } = await supabase
      .from("ts_timesheets")
      .upsert(
        {
          user_id: uid, file_id: fileId, month, year,
          employee_name: emp?.employee_name || fields.employee_name || null,
          employee_id: emp?.employee_id || fields.employee_id || null,
          client: (emp?.clients && emp.clients[0]) || fields.client || null,
          projects: emp?.projects || null,
          monthly_regular: r.regular, monthly_overtime: r.overtime,
          monthly_total: r.total, days_worked: r.daysWorked,
          days: cal, questionnaire: {}, validation: {},
          ai_confidence: confidence, ai_status: aiStatus,
        },
        { onConflict: "user_id,year,month" }
      )
      .select("id").single();
    // Never swallow this: if it fails, ensureTimesheet() would return undefined
    // and the submission below would be written with a NULL timesheet_id,
    // silently detaching it from the source document in the admin console.
    if (tsErr) throw new Error(tsErr.message || "couldn't save your timesheet");
    if (tr?.id) setTimesheetId(tr.id);
    return tr?.id;
  }

  async function ensureTimesheet() {
    if (timesheetId) return timesheetId;
    return saveBaseline({
      cal: calendar, emp: null, storagePath: null, file: null,
      aiStatus: "manual", confidence: null,
    });
  }

  async function submit() {
    if (!validation.ok) return;
    setSaving(true);
    setSavedMsg("");
    try {
      const tid = await ensureTimesheet();
      const r = rollup(calendar);
      const { error } = await supabase.from("ts_employee_edits").insert({
        timesheet_id: tid, user_id: uid, month, year,
        fields: { ...fields, totals: r,
                  flow: aiMeta?.flow || null, agent_trace: aiMeta?.agentTrace || null,
                  review_status: aiMeta?.reviewStatus || null },
        days: calendar,
        questionnaire: { ...q, holidayWork },
        validation: { errors: validation.errors, warnings: validation.warnings },
        submitted: true,
      });
      if (error) throw error;
      // keep ts_timesheets totals in sync with the latest edit
      await supabase.from("ts_timesheets").update({
        monthly_regular: r.regular, monthly_overtime: r.overtime,
        monthly_total: r.total, days_worked: r.daysWorked,
        questionnaire: { ...q, holidayWork },
        validation: { errors: validation.errors, warnings: validation.warnings },
      }).eq("id", tid);
      setSavedMsg("Timesheet submitted ✓  Your manager can now review it.");
      setJustSubmitted(true);
    } catch (e) {
      setProcessError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  }

  function resetForNew() {
    setMode("upload"); setFile(null); setPreviewPages([]); setShowPreview(false);
    dropPreviewDoc();
    storedRef.current = null;
    setCalendar([]); setQ({}); setHolidayWork({}); setAiMeta(null);
    setProcessError(""); setSavedMsg(""); setTimesheetId(null);
    setJustSubmitted(false);
  }

  // ---------- render ----------
  return (
    <>
      <Topbar profile={profile} active="dashboard" />
      <div className="container" style={{ padding: "22px 24px 60px" }}>
        <div className="between" style={{ marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22 }}>My Timesheet</h1>
            <p className="muted" style={{ marginTop: 2 }}>
              Period auto-selected for you — <b>{periodLabel(month, year)}</b>.
              {new Date().getDate() <= 10 && " (Within the grace window, so last month is shown.)"}
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <select value={month} onChange={(e) => setPeriod({ ...period, month: +e.target.value })} disabled={mode === "review"}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <input type="number" value={year} style={{ width: 90 }}
              onChange={(e) => setPeriod({ ...period, year: +e.target.value })} disabled={mode === "review"} />
          </div>
        </div>

        {savedMsg && <div className="alert ok" style={{ marginBottom: 16 }}>{savedMsg}
          <a style={{ marginLeft: "auto" }} onClick={resetForNew} role="button">Start another</a></div>}

        {/* Shown in BOTH steps: UploadStep renders processError itself, but a
            failure while submitting from the review step had no render site,
            so a failed submit used to show the user nothing at all. */}
        {attachWarn && <div className="alert" style={{ marginBottom: 16 }}>{attachWarn}</div>}
        {processError && mode === "review" && (
          <div className="alert error" style={{ marginBottom: 16 }}>{processError}</div>
        )}

        {mode === "upload" && (
          <UploadStep
            file={file} drag={drag} setDrag={setDrag} fileInput={fileInput}
            onPickFile={onPickFile} processing={processing} processAI={processAI}
            startManual={startManual} processError={processError}
            previewPages={previewPages} previewDoc={previewDoc} previewLoading={previewLoading}
            aiEnabled={AI_ENABLED}
          />
        )}

        {mode === "review" && (
          <ReviewStep
            fields={fields} setField={setField} calendar={calendar} month={month} year={year}
            onDayClick={setDayIdx} validation={validation} totals={totals}
            q={q} setQ={setQ} holidays={holidays} holidayWork={holidayWork} setHolidayWork={setHolidayWork}
            aiMeta={aiMeta} saving={saving} submit={submit}
            showPreview={showPreview && (previewPages.length > 0 || !!previewDoc)}
            previewPages={previewPages} previewDoc={previewDoc} previewLoading={previewLoading}
            fileName={file?.name} togglePreview={() => setShowPreview((s) => !s)}
            resetForNew={resetForNew}
          />
        )}
      </div>

      {justSubmitted && (
        <SubmitSuccess
          period={periodLabel(month, year)}
          totals={rollup(calendar)}
          onClose={() => setJustSubmitted(false)}
          onNew={resetForNew}
        />
      )}

      {dayIdx != null && (
        <DayModal
          day={calendar[dayIdx]}
          onClose={() => setDayIdx(null)}
          onSave={(upd) => {
            const next = calendar.slice();
            next[dayIdx] = upd;
            setCalendar(next);
            setDayIdx(null);
          }}
        />
      )}
    </>
  );
}

// ---------------- upload step ----------------
function UploadStep({ file, drag, setDrag, fileInput, onPickFile, processing, processAI, startManual, processError, previewPages, previewDoc, previewLoading, aiEnabled }) {
  const card = (
    <div className="card card-pad">
      <h3 className="card-title">{aiEnabled ? "1 · Upload your timesheet" : "Your timesheet"}</h3>
      {!aiEnabled && (
        <div className="alert info" style={{ marginBottom: 14 }}>
          AI auto-fill isn’t enabled in this deployment. Attach your file (optional, stored for your manager) and enter your hours on the next screen.
        </div>
      )}
      <div
        className={"dropzone" + (drag ? " drag" : "")}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); onPickFile(e.dataTransfer.files?.[0]); }}
      >
        <input ref={fileInput} type="file" hidden
          accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.docx,.doc"
          onChange={(e) => onPickFile(e.target.files?.[0])} />
        <div style={{ fontSize: 30 }}>📄</div>
        <div style={{ fontWeight: 600, marginTop: 6 }}>
          {file ? file.name : aiEnabled ? "Drop a file or click to browse" : "Attach your timesheet (optional)"}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          PDF, scanned PDF, Excel, CSV, Word, or an image
        </div>
      </div>

      {processError && <div className="alert error" style={{ marginTop: 14 }}>{processError}</div>}

      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        {aiEnabled && (
          <button className="btn btn-primary" disabled={!file || processing} onClick={processAI}>
            {processing ? <><span className="spinner" /> Processing with AI…</> : "✨ Process with AI"}
          </button>
        )}
        <button className={"btn " + (aiEnabled ? "btn-ghost" : "btn-primary")} onClick={startManual} disabled={processing}>
          {aiEnabled ? "Enter manually instead" : "Continue to enter hours →"}
        </button>
      </div>
      {aiEnabled && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          The AI reads your document and fills the calendar + details. You can fix anything it misses on the next screen.
        </p>
      )}
    </div>
  );

  // once a file is picked, show the live source preview beside the uploader
  if (file && (previewPages.length > 0 || previewDoc || previewLoading)) {
    return (
      <div className="split">
        <div className="stack">{card}</div>
        <PreviewPane pages={previewPages} doc={previewDoc} loading={previewLoading} fileName={file.name} />
      </div>
    );
  }
  return <div className="stack" style={{ maxWidth: 640 }}>{card}</div>;
}

// ---------------- review step ----------------
function ReviewStep({
  fields, setField, calendar, month, year, onDayClick, validation, totals,
  q, setQ, holidays, holidayWork, setHolidayWork, aiMeta, saving, submit,
  showPreview, previewPages, previewDoc, previewLoading, fileName, togglePreview, resetForNew,
}) {
  const left = (
    <div className="stack">
      {aiMeta && (
        <div className="alert info">
          ✨ AI populated this from <b>{aiMeta.fileName}</b>
          {aiMeta.confidence != null && <> · confidence {Math.round(aiMeta.confidence * 100)}%</>}
          {aiMeta.llm_used ? " · LLM used" : ""}. Review and correct anything below.
        </div>
      )}

      {/* validation banner */}
      {validation.errors.length > 0 ? (
        <div className="alert error">
          <div>
            <b>Please fix {validation.errors.length} issue{validation.errors.length > 1 ? "s" : ""} before submitting:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        </div>
      ) : (
        <div className="alert ok">✓ Calendar and answers match. Ready to submit.</div>
      )}
      {validation.warnings.length > 0 && (
        <div className="alert warn">
          <div>
            <b>Heads up:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* totals */}
      <div className="tiles">
        <div className="tile reg"><div className="v">{totals.regular}</div><div className="l">Regular hrs</div></div>
        <div className="tile ot"><div className="v">{totals.overtime}</div><div className="l">Overtime hrs</div></div>
        <div className="tile tot"><div className="v">{totals.total}</div><div className="l">Total hrs</div></div>
        <div className="tile"><div className="v">{calendar.filter((c) => c.total > 0).length}</div><div className="l">Days worked</div></div>
      </div>

      {/* identity fields */}
      <div className="card card-pad">
        <h3 className="card-title">Details {aiMeta ? "(AI-filled — edit if wrong)" : ""}</h3>
        <div className="grid-2">
          <Field label="Employee name"><input value={fields.employee_name} onChange={setField("employee_name")} /></Field>
          <Field label="Employee ID / code"><input value={fields.employee_id} onChange={setField("employee_id")} /></Field>
          <Field label="Client / placement"><input value={fields.client} onChange={setField("client")} /></Field>
          <Field label="Project"><input value={fields.project} onChange={setField("project")} /></Field>
        </div>
      </div>

      {/* calendar */}
      <div className="card card-pad">
        <div className="between" style={{ marginBottom: 10 }}>
          <h3 className="card-title" style={{ margin: 0 }}>Calendar — click any day to edit</h3>
          <div className="row" style={{ gap: 8 }}>
            {(previewPages.length > 0 || previewDoc) && (
              <button className="btn btn-ghost btn-sm" onClick={togglePreview}>
                {showPreview ? "Hide source" : "📄 Show source"}
              </button>
            )}
          </div>
        </div>
        <Legend />
        <Calendar calendar={calendar} month={month} year={year} onDayClick={onDayClick} />
      </div>

      {/* questionnaire */}
      <Questionnaire q={q} setQ={setQ} holidays={holidays} holidayWork={holidayWork}
        setHolidayWork={setHolidayWork} calendar={calendar} totals={totals} />

      {/* submit */}
      <div className="card card-pad between">
        <div className="muted" style={{ fontSize: 13 }}>
          {validation.ok ? "Everything checks out." : "Resolve the errors above to enable submit."}
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={resetForNew}>Start over</button>
          <button className="btn btn-primary" disabled={!validation.ok || saving} onClick={submit}>
            {saving ? <><span className="spinner" /> Submitting…</> : "Submit timesheet"}
          </button>
        </div>
      </div>
    </div>
  );

  if (showPreview) {
    return (
      <div className="split">
        {left}
        <PreviewPane pages={previewPages} doc={previewDoc} loading={previewLoading} fileName={fileName} onClose={togglePreview} />
      </div>
    );
  }
  return left;
}

// ---------------- submitted! ----------------
function SubmitSuccess({ period, totals, onClose, onNew }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal success-card" onClick={(e) => e.stopPropagation()}>
        <div className="success-check" aria-hidden>✓</div>
        <h2 style={{ margin: "14px 0 4px" }}>Timesheet submitted!</h2>
        <p className="muted" style={{ margin: 0 }}>
          Your <b>{period}</b> timesheet is in. Your manager can now review it.
        </p>
        <div className="tiles" style={{ margin: "18px 0 6px" }}>
          <div className="tile tot"><div className="v">{totals.total}</div><div className="l">Total hrs</div></div>
          <div className="tile reg"><div className="v">{totals.regular}</div><div className="l">Regular</div></div>
          <div className="tile ot"><div className="v">{totals.overtime}</div><div className="l">Overtime</div></div>
          <div className="tile"><div className="v">{totals.daysWorked}</div><div className="l">Days</div></div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 16px" }}>
          What happens next: an admin reviews your submission — you’ll be contacted
          only if something needs a correction. You can still reopen and edit it
          before it’s approved.
        </p>
        <div className="row" style={{ justifyContent: "center", gap: 10 }}>
          <button className="btn btn-ghost" onClick={onNew}>Start another month</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
function Legend() {
  return (
    <div className="legend">
      <span><i className="swatch" style={{ background: "var(--surface)" }} /> Worked</span>
      <span><i className="swatch" style={{ background: "var(--surface-2)" }} /> Weekend</span>
      <span><i className="swatch" style={{ background: "var(--purple-soft)", borderColor: "#d8b4fe" }} /> Holiday</span>
      <span><i className="swatch" style={{ background: "#fffbeb", borderColor: "#fbbf24" }} /> Missing</span>
      <span><i className="swatch" style={{ background: "var(--surface)", borderColor: "var(--red)" }} /> Flagged</span>
    </div>
  );
}
