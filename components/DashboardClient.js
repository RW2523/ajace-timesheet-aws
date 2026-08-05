"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import Calendar, { STANDARD_DAY, dayHours } from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import useDialogKeys from "@/components/useDialogKeys";
import Questionnaire from "@/components/Questionnaire";
import PreviewPane from "@/components/PreviewPane";
import { createClient } from "@/lib/api/client";
import { defaultPeriod, periodLabel, MONTHS } from "@/lib/month";
import { holidaysInMonth } from "@/lib/holidays";
import { buildCalendar, rollup } from "@/lib/engine";
import { emptyWeekdays, fillEmptyWeekdays } from "@/lib/fill";
import { validateTimesheet } from "@/lib/validate";
import {
  applyToDate, clearWorkedHours, restoreWorkedHours,
  setWorkedHours as setWorkedHoursOn, workedHoursOf,
} from "@/lib/holidayhours";
import { approvalSummary, approvalErrors } from "@/lib/approval";
// One source of truth for "what files does this app accept, and what can we
// show for them". Pure module (no imports, no node builtins), safe in a client
// bundle. Everything the picker decides comes from here so it can never again
// offer a file the uploader will reject.
import {
  ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, previewKindOf, previewNote, uploadProblem,
} from "@/lib/aws/filetypes";

// What the OS file dialog offers, and what the dropzone promises — both derived
// from the allowlist, so neither can advertise a file the uploader would reject.
// (The dialog is a hint only: drag-and-drop ignores `accept` entirely, which is
// why onPickFile re-checks with uploadProblem().)
const ACCEPT_ATTR = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

// The preview request itself never completed (offline, timeout, 5xx). The file
// is fine and so are the hours, so say that rather than leaving an empty pane —
// PreviewPane must never be handed a `doc` without a reason.
const previewFailedDoc = () => ({ kind: "other", reason: "failed", message: previewNote("failed") });

export default function DashboardClient({ profile, submissions = [] }) {
  const api = createClient();
  const router = useRouter();
  const uid = profile.id;
  const fileInput = useRef(null);

  // AI document processing needs the separately-hosted Python engine. When it's
  // not configured (e.g. on Vercel), the app degrades to manual entry only.
  const AI_ENABLED = ["true", "1"].includes(process.env.NEXT_PUBLIC_AI_ENABLED);

  const [period, setPeriod] = useState(defaultPeriod());
  const { month, year } = period;
  // defaultPeriod() is a GUESS (lib/month.js: prior month until the 10th, then
  // the current one). It is right for someone submitting on time and wrong for
  // everyone else, so the controls that change it must stay reachable — most of
  // all AFTER a document has been read, which is the only moment the employee
  // can actually see that the guess was wrong.
  const [periodTouched, setPeriodTouched] = useState(false);
  // A period change in the review step rebuilds the month, so it is confirmed
  // first. Holds the requested { month, year } while the dialog is open.
  const [pendingPeriod, setPendingPeriod] = useState(null);
  // Year options: a timesheet is filed within a year or so of being worked.
  // A <select> rather than a number input on purpose — a controlled number
  // input cannot be edited a digit at a time once every keystroke has to be
  // confirmed (typing "202…" would be rejected and snap back).
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const set = new Set([now - 2, now - 1, now, now + 1, year]);
    return [...set].sort((a, b) => b - a);
  }, [year]);

  // What (if anything) this employee has already submitted for the chosen month.
  // Superseded rows are earlier attempts that a later submission replaced.
  const mine = useMemo(
    () => submissions.filter((s) => s.year === year && s.month === month),
    [submissions, year, month]
  );
  const currentSubmission = mine.find((s) => s.status !== "superseded") || null;
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
  // The manager-approval reading from /api/process (lib/approval.js shape), kept
  // as its own piece of state because Questionnaire needs it as a PROP to seed
  // the answer. It was being read off the response and dropped, which left the
  // approval card permanently in its "no document was read" branch — so every
  // employee, including one whose document IS signed, had to tick "this
  // timesheet has NOT been approved" to get past validation.
  // null means "nothing looked at this document", NEVER "not approved".
  const [aiApproval, setAiApproval] = useState(null);

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
  // The ts_timesheets row for the CURRENT period, tagged with the period it was
  // created for. The id alone is unsafe: ts_timesheets is unique on
  // (user_id, year, month), so an id captured while August was selected must
  // never be reused after the employee switches to July — that would file July's
  // hours against August's row. Tagging it makes the stale-id case unreachable
  // instead of relying on every call site to remember to clear it.
  const [timesheetRef, setTimesheetRef] = useState(null); // { id, month, year }
  const timesheetId = timesheetRef && timesheetRef.month === month &&
    timesheetRef.year === year ? timesheetRef.id : null;
  // Exactly what was last written to ts_employee_edits, serialised. The review
  // form stays on screen after a submit (the success modal is dismissible), so
  // without this the Submit button is indistinguishable from "not yet filed" and
  // a second click writes a second append-only row. Comparing against the live
  // form means a genuine CORRECTION re-enables submitting by itself — the row is
  // append-only on purpose, we only refuse to re-send an identical one.
  const [submittedSig, setSubmittedSig] = useState(null);

  // Frozen copy of what the AI actually read, kept so "Worked" on a holiday can
  // LOOK UP the extracted hours after the user has cleared that day. `calendar`
  // is edited in place, so without this snapshot there is nothing to restore.
  // Never mutated after processAI writes it.
  const aiBaseline = useRef(null);
  // Required-field highlighting only appears after the first submit attempt —
  // a freshly opened form covered in red is noise, not guidance.
  const [showErrors, setShowErrors] = useState(false);

  // live validation + totals
  const validation = useMemo(
    () => validateTimesheet({ fields, calendar, questionnaire: q, holidayWork, holidays }),
    [fields, calendar, q, holidayWork, holidays]
  );
  const totals = {
    regular: validation.calReg, overtime: validation.calOt,
    other: validation.calOther, total: validation.calTotal,
    weekendHrs: validation.weekendHrs,
  };
  const setField = (k) => (e) => setFields({ ...fields, [k]: e.target.value });

  // Signature of everything submit() sends. Same inputs, same order, so it can
  // be compared byte-for-byte against the snapshot taken at the last submit.
  const currentSig = useMemo(
    () => JSON.stringify({ fields, calendar, q, holidayWork }),
    [fields, calendar, q, holidayWork]
  );
  const alreadySubmitted = submittedSig != null && submittedSig === currentSig;

  // ---------- per-day hour edits for the holiday Worked / Not-worked toggles --
  // These six functions ARE the PROPS CONTRACT written at the top of
  // Questionnaire.js — same names, same order. Read that block before touching
  // either side, and change both in one commit. The toggles shipped inert once
  // because the two files were wired to different names: React silently applies
  // a component's own defaults for props the caller doesn't pass, so the card
  // compiled, rendered, and did nothing — "Not worked" left the hours in `days`
  // (the day read "not worked" and was still paid) and the hours box was
  // replaced by a note telling the employee to hunt for the day in the grid.
  //
  // `calendar` is what submit() sends as `days`, and lib/aws/data.js re-derives
  // monthly_regular / monthly_overtime / monthly_total / days_worked from it,
  // overwriting anything the client claims — so nothing here computes a total.
  // Functional setCalendar throughout, so two quick clicks can't drop an update.

  // The hour transforms themselves are in lib/holidayhours.js — pure day-in /
  // day-out functions, so what they do to `days` (and therefore to pay) is
  // asserted in test/holiday-toggle.test.mjs without a browser or a database.
  // Everything below is wiring: find the day, apply the transform, set state.

  // PAID hours on a day — the way lib/aws/data.js deriveTotals() adds one up.
  function hoursOnDate(date) {
    return dayHours(calendar.find((c) => c.date === date));
  }

  // WORKED hours on a day: regular + overtime, never `other`. Holiday pay, PTO
  // and sick sit in `other` and are paid WITHOUT being worked, so every "did you
  // work this day?" question has to ignore them.
  function workedHoursOnDate(date) {
    return workedHoursOf(calendar.find((c) => c.date === date));
  }

  // The WORKED hours the extraction read for a date; null when it read none
  // (manual entry, or the AI found nothing worked that day). Deliberately not
  // dayHours(): treating 8h of extracted holiday PAY as 8h worked would invent
  // work that never happened.
  function aiHoursOnDate(date) {
    const src = aiBaseline.current?.find((c) => c.date === date);
    if (!src) return null;
    const h = workedHoursOf(src);
    return h > 0 ? h : null;
  }

  // "Not worked" — drops the worked hours, keeps `other`. See clearWorkedHours.
  function clearDayHours(date) {
    setCalendar((cal) => applyToDate(cal, date, clearWorkedHours));
  }

  // "Worked" — undo for a mis-clicked "Not worked". Returns the hours restored,
  // or null when the document had none to look up (the card then leaves the box
  // empty for the employee to type into — it never invents hours).
  function restoreAiHours(date) {
    const src = aiBaseline.current?.find((c) => c.date === date);
    const worked = workedHoursOf(src);
    if (!src || worked <= 0) return null;
    setCalendar((cal) => applyToDate(cal, date, (c) => restoreWorkedHours(c, src)));
    return worked;
  }

  // Explicit hours for one day, same shape DayModal.save() produces.
  function setDayHours(date, hours) {
    setCalendar((cal) => applyToDate(cal, date, (c) => setWorkedHoursOn(c, hours)));
  }

  // ---------- bulk weekday fill --------------------------------------------
  // Manual entry — the path EVERY user lands on when the AI fails, when
  // NEXT_PUBLIC_AI_ENABLED is off, or when there is no document — had no way to
  // say "I worked a normal month". Each of ~22 weekdays had to be opened, typed
  // into and saved one at a time (~3 interactions each, ~60 in total), and until
  // that was finished every one of those days rendered amber (.cell.missing in
  // Calendar.js) with a matching "N weekday(s) have no hours entered" warning
  // from validate.js. The blank form therefore presented as 22 problems before
  // the employee had done anything wrong.
  //
  // MONEY SAFETY — this touches hours, so be precise about what changes:
  //   * It writes ONLY into `calendar`, which submit() posts as `days`.
  //     lib/aws/data.js still re-derives monthly_regular / monthly_overtime /
  //     monthly_total / days_worked from that array and overwrites anything
  //     else; nothing here computes or posts a monthly figure.
  //   * The ONLY server-derived change is that days which previously carried no
  //     hours at all now carry `regular` = the chosen figure. So
  //     monthly_regular and monthly_total each rise by hours × days filled, and
  //     days_worked rises by the number of days filled. monthly_overtime is
  //     untouched — `overtime` is never written here.
  //   * It never touches a day that already has anything on it (see the
  //     `!c.filled` predicate below), so it cannot overwrite an AI extraction,
  //     an earlier manual edit, or an explicit 0 meaning "I did not work".
  //   * The employee's own stated totals in the questionnaire are still NOT
  //     pre-filled, so validate.js's independent cross-check is unaffected: a
  //     bulk fill that doesn't match what they type still blocks submission.
  //
  // The rules themselves live in lib/fill.js as pure functions so they can be
  // tested against lib/engine.js rollup() and the server's own derivation
  // without rendering anything — see test/bulk-fill.test.mjs.
  const [bulkHours, setBulkHours] = useState(String(STANDARD_DAY));
  const [bulkMsg, setBulkMsg] = useState("");
  // Previous calendar, kept so one mis-click is reversible. State, not a ref,
  // because the Undo button has to appear when it is set.
  const [bulkUndo, setBulkUndo] = useState(null);

  const emptyWeekdayCount = useMemo(() => emptyWeekdays(calendar).length, [calendar]);

  function fillWeekdays() {
    const { days, filled, error } = fillEmptyWeekdays(calendar, bulkHours);
    if (error) { setBulkMsg(error); return; }
    setBulkUndo(calendar);
    setCalendar(days);
    setBulkMsg(
      `Filled ${filled} weekday${filled > 1 ? "s" : ""} with ${round2(Number(bulkHours))}h each. ` +
      `Click any day to change it.`
    );
  }

  function undoFill() {
    if (!bulkUndo) return;
    setCalendar(bulkUndo);
    setBulkUndo(null);
    setBulkMsg("Undone — those days are empty again.");
  }

  // Open the existing day editor for a date (used by "Edit day →").
  function openDay(date) {
    const i = calendar.findIndex((c) => c.date === date);
    if (i >= 0) setDayIdx(i);
  }

  // ---------- file selection + preview ----------
  // PDFs and browser-renderable images are shown straight from the picked File
  // (no server round-trip at all); iPhone photos and Office files go to
  // /api/preview, which transcodes or parses them and, failing that, answers
  // with a worded card. Which bucket a file falls into is previewKindOf()'s
  // decision, not a list maintained here: this component used to keep its own
  // IMG_EXTS that claimed bmp/tif/tiff were images. Nothing in the stack can
  // render those and the uploader rejects them outright, so one .tif produced
  // three contradictory messages — a broken <img>, a preview card reading
  // "Document not in storage" about a file still sitting on the user's disk,
  // and only then an amber "that file type isn't supported" from the upload.
  function dropPreviewDoc() {
    setPreviewDoc((d) => {
      if (d?.url?.startsWith("blob:")) URL.revokeObjectURL(d.url);
      return null;
    });
  }

  async function onPickFile(f) {
    if (!f) return;
    // REFUSE FIRST, using the same table /api/storage/upload enforces. A file
    // this app cannot store must never reach the calendar: /api/process would
    // happily extract from it and the hours would save with the source document
    // silently detached from the payroll record. One message, said once, before
    // anything else happens.
    const bad = uploadProblem({ name: f.name, size: f.size });
    if (bad) {
      setFile(null);
      storedRef.current = null;
      setPreviewPages([]);
      dropPreviewDoc();
      setShowPreview(false);
      setProcessError(bad.message);
      if (fileInput.current) fileInput.current.value = "";  // let them re-pick the same name
      return;
    }
    setProcessError("");
    setFile(f);
    storedRef.current = null;      // new file -> needs its own storage upload
    setPreviewPages([]);
    dropPreviewDoc();
    const kind = previewKindOf(f.name);
    if (kind === "pdf" || kind === "image") {
      setPreviewDoc({ url: URL.createObjectURL(f), kind });
      setShowPreview(true);
      return;                          // browser renders it -- no server needed
    }
    // "photo" (HEIC/HEIF), "office" (xlsx/xls/csv/docx) and "none" (.doc): the
    // server transcodes, parses, or explains. /api/preview answers 200 with a
    // worded `doc` for every input, so the only case left to word ourselves is
    // the request never completing.
    setShowPreview(true);
    setPreviewLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.pages?.length) setPreviewPages(data.pages);
      else setPreviewDoc(data?.doc || previewFailedDoc());
    } catch {
      setPreviewDoc(previewFailedDoc());
    } finally {
      setPreviewLoading(false);
    }
  }

  // ---------- source-document storage (once per picked file, every path) ----
  const storedRef = useRef(null); // { fileName, month, year, path }
  // `per` is explicit rather than read from the closure: re-reading a file for a
  // NEWLY chosen month happens in the same tick as setPeriod, when the closure
  // still holds the old one.
  async function ensureStored(f, per = period) {
    if (!f) return null;
    // The storage key embeds the period, so the memo has to as well — otherwise
    // a re-read after a period switch returns the OLD month's key and the
    // manager opens the wrong month's document.
    if (storedRef.current?.fileName === f.name &&
        storedRef.current?.month === per.month &&
        storedRef.current?.year === per.year) return storedRef.current.path;
    const ext = f.name.includes(".") ? f.name.split(".").pop() : "bin";
    const path = `${uid}/${per.year}-${String(per.month).padStart(2, "0")}/${Date.now()}.${ext}`;
    const { error } = await api.storage.from("ts-uploads").upload(path, f, {
      contentType: f.type || "application/octet-stream", upsert: true,
    });
    // Only memoize on success, so a retry actually re-uploads instead of
    // recording a storage_path that points at a key which was never written.
    if (error) throw new Error(`couldn't save your file (${error.message || "upload failed"})`);
    storedRef.current = { fileName: f.name, month: per.month, year: per.year, path };
    return path;
  }

  // ---------- AI processing ----------
  // `per` defaults to the selected period and is passed explicitly by
  // applyPeriod(), which re-reads the same file for a month React has not
  // re-rendered with yet.
  async function processAI(per = period) {
    if (!file) return;
    setProcessing(true);
    setProcessError("");
    setAttachWarn("");
    // A previous "Discard" latched the autosave off; a new extraction is a new
    // draft and must be saved.
    draftOff.current = false;
    setResumedAt(null);
    let storagePath = null;
    try {
      // 1) keep the source in storage (memoized -- never re-uploads).
      // A storage failure must NOT abort extraction: carry on with a null path
      // so we never record a ts_files row pointing at a key that isn't there.
      try {
        storagePath = await ensureStored(file, per);
      } catch (e) {
        storagePath = null;
        setAttachWarn(
          `${e.message || e} — your hours will still be saved, but your manager won't see the original document.`
        );
      }

      // 2) run the engine. THE month sent here is what the extractor clips
      // every entry to (lib/directpp/extractor.js mapContract), so it must be
      // `per`, never the closure's.
      const fd = new FormData();
      fd.append("file", file);
      fd.append("month", String(per.month));
      fd.append("year", String(per.year));
      const res = await fetch("/api/process", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "processing failed");

      const emp = data.employee;
      const cal = data.calendar;
      setCalendar(cal);
      // a brand-new calendar: any earlier bulk-fill undo snapshot is now stale
      setBulkMsg(""); setBulkUndo(null);
      // freeze what the AI read, so a holiday cleared by "Not worked" can be
      // restored by "Worked" (and so a mis-click is undoable)
      aiBaseline.current = cal.map((c) => ({ ...c }));
      if (emp) {
        setFields((prev) => ({
          ...prev,
          employee_name: emp.employee_name || prev.employee_name,
          employee_id: emp.employee_id || prev.employee_id,
          client: (emp.clients && emp.clients[0]) || prev.client,
          project: (emp.projects && emp.projects[0]) || prev.project,
        }));
      }
      // DELIBERATELY NOT pre-filled from the extraction. These answers are the
      // only independent check on what the AI read; seeding them with the AI's
      // own totals made every misread agree with itself and show "ready to
      // submit". The employee states their hours; validate.js compares.
      setQ((prev) => ({ ...prev, regularHours: "", overtimeHours: "", workedWeekends: "" }));
      // Default holiday-worked from the calendar — from WORKED hours only.
      // c.total includes `other`, so an extracted 8h of holiday PAY used to
      // pre-select "Worked" on a day nobody worked, and the card then demanded
      // hours for it. The employee can still flip either toggle.
      const hw = {};
      for (const date of Object.keys(holidaysInMonth(per.year, per.month))) {
        const c = cal.find((x) => x.date === date);
        hw[date] = workedHoursOf(c) > 0;
      }
      setHolidayWork(hw);
      setAiMeta({
        confidence: emp?.confidence, llm_used: data.llm_used,
        count: data.employee_count, fileName: data.file_name,
        flow: data.flow || null, agentTrace: data.agent_trace || null,
        reviewStatus: data.review_status || null,
        // The server's signed receipt for that verdict. It is what makes the
        // verdict stick on submit — /api/data ignores review_status/flow unless
        // this receipt verifies against the signed-in user (lib/aws/jwt.js).
        aiStamp: data.ai_stamp || null,
        // The extractor computes these and they were being thrown away — they
        // are the only signals that flag a bad read to the person who can fix it.
        issues: emp?.issues || [],
        notes: emp?.notes || [],
        // Which OTHER months this document's entries were dated in, for the
        // entries that were clipped away as out-of-period. Diagnostic only —
        // it is never summed. Absent on the Python-engine flow, hence the [].
        offMonth: emp?.off_month_entries || [],
      });
      // The manager-approval reading. `data.approval` is already normalised and
      // gated by lib/approval.js (confidence bar, evidence required, no
      // self-approval), so the UI never re-decides what counts — it only shows
      // it. A flow that has no approval block at all sends null, which the card
      // treats as "ask the employee", never as "approved".
      setAiApproval(data.approval || null);

      // 3) persist the AI baseline
      await saveBaseline({
        cal, emp, storagePath, file,
        aiStatus: emp ? "ok" : "failed", confidence: emp?.confidence ?? null,
        per,
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
    // see processAI: entering the review step always re-arms the autosave
    draftOff.current = false;
    setResumedAt(null);
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
    aiBaseline.current = null;   // nothing was extracted: there is nothing to look up
    setQ({ regularHours: "", overtimeHours: "", workedWeekends: "" });
    setHolidayWork({});
    setAiMeta(null);
    // Manual entry: no document was read, so there is no detection to seed from.
    // The card falls through to the acknowledgement, which is the correct answer
    // here — not a leftover detection from a file processed a moment ago.
    setAiApproval(null);
    setShowErrors(false);
    // a fresh grid: no fill has happened yet, so there is nothing to undo
    setBulkHours(String(STANDARD_DAY)); setBulkMsg(""); setBulkUndo(null);
    setMode("review");
  }

  // ---------- persistence ----------
  async function saveBaseline({ cal, emp, storagePath, file, aiStatus, confidence,
                                per = period }) {
    const { month, year } = per;   // shadows the render closure ON PURPOSE
    let fileId = null;
    if (storagePath && file) {
      const { data: fr, error: fileErr } = await api
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
    const { data: tr, error: tsErr } = await api
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
    if (tr?.id) setTimesheetRef({ id: tr.id, month, year });
    return tr?.id;
  }

  async function ensureTimesheet(per = period) {
    // Period-checked against `per`, not against the render's period: a cached id
    // belonging to a different month must be ignored, not reused.
    const known = timesheetRef && timesheetRef.month === per.month &&
      timesheetRef.year === per.year ? timesheetRef.id : null;
    if (known) return known;
    return saveBaseline({
      cal: calendar, emp: null, storagePath: null, file: null,
      aiStatus: "manual", confidence: null, per,
    });
  }

  // ---------- resumable draft ------------------------------------------------
  // Correcting a 31-day grid is a long, once-a-month sitting, and re-running the
  // extraction costs minutes (docs/PROCESSING-TIME.md: 12s-6min typical, worst
  // case uncapped at ~30min). Until now a closed tab, a slept laptop or an
  // expired session threw ALL of it away: the screen always booted to `mode:
  // "upload"`, nothing was ever re-persisted after saveBaseline, and the
  // dashboard never read ts_timesheets back — even though saveBaseline had
  // already written the full grid there under unique(user_id,year,month).
  //
  // MONEY SAFETY — read this before touching anything below.
  //   * A draft's HOURS are `days` on ts_timesheets: the same column, written by
  //     the same /api/data path, that lib/aws/data.js re-derives
  //     monthly_regular / monthly_overtime / monthly_total / days_worked from.
  //     Every autosave sends `days`, so every autosave is derived server-side
  //     exactly like a submit is.
  //   * The `draft` jsonb carries NO hours-of-record. It holds the identity
  //     fields, the questionnaire answers, the holiday Worked/Not-worked map,
  //     the AI metadata + approval reading, and aiBaseline (the frozen
  //     extraction the holiday "Worked" lookup restores from). Nothing sums it.
  //   * resumeDraft() therefore rebuilds `calendar` from row.days and NEVER from
  //     the blob, so a resumed timesheet submits the identical array — and thus
  //     the identical derived totals — as the session that saved it.
  //   * Nothing here writes ts_employee_edits. A draft is not a submission; only
  //     submit() files one, and only after validation.ok.
  const [savedDraft, setSavedDraft] = useState(null);  // unfinished row for this period
  const [resumedAt, setResumedAt] = useState(null);    // set once a draft is restored
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState("");
  // Latch that stops the debounced writer from RESURRECTING a draft that
  // submit(), "Start over" or "Discard" has just cleared — an in-flight save
  // could otherwise land after the clear and re-offer a finished timesheet.
  const draftOff = useRef(false);
  const draftBusy = useRef(false);   // a write is in flight
  const draftAgain = useRef(false);  // ...and something changed while it was
  const draftUnsaved = useRef(false); // edits not yet persisted (beforeunload)

  // Look for an unfinished draft for the selected period. Scoped by eq filters
  // so this fetches one row, not every month the employee ever touched.
  useEffect(() => {
    let alive = true;
    setSavedDraft(null);
    (async () => {
      const { data, error } = await api
        .from("ts_timesheets")
        .select("id,month,year,days,draft")
        .eq("year", year)
        .eq("month", month)
        .single();
      // No row, or a row with draft = null (never started, or already
      // submitted), simply means "nothing to resume" — not an error worth
      // showing anyone.
      if (!alive || error || !data?.draft) return;
      setSavedDraft(data);
    })();
    return () => { alive = false; };
    // `api` is rebuilt every render and is stateless; depending on it would
    // refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  async function writeDraft() {
    if (draftOff.current) return;
    if (draftBusy.current) { draftAgain.current = true; return; }
    draftBusy.current = true;
    setDraftSaving(true);
    try {
      const tid = await ensureTimesheet();
      if (!tid) throw new Error("couldn't find a timesheet row to attach the draft to");
      const { error } = await api.from("ts_timesheets").update({
        // `days` is the hours of record and is ALWAYS sent, so data.js derives
        // monthly_* from it here exactly as it does on submit. Never post a
        // total instead.
        days: calendar,
        questionnaire: { ...q, holidayWork },
        validation: { errors: validation.errors, warnings: validation.warnings },
        employee_name: fields.employee_name || null,
        employee_id: fields.employee_id || null,
        client: fields.client || null,
        draft: {
          v: 1,
          savedAt: new Date().toISOString(),
          fields, q, holidayWork,
          aiMeta, aiApproval,
          aiBaseline: aiBaseline.current || null,
          fileName: file?.name || aiMeta?.fileName || null,
        },
      }).eq("id", tid);
      if (error) throw new Error(error.message || "couldn't save your draft");
      if (draftOff.current) {
        // submit() or discardDraft() latched off WHILE this write was in
        // flight, so this write may have re-created the draft after their
        // clear. Left alone, the employee's next visit offers to "resume" a
        // timesheet they already filed — and resuming it would file a second,
        // duplicate row. Undo it. `draft` carries no hours, so this repair
        // cannot touch a total.
        await api.from("ts_timesheets").update({ draft: null }).eq("id", tid);
        return;
      }
      draftUnsaved.current = false;
      setDraftSavedAt(new Date().toISOString());
      setDraftError("");
    } catch (e) {
      // Non-fatal by design: the form still works, they just must not close the
      // tab. Saying so is the whole point — silent failure is what we're fixing.
      setDraftError(String(e.message || e));
    } finally {
      draftBusy.current = false;
      setDraftSaving(false);
      if (draftAgain.current) { draftAgain.current = false; writeDraftRef.current(); }
    }
  }

  // Always call the LATEST writeDraft from the debounce timer; a captured one
  // would persist the state as it was when the timer was scheduled.
  const writeDraftRef = useRef(() => {});
  useEffect(() => { writeDraftRef.current = writeDraft; });

  // Debounced autosave. Declared AFTER the ref-assignment effect so the ref is
  // already fresh when this schedules.
  useEffect(() => {
    if (mode !== "review" || justSubmitted) return;
    // A filed timesheet is not a draft — submit() latched the writer off. But
    // EDITING it afterwards is a correction in progress, i.e. unfinished work
    // again, and losing that is the same bug. `alreadySubmitted` goes false the
    // moment anything differs from what was filed, so re-arm on exactly that.
    if (alreadySubmitted) return;
    draftOff.current = false;
    draftUnsaved.current = true;
    const t = setTimeout(() => { writeDraftRef.current(); }, 1200);
    return () => clearTimeout(t);
  }, [mode, justSubmitted, alreadySubmitted, calendar, fields, q, holidayWork, aiMeta, aiApproval]);

  // Last line of defence for the 1.2s window between a keystroke and its save.
  useEffect(() => {
    if (mode !== "review" || justSubmitted) return;
    const onLeave = (e) => {
      if (!draftUnsaved.current && !draftBusy.current) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [mode, justSubmitted]);

  function resumeDraft() {
    const row = savedDraft;
    if (!row) return;
    const d = row.draft || {};
    draftOff.current = false;
    // The draft row was fetched with .eq(year).eq(month), so it belongs to the
    // selected period; tag it with the row's own values regardless.
    setTimesheetRef({ id: row.id, month: row.month, year: row.year });
    // HOURS COME FROM row.days — the server-derived column — never from `draft`.
    setCalendar(Array.isArray(row.days) ? row.days : []);
    setFields((prev) => ({ ...prev, ...(d.fields || {}) }));
    setQ(d.q || {});
    setHolidayWork(d.holidayWork || {});
    setAiMeta(d.aiMeta || null);
    setAiApproval(d.aiApproval || null);
    aiBaseline.current = Array.isArray(d.aiBaseline) ? d.aiBaseline : null;
    setShowErrors(false);
    // A resumed draft has NOT been filed, whatever a previous session did.
    setSubmittedSig(null);
    setJustSubmitted(false);
    setProcessError(""); setSavedMsg("");
    // an undo snapshot belongs to the session that made the fill
    setBulkHours(String(STANDARD_DAY)); setBulkMsg(""); setBulkUndo(null);
    setDraftSavedAt(d.savedAt || null);
    setResumedAt(d.savedAt || null);
    draftUnsaved.current = false;
    setSavedDraft(null);
    setMode("review");
  }

  // Clearing a draft writes `draft: null` and nothing else. `draft` is not a
  // money-bearing column, so data.js's "days required when writing hours" guard
  // is not engaged and no total is touched.
  async function discardDraft(id) {
    const target = id || savedDraft?.id || timesheetId;
    draftOff.current = true;
    draftUnsaved.current = false;
    setSavedDraft(null);
    setDraftSavedAt(null);
    setResumedAt(null);
    if (!target) return;
    await api.from("ts_timesheets").update({ draft: null }).eq("id", target);
  }

  // ---------- changing the period -------------------------------------------
  // THE PROBLEM THIS SOLVES. The month/year controls used to be disabled for the
  // whole review step, and the period is only a guess (defaultPeriod()). The
  // extractor clips every entry to the month it was given
  // (lib/directpp/extractor.js mapContract) and buildCalendar drops whatever is
  // left over (lib/engine.js), so a July document read into an August period
  // yields an empty grid, no error, and no way back except "Start over" — which
  // throws away the extraction and demands a fresh upload and a fresh paid AI
  // run. Picking the wrong month was a dead end that cost the whole document.
  //
  // MONEY SAFETY. Switching the period changes NO arithmetic. rollup(),
  // validate.js and the server-side derivation in lib/aws/data.js are untouched;
  // `days` is still the only hours-of-record and is still what gets posted, so
  // monthly_regular / monthly_overtime / monthly_total / days_worked are still
  // derived server-side from it. What a switch does is REPLACE the day array
  // with one belonging to the new month — either a fresh empty grid, or the same
  // document re-read for that month — after which the server derives that new
  // month's totals from that new array. Every piece of month-keyed state has to
  // move with it, or the mixture is worse than the dead end it replaces:
  //   * timesheetRef — ts_timesheets is unique on (user_id, year, month).
  //     Reusing the old row's id would file the new month's hours against the
  //     old month's row. Cleared here AND period-checked at every read.
  //   * storedRef — the storage key embeds the period.
  //   * calendar / q / holidayWork — dates are literal ISO strings, and the
  //     questionnaire answers describe a specific month. There is no honest
  //     remapping of "3 July, 8h" into August, so the grid is rebuilt rather
  //     than carried over.
  //   * submittedSig / justSubmitted — those describe a filing of a DIFFERENT
  //     month; leaving them would show the new month as already submitted.
  // The old month's draft row is deliberately NOT deleted: it is real unfinished
  // work for that month, and it is offered back by the resume card.
  async function applyPeriod(next) {
    const reread = !!(file && aiMeta && AI_ENABLED && mode === "review");
    setPeriod(next);
    setPeriodTouched(true);
    setTimesheetRef(null);
    storedRef.current = null;
    setProcessError(""); setAttachWarn(""); setSavedMsg("");
    setJustSubmitted(false); setShowErrors(false); setSubmittedSig(null);
    setDayIdx(null);
    setBulkHours(String(STANDARD_DAY)); setBulkMsg(""); setBulkUndo(null);
    setDraftSavedAt(null); setResumedAt(null);
    if (mode !== "review") return;   // upload step: nothing built yet
    // Rebuild for the new month first, so the screen is never showing one
    // month's hours under another month's heading, even briefly.
    setCalendar(buildCalendar(null, next.month, next.year));
    setQ({ regularHours: "", overtimeHours: "", workedWeekends: "" });
    setHolidayWork({});
    aiBaseline.current = null;
    setAiMeta(null);
    setAiApproval(null);
    // Re-read the SAME file for the new month: no re-upload, and the employee
    // keeps their place. Only the AI path can do this; manual entry just gets a
    // fresh grid to type into.
    if (reread) await processAI(next);
  }

  // Free = there is nothing to lose: no extraction and no hours anywhere. The
  // confirmation only exists to protect work that actually exists.
  function periodChangeIsFree() {
    if (mode !== "review") return true;
    if (aiMeta) return false;
    return !calendar.some((c) => dayHours(c) > 0);
  }

  // A document was read and produced a calendar with no hours ANYWHERE. The
  // overwhelmingly likely cause is a period mismatch — the extractor clips every
  // entry to the selected month — and until now this rendered as a silently
  // blank grid. Detected here, explained in the review step.
  const emptyExtraction = mode === "review" && !!aiMeta && !processing &&
    calendar.length > 0 && !calendar.some((c) => dayHours(c) > 0);

  function requestPeriod(next) {
    if (!Number.isFinite(next.month) || !Number.isFinite(next.year)) return;
    if (next.month === month && next.year === year) return;
    if (processing || saving) return;
    if (periodChangeIsFree()) { applyPeriod(next); return; }
    setPendingPeriod(next);
  }

  // Point at the first thing that is actually missing. The submit button used to
  // be disabled whenever validation failed, which left an employee with a greyed
  // button, a prose banner, and no target to go and fix.
  function focusFirstProblem() {
    const blank = (v) => v === "" || v === null || v === undefined;
    // In page order, so the employee is sent to the FIRST thing to fix. Every id
    // here must exist in the markup: ts-employee-name is in the Details card
    // below; the other four are in Questionnaire.js (they carry these exact ids
    // for this function). A target that is legitimately absent — the whole
    // questionnaire is unmounted outside review mode — is skipped, and the
    // fallback is the validation banner.
    const targets = [
      ["ts-employee-name", !String(fields.employee_name || "").trim()],
      ["ts-regular-hours", blank(q.regularHours)],
      ["ts-overtime-hours", blank(q.overtimeHours)],
      ["ts-worked-weekends", blank(q.workedWeekends)],
      // The most common blocker of all, and the only one with no text box:
      // the approval question is unanswered until the box is ticked or the
      // detection stands. Same predicate validate.js blocks on — one source.
      ["ts-manager-approval", approvalErrors(q).length > 0],
    ];
    const hit = targets.find(([id, bad]) => bad && document.getElementById(id));
    const el = document.getElementById(hit ? hit[0] : "ts-validation-summary");
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
  }

  async function submit() {
    setShowErrors(true);
    // THE gate. Nothing below it may run while the timesheet is invalid — this
    // early return is the only thing between a click and an insert into the
    // append-only ts_employee_edits.
    if (!validation.ok) { focusFirstProblem(); return; }
    // Second gate: this exact timesheet is already filed. The DB trigger would
    // supersede the duplicate so nothing gets double-paid, but the row would
    // still be written and the admin would see a resubmission that isn't one.
    if (saving || alreadySubmitted) return;
    setSaving(true);
    setSavedMsg("");
    try {
      const tid = await ensureTimesheet();
      const r = rollup(calendar);
      const { error } = await api.from("ts_employee_edits").insert({
        timesheet_id: tid, user_id: uid, month, year,
        fields: { ...fields, totals: r,
                  flow: aiMeta?.flow || null, agent_trace: aiMeta?.agentTrace || null,
                  review_status: aiMeta?.reviewStatus || null,
                  // The receipt, not the claim: the server re-reads the verdict
                  // out of this and drops the two keys above if it doesn't
                  // verify. Not stored — it is an input, like `days`.
                  ai_stamp: aiMeta?.aiStamp || null,
                  // The compact approval record, so the admin list can show a
                  // column and build the chase-list without opening every
                  // questionnaire blob. Its own key, deliberately NOT inside
                  // `totals` — nothing approval-related may sit in the
                  // money-bearing object the server re-derives.
                  approval: approvalSummary({ ...q, holidayWork }) },
        days: calendar,
        questionnaire: { ...q, holidayWork },
        validation: { errors: validation.errors, warnings: validation.warnings },
        submitted: true,
      });
      if (error) throw error;
      // The submission is filed, so this is no longer a draft. Latch the
      // autosave off FIRST: a debounced write already in flight would otherwise
      // land after the clear below and re-offer a finished timesheet as
      // "unfinished" on the next visit. Set only after the insert succeeded —
      // a failed submit must leave the draft live and still saving.
      draftOff.current = true;
      draftUnsaved.current = false;
      // Keep ts_timesheets in sync with the latest edit. `days` is sent so the
      // server DERIVES the totals — previously this posted monthly_* directly
      // with no days, so those columns came straight from the browser.
      await api.from("ts_timesheets").update({
        days: calendar,
        questionnaire: { ...q, holidayWork },
        validation: { errors: validation.errors, warnings: validation.warnings },
        draft: null,   // finished: nothing left to resume
      }).eq("id", tid);
      setDraftSavedAt(null);
      setResumedAt(null);
      setSavedMsg("Timesheet submitted ✓  Your manager can now review it.");
      setJustSubmitted(true);
      // Freeze what was filed, so the still-visible review form reads
      // "Submitted" instead of offering a live Submit button.
      setSubmittedSig(currentSig);
      // The `submissions` prop comes from the server component and is otherwise
      // frozen at first mount, so the proof-of-submission banner never appeared
      // for a first-time submitter: "Start another" dropped them back on an
      // empty upload screen with no evidence anything happened. Re-render the
      // server component to pull the row we just inserted. Client state (the
      // calendar, the success modal) survives a refresh.
      router.refresh();
    } catch (e) {
      setProcessError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  }

  function resetForNew() {
    // "Start over" means this half-finished timesheet is being abandoned on
    // purpose — don't offer to resume it. Fire-and-forget: if the clear fails
    // the worst case is one stale resume card, which the employee can discard.
    discardDraft().catch(() => {});
    setMode("upload"); setFile(null); setPreviewPages([]); setShowPreview(false);
    dropPreviewDoc();
    storedRef.current = null;
    setCalendar([]); setQ({}); setHolidayWork({}); setAiMeta(null);
    // A detection belongs to ONE document. Carrying it into the next upload
    // would answer "yes, approved" using a signature from a different file.
    setAiApproval(null);
    aiBaseline.current = null;
    setProcessError(""); setSavedMsg(""); setTimesheetRef(null);
    setJustSubmitted(false); setShowErrors(false);
    setSubmittedSig(null);
    // never leave an undo snapshot of a DIFFERENT month's calendar behind
    setBulkHours(String(STANDARD_DAY)); setBulkMsg(""); setBulkUndo(null);
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
              {periodTouched ? (
                <>Period — <b>{periodLabel(month, year)}</b>.</>
              ) : (
                <>
                  Period auto-selected for you — <b>{periodLabel(month, year)}</b>.
                  {new Date().getDate() <= 10 && " (Within the grace window, so last month is shown.)"}
                </>
              )}{" "}
              {/* The auto-pick is a guess, and until now it was a locked-in one.
                  Say plainly that it can be changed, and that changing it does
                  not cost the upload. */}
              {mode === "review"
                ? (file && aiMeta && AI_ENABLED
                    ? "Wrong month? Change it here — your document is re-read for the new month, no re-upload."
                    : "Wrong month? Change it here and enter that month's hours.")
                : "Change it if you're filing a different month."}
            </p>
          </div>
          {/* Never disabled. Picking the wrong month is the single mistake the
              employee cannot see until the calendar appears, so the fix has to
              stay reachable at exactly that moment. requestPeriod() confirms
              first when there is work to lose. */}
          <div className="row" style={{ gap: 8 }}>
            <select aria-label="Timesheet month" value={month}
                    disabled={processing || saving}
                    onChange={(e) => requestPeriod({ ...period, month: +e.target.value })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select aria-label="Timesheet year" value={year}
                    disabled={processing || saving}
                    onChange={(e) => requestPeriod({ ...period, year: +e.target.value })}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* Re-reading after a period switch: the review form is still on screen
            with an empty grid, so without this it looks like the switch wiped
            the document for no reason. */}
        {processing && mode === "review" && (
          <div className="alert info" style={{ marginBottom: 16 }}>
            {/* .dark: the default spinner is a white ring sized for a primary
                button, and on --brand-soft it is all but invisible. */}
            <span className="spinner dark" /> Re-reading <b>{file?.name || "your document"}</b> for{" "}
            <b>{periodLabel(month, year)}</b>…
          </div>
        )}

        {/* alert-row: the one alert in the app that really is two boxes side by
            side — `margin-left: auto` only pushes the link to the far edge
            inside a flex container. */}
        {savedMsg && <div className="alert ok alert-row" style={{ marginBottom: 16 }}>{savedMsg}
          <a style={{ marginLeft: "auto", cursor: "pointer" }} onClick={resetForNew} role="button"
             tabIndex={0}
             onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && resetForNew()}>Start another</a></div>}

        {/* Proof of submission. Without this the dashboard is write-only: an
            employee who submits and comes back sees an empty upload screen with
            no sign anything happened — and no confirmation email exists yet. */}
        {currentSubmission && mode === "upload" && !justSubmitted && (
          /* "info" and not "": submitted-awaiting-review is the state this card
             spends the whole review window in, and an alert with no modifier
             used to be the one with no tint — the proof-of-submission card
             rendered as unboxed text. */
          <div className={"alert " + (currentSubmission.status === "approved" ? "ok"
                          : currentSubmission.status === "rejected" ? "error" : "info")}
               style={{ marginBottom: 16 }}>
            <b>
              {currentSubmission.status === "approved" ? "✓ Approved"
                : currentSubmission.status === "rejected" ? "✗ Sent back for correction"
                : "⏳ Submitted — awaiting review"}
            </b>{" "}
            for {MONTHS[month - 1]} {year} ·{" "}
            {currentSubmission.final_total ?? currentSubmission.fields?.totals?.total ?? "—"} hours
            {currentSubmission.final_total != null && (
              <span className="muted"> (adjusted by your admin)</span>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Submitted {new Date(currentSubmission.created_at).toLocaleDateString()}.
              {currentSubmission.review_note ? ` Note from your admin: “${currentSubmission.review_note}”` : ""}
              {currentSubmission.status !== "approved" &&
                " Uploading again will replace this submission."}
            </div>
          </div>
        )}

        {/* Unfinished work, offered back. The hours shown here are rolled up
            from the SAME `days` array resumeDraft() loads into the calendar, so
            the number on this card is the number you get when you click it. */}
        {mode === "upload" && savedDraft && (
          <div className="alert info" style={{ marginBottom: 16 }}>
            <b>You have an unfinished timesheet for {periodLabel(month, year)}.</b>
            <div style={{ marginTop: 4 }}>
              Saved {whenLabel(savedDraft.draft?.savedAt)} ·{" "}
              {rollup(savedDraft.days || []).total} hours across{" "}
              {rollup(savedDraft.days || []).daysWorked} day
              {rollup(savedDraft.days || []).daysWorked === 1 ? "" : "s"}
              {savedDraft.draft?.fileName ? ` · from ${savedDraft.draft.fileName}` : ""}.
              Pick up where you left off instead of uploading and re-processing.
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={resumeDraft}>
                Resume where I left off
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => discardDraft()}>
                Discard and start fresh
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Your hours, answers and corrections come back exactly as you left them.
              The side-by-side document preview does not — your file is still attached
              for your manager, but re-attach it here if you want to see it again.
            </div>
          </div>
        )}

        {/* Shown in BOTH steps: UploadStep renders processError itself, but a
            failure while submitting from the review step had no render site,
            so a failed submit used to show the user nothing at all. */}
        {attachWarn && <div className="alert warn" style={{ marginBottom: 16 }}>{attachWarn}</div>}
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
            submitError={processError}
            fields={fields} setField={setField} calendar={calendar} month={month} year={year}
            onDayClick={setDayIdx} validation={validation} totals={totals}
            q={q} setQ={setQ} holidays={holidays} holidayWork={holidayWork} setHolidayWork={setHolidayWork}
            aiMeta={aiMeta} approval={aiApproval}
            emptyExtraction={emptyExtraction} onSwitchPeriod={requestPeriod}
            saving={saving} submit={submit} showErrors={showErrors}
            alreadySubmitted={alreadySubmitted}
            onClearDayHours={clearDayHours} onRestoreAiHours={restoreAiHours}
            onSetDayHours={setDayHours} onEditDay={openDay}
            hoursOnDate={hoursOnDate} workedHoursOnDate={workedHoursOnDate}
            aiHoursOnDate={aiHoursOnDate}
            bulkHours={bulkHours} setBulkHours={setBulkHours}
            emptyWeekdayCount={emptyWeekdayCount}
            onFillWeekdays={fillWeekdays} onUndoFill={undoFill}
            canUndoFill={!!bulkUndo} bulkMsg={bulkMsg}
            showPreview={showPreview && (previewPages.length > 0 || !!previewDoc)}
            previewPages={previewPages} previewDoc={previewDoc} previewLoading={previewLoading}
            fileName={file?.name} togglePreview={() => setShowPreview((s) => !s)}
            resetForNew={resetForNew}
            resumedAt={resumedAt} draftSavedAt={draftSavedAt}
            draftSaving={draftSaving} draftError={draftError}
          />
        )}
      </div>

      {pendingPeriod && (
        <PeriodSwitch
          from={periodLabel(month, year)}
          to={periodLabel(pendingPeriod.month, pendingPeriod.year)}
          willReread={!!(file && aiMeta && AI_ENABLED)}
          hours={rollup(calendar).total}
          onCancel={() => setPendingPeriod(null)}
          onConfirm={() => { const p = pendingPeriod; setPendingPeriod(null); applyPeriod(p); }}
        />
      )}

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

// ---------------- period switch confirmation ----------------
// Switching months rebuilds the grid, so it is stated in full before it happens
// rather than being prevented outright. The hours figure is rollup()'s, i.e. the
// same number the server would derive — so what the employee is told they are
// clearing is exactly what is on the screen.
function PeriodSwitch({ from, to, willReread, hours, onCancel, onConfirm }) {
  const dialogRef = useDialogKeys(onCancel);
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" ref={dialogRef} onClick={(e) => e.stopPropagation()} role="dialog"
           aria-modal="true" aria-label={`Switch from ${from} to ${to}`}>
        {/* .modal itself has no padding — it is only the card. Content must sit
            inside .modal-head/.modal-body or it renders flush against the card
            edges and the buttons spill past the bottom corner. */}
        <div className="modal-head">
          <h2 style={{ margin: 0, fontSize: 17 }}>Switch to {to}?</h2>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ margin: "0 0 10px" }}>
            Hours are recorded per day, so the {from} calendar can’t move to {to}.
            {hours > 0
              ? ` The ${hours} hour${hours === 1 ? "" : "s"} currently on the ${from} grid will be cleared.`
              : " The current grid will be cleared."}
          </p>
          <p className="muted" style={{ margin: "0 0 18px" }}>
            {willReread
              ? "Your uploaded document will be read again for " + to +
                " — you don’t need to upload it a second time."
              : "You’ll get an empty " + to + " calendar to fill in."}{" "}
            Nothing has been submitted, and {from} keeps whatever you had saved for it.
          </p>
          <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
            <button className="btn btn-ghost" onClick={onCancel}>Stay on {from}</button>
            <button className="btn btn-primary" onClick={onConfirm} autoFocus>
              {willReread ? `Switch and re-read` : `Switch to ${to}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The month the document's clipped-away entries actually belonged to, when the
// extractor reported one. Only ever a SUGGESTION for a button the employee
// presses; nothing acts on it automatically, and no total is derived from it.
function offMonthSuggestion(aiMeta) {
  const top = (aiMeta?.offMonth || [])[0];   // extractor sorts by count desc
  if (!top || !top.count) return null;
  return parsePeriodKey(top.period);
}

// "YYYY-MM" -> { month, year }; null for anything else, so a malformed key from
// the extractor can only mean "no suggestion", never a wrong suggestion.
function parsePeriodKey(k) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(k || ""));
  if (!m) return null;
  const month = +m[2];
  if (month < 1 || month > 12) return null;
  return { month, year: +m[1] };
}

// "12 minutes ago" for anything recent, an absolute date once it stops being
// useful. Rendered client-side only (the resume card lives behind a fetch), so
// there is no server/client clock mismatch to hydrate around.
function whenLabel(iso) {
  if (!iso) return "earlier";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "earlier";
  const mins = Math.floor((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return t.toLocaleString();
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
        {/* Derived from the SAME allowlist the upload route enforces. The old
            literal led with `image/*`, which let the picker offer .bmp/.tif —
            formats nothing here renders and the uploader rejects. */}
        <input ref={fileInput} type="file" hidden
          accept={ACCEPT_ATTR}
          onChange={(e) => onPickFile(e.target.files?.[0])} />
        <div style={{ fontSize: 30 }}>📄</div>
        <div style={{ fontWeight: 600, marginTop: 6 }}>
          {file ? file.name : aiEnabled ? "Drop a file or click to browse" : "Attach your timesheet (optional)"}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          PDF, scanned PDF, Excel, CSV, Word, or a photo — up to {MAX_UPLOAD_MB} MB
        </div>
      </div>

      {processError && <div className="alert error" style={{ marginTop: 14 }}>{processError}</div>}

      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        {/* onClick is WRAPPED, not passed bare: processAI's first argument is
            the period to read the document for, and a bare handler would hand
            it the click event — extracting against `undefined` month/year. */}
        {aiEnabled && (
          <button className="btn btn-primary" disabled={!file || processing}
                  onClick={() => processAI()}>
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
        <PreviewPane pages={previewPages} doc={previewDoc} loading={previewLoading}
                     fileName={file.name} file={file} />
      </div>
    );
  }
  return <div className="stack" style={{ maxWidth: 640 }}>{card}</div>;
}

// ---------------- review step ----------------
function ReviewStep({
  fields, setField, calendar, month, year, onDayClick, validation, totals,
  q, setQ, holidays, holidayWork, setHolidayWork, aiMeta, approval, saving, submit,
  emptyExtraction, onSwitchPeriod,
  showPreview, previewPages, previewDoc, previewLoading, fileName, togglePreview, resetForNew,
  submitError, showErrors, alreadySubmitted,
  onClearDayHours, onRestoreAiHours, onSetDayHours, onEditDay,
  hoursOnDate, workedHoursOnDate, aiHoursOnDate,
  bulkHours, setBulkHours, emptyWeekdayCount, onFillWeekdays, onUndoFill, canUndoFill, bulkMsg,
  resumedAt, draftSavedAt, draftSaving, draftError,
}) {
  const nameMissing = !String(fields.employee_name || "").trim();
  const left = (
    <div className="stack">
      {resumedAt && (
        <div className="alert info">
          ↩ Picked up your saved draft from {new Date(resumedAt).toLocaleString()}.
          Nothing has been submitted yet — check it over and submit when you're ready.
        </div>
      )}

      {aiMeta && (
        <div className="alert info">
          ✨ AI populated this from <b>{aiMeta.fileName}</b>
          {aiMeta.confidence != null && <> · confidence {Math.round(aiMeta.confidence * 100)}%</>}
          {aiMeta.llm_used ? " · LLM used" : ""}. Review and correct anything below.
        </div>
      )}

      {/* An empty calendar after a successful read is almost always the wrong
          month. It used to render as a blank grid with no explanation at all —
          the hours "disappeared" and the only visible way out was Start over,
          which discards the extraction. Name the cause, and where the extractor
          told us which month the entries really were, offer the switch. */}
      {emptyExtraction && (
        <div className="alert error"
             id="ts-empty-extraction" tabIndex={-1}>
          <b>⚠ No hours were found for {periodLabel(month, year)}.</b>
          <div style={{ marginTop: 6 }}>
            {offMonthSuggestion(aiMeta)
              ? <>Every entry in <b>{aiMeta.fileName}</b> is dated in{" "}
                  <b>{periodLabel(offMonthSuggestion(aiMeta).month,
                                  offMonthSuggestion(aiMeta).year)}</b>, not{" "}
                  {periodLabel(month, year)} — so this calendar is empty. It looks
                  like the period at the top of the page is set to the wrong month.</>
              : <>Nothing in <b>{aiMeta?.fileName || "your document"}</b> is dated
                  inside {periodLabel(month, year)}, so this calendar is empty.
                  The usual cause is the period at the top of the page being set
                  to the wrong month.</>}
          </div>
          {offMonthSuggestion(aiMeta) && (
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="btn btn-primary btn-sm"
                      onClick={() => onSwitchPeriod(offMonthSuggestion(aiMeta))}>
                Switch to {periodLabel(offMonthSuggestion(aiMeta).month,
                                       offMonthSuggestion(aiMeta).year)} and re-read
              </button>
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            You can also pick the month yourself at the top of the page — your
            file is read again automatically, so you never have to upload it
            twice. If {periodLabel(month, year)} really is the right month, just
            enter your hours below.
          </div>
        </div>
      )}

      {/* The extraction's OWN doubts. These were computed and then discarded —
          e.g. "verification DISAGREED: primary 168h vs re-read 140h", or the
          document's printed total not matching the days. The employee is the
          only person who can resolve them, so they belong here. */}
      {aiMeta && (aiMeta.issues?.length > 0 || aiMeta.reviewStatus === "blocked" ||
                  aiMeta.reviewStatus === "needs_review") && (
        <div className="alert warn">
          <b>⚠ The AI wasn’t fully sure about this document — please check these:</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {(aiMeta.issues || []).map((it, i) => (
              <li key={i}>{it.message || it.code}</li>
            ))}
            {!aiMeta.issues?.length && <li>Its own verification flagged this read for review.</li>}
          </ul>
          {aiMeta.notes?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                What the AI did ({aiMeta.notes.length} step{aiMeta.notes.length > 1 ? "s" : ""})
              </summary>
              <ul className="muted" style={{ fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
                {aiMeta.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* validation banner */}
      {validation.errors.length > 0 ? (
        <div className="alert error" id="ts-validation-summary" tabIndex={-1}
             data-scroll-target="">
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
        {/* counted the same way the server counts days_worked (regular +
            overtime + other), not off the day's stored `total` */}
        <div className="tile"><div className="v">{calendar.filter((c) => dayHours(c) > 0).length}</div><div className="l">Days worked</div></div>
      </div>

      {/* identity fields */}
      <div className="card card-pad">
        <h3 className="card-title">Details {aiMeta ? "(AI-filled — edit if wrong)" : ""}</h3>
        <p className="req-note"><span className="req">*</span> Required before you can submit</p>
        <div className="grid-2">
          <Field label="Employee name" required htmlFor="ts-employee-name"
                 invalid={showErrors && nameMissing}>
            <input id="ts-employee-name" value={fields.employee_name}
                   onChange={setField("employee_name")}
                   aria-required="true" aria-invalid={showErrors && nameMissing ? "true" : undefined} />
          </Field>
          <Field label="Employee ID / code" htmlFor="ts-employee-id">
            <input id="ts-employee-id" value={fields.employee_id} onChange={setField("employee_id")} />
          </Field>
          {/* validate.js treats an empty client as a WARNING, not an error, so it
              must NOT carry the same asterisk as a blocking field — otherwise
              the marker stops meaning "you cannot submit without this". */}
          <Field label="Client / placement" htmlFor="ts-client">
            <input id="ts-client" value={fields.client} onChange={setField("client")} />
            <span className="hint">Recommended — your admin uses this to match the placement.</span>
          </Field>
          <Field label="Project" htmlFor="ts-project">
            <input id="ts-project" value={fields.project} onChange={setField("project")} />
          </Field>
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
        <QuickFill
          hours={bulkHours} setHours={setBulkHours} emptyCount={emptyWeekdayCount}
          onFill={onFillWeekdays} onUndo={onUndoFill} canUndo={canUndoFill} msg={bulkMsg}
        />
        <Legend />
        <Calendar calendar={calendar} month={month} year={year} onDayClick={onDayClick} />
      </div>

      {/* questionnaire */}
      {/* EVERY prop below is named in the PROPS CONTRACT at the top of
          Questionnaire.js, and that list names nothing else. Passing a name
          that isn't in it does NOT fail — React just applies the component's
          own default — so a renamed prop silently disables the feature it was
          meant to drive. Two of these have already shipped broken that way:
            onClearDayHours / onSetDayHours  the holiday Worked / Not-worked
                         toggles edit `calendar`, which is owned here. Without
                         both, "Not worked" leaves the hours in `days` (the day
                         reads "not worked" and is still paid) and "Worked"
                         never offers an hours box.
            approval     seeds the manager-approval card. Without it the card is
                         stuck in its "no document was read" branch and the only
                         way past validation is the "this timesheet has NOT been
                         approved" checkbox — which every employee then ticks,
                         signed documents included. */}
      <Questionnaire q={q} setQ={setQ} holidays={holidays} holidayWork={holidayWork}
        setHolidayWork={setHolidayWork} calendar={calendar} totals={totals}
        approval={approval}
        showErrors={showErrors}
        onClearDayHours={onClearDayHours}
        onRestoreAiHours={onRestoreAiHours}
        onSetDayHours={onSetDayHours}
        onEditDay={onEditDay}
        hoursOnDate={hoursOnDate}
        workedHoursOnDate={workedHoursOnDate}
        aiHoursOnDate={aiHoursOnDate} />

      {/* submit */}
      <div className="card card-pad between">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 13 }} id="ts-submit-status">
            {submitError
              ? <span style={{ color: "var(--red)" }}><b>Couldn’t submit:</b> {submitError}</span>
              : alreadySubmitted
                ? <span><b>✓ Submitted.</b> Your manager can now review it. Change anything above to send a correction.</span>
                : validation.ok ? "Everything checks out." : "Resolve the errors above before submitting."}
          </div>
          {/* Autosave status. Saying nothing was the old behaviour and it is
              precisely what made a lost session so expensive: the employee had
              no reason to believe anything was kept. */}
          {!alreadySubmitted && (
            <div style={{ fontSize: 12, marginTop: 4 }}
                 className={draftError ? "" : "muted"} aria-live="polite">
              {draftError
                ? <span style={{ color: "var(--amber)" }}>
                    ⚠ Draft not saved ({draftError}). Keep this page open until it saves.
                  </span>
                : draftSaving ? "Saving draft…"
                : draftSavedAt
                  ? `Draft saved ${new Date(draftSavedAt).toLocaleTimeString()} — you can close this page and come back.`
                  : "Your work is saved automatically as you go."}
            </div>
          )}
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={resetForNew}>Start over</button>
          {/* Enabled even when invalid, ON PURPOSE: pressing it now marks the
              required fields and jumps to the first one instead of leaving a
              dead grey button. submit() still refuses to write anything unless
              validation.ok — the guard is the gate, not the disabled attribute.
              The ONE case it is greyed out is `alreadySubmitted`: this exact
              timesheet is already filed, so there is nothing left to press. Edit
              any hour or field and it becomes live again for a correction. */}
          <button className="btn btn-primary" disabled={saving || alreadySubmitted} onClick={submit}
            aria-describedby="ts-submit-status">
            {saving ? <><span className="spinner" /> Submitting…</>
              : alreadySubmitted ? "Submitted ✓" : "Submit timesheet"}
          </button>
        </div>
      </div>
    </div>
  );

  if (showPreview) {
    // On a phone .split collapses to one column, which used to push the source
    // document ~2000px BELOW the form — so "check the AI against your document",
    // the loop this product exists for, was impossible on mobile. The preview
    // is a dismissible sheet there instead, so it overlays the day you're on.
    return (
      <>
        {/* split-review: from 1100px up this becomes a pinned two-pane
            workspace — the form column scrolls inside its own box so the page
            stops growing downward and the document stays beside it. Below that
            it is a plain .split (sticky preview), and at <=900px a single
            column plus the bottom sheet. All of it is in globals.css. */}
        <div className="split split-review">
          {left}
          <div className="preview-side">
            <PreviewPane pages={previewPages} doc={previewDoc} loading={previewLoading}
                         fileName={fileName} onClose={togglePreview} />
          </div>
        </div>
        <div className="preview-sheet" role="dialog" aria-label="Your uploaded document">
          <PreviewPane pages={previewPages} doc={previewDoc} loading={previewLoading}
                       fileName={fileName} onClose={togglePreview} />
        </div>
      </>
    );
  }
  return left;
}

// ---------------- submitted! ----------------
function SubmitSuccess({ period, totals, onClose, onNew }) {
  const dialogRef = useDialogKeys(onClose);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal success-card" ref={dialogRef} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label="Timesheet submitted">
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
          only if something needs a correction. If something needs changing before
          then, submit the month again and your new version replaces this one.
        </p>
        <div className="row" style={{ justifyContent: "center", gap: 10 }}>
          <button className="btn btn-ghost" onClick={onNew}>Start another month</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// The asterisk is aria-hidden because the input itself carries aria-required —
// a screen reader should hear "required", not "star".
function Field({ label, required, invalid, htmlFor, children }) {
  return (
    <div className={"field" + (invalid ? " invalid" : "")}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req" aria-hidden="true">*</span>}
      </label>
      {children}
    </div>
  );
}
// One-click "I worked a normal month". Without it, a manual-entry employee has
// to open, type into and save every single weekday before the calendar stops
// showing them as missing — the reason this exists.
//
// It only ever offers to fill days that have NOTHING on them (the amber ones),
// so it can never overwrite an AI reading, an earlier edit, or an explicit 0.
// It disappears once there is nothing left to fill, so it cannot be mistaken
// for a control that changes days you already entered.
function QuickFill({ hours, setHours, emptyCount, onFill, onUndo, canUndo, msg }) {
  if (emptyCount <= 0 && !msg) return null;
  return (
    <div className="quickfill">
      {emptyCount > 0 && (
        <>
          <label htmlFor="ts-bulk-hours">Worked a standard day?</label>
          <input id="ts-bulk-hours" type="number" step="0.25" min="0" max="24"
                 value={hours} onChange={(e) => setHours(e.target.value)}
                 aria-label="Hours per weekday" />
          <span className="qf-unit">h per weekday</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onFill}>
            Fill {emptyCount} empty weekday{emptyCount > 1 ? "s" : ""}
          </button>
        </>
      )}
      {canUndo && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onUndo}>Undo</button>
      )}
      {/* aria-live: the change happens in the grid below, so the outcome has to
          be announced or a screen-reader user gets no feedback at all. */}
      <span className="qf-msg" role="status" aria-live="polite">
        {msg || (emptyCount > 0
          ? "Weekends and holidays are left alone — answer those below."
          : "")}
      </span>
    </div>
  );
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function Legend() {
  return (
    <div className="legend">
      <span><i className="swatch" style={{ background: "var(--surface)" }} /> Worked</span>
      <span><i className="swatch" style={{ background: "var(--surface-2)" }} /> Weekend</span>
      <span><i className="swatch" style={{ background: "var(--purple-soft)", borderColor: "#d8b4fe" }} /> Holiday</span>
      {/* informational, not a problem — worded neutrally for that reason */}
      <span><i className="swatch" style={{ background: "var(--short-soft)", borderColor: "var(--short-line)" }} /> Under {STANDARD_DAY}h</span>
      <span><i className="swatch" style={{ background: "#fffbeb", borderColor: "#fbbf24" }} /> Missing</span>
      <span><i className="swatch" style={{ background: "var(--surface)", borderColor: "var(--red)" }} /> Flagged</span>
    </div>
  );
}
