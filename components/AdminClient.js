"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import Calendar from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import { createClient } from "@/lib/api/client";
import { periodLabel } from "@/lib/month";
import { rollup } from "@/lib/engine";

export default function AdminClient({ profile, profiles, edits, files, adminEdits }) {
  const api = createClient();
  const router = useRouter();
  const pmap = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const [tab, setTab] = useState("submissions");
  const [detail, setDetail] = useState(null);
  const [triage, setTriage] = useState("all");

  // ----- month/period selector -----
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  // periods that actually have data, newest first; default to the one with the
  // most submissions so the console opens on the month that matters.
  const periods = useMemo(() => {
    const m = {};
    const bump = (x) => {
      if (x.month == null || x.year == null) return;
      const k = `${x.year}-${x.month}`;
      m[k] = m[k] || { key: k, year: x.year, month: x.month, n: 0 };
    };
    files.forEach(bump); adminEdits.forEach(bump); edits.forEach(bump);
    edits.forEach((e) => { const k = `${e.year}-${e.month}`; if (m[k]) m[k].n++; });
    return Object.values(m).sort((a, b) => (b.year - a.year) || (b.month - a.month));
  }, [edits, files, adminEdits]);
  const defaultPeriod = useMemo(
    () => ([...periods].sort((a, b) => b.n - a.n)[0]?.key || "all"), [periods]);
  const [period, setPeriod] = useState(defaultPeriod);
  const label = (p) => `${MONTHS[p.month - 1]} ${p.year}`;

  const inPeriod = (x) => period === "all" || `${x.year}-${x.month}` === period;
  const pEdits = edits.filter(inPeriod);
  const pFiles = files.filter(inPeriod);
  const pAdminEdits = adminEdits.filter(inPeriod);

  // Superseded rows are history: a resubmission replaced them. Excluding them is
  // what stops one employee's correction from double-counting the month.
  const current = pEdits.filter((e) => e.status !== "superseded");

  // THE numbers of record: an admin correction (final_*) wins over what the
  // employee submitted. This is what the export pays and what the tiles show.
  const payroll = (e) => ({
    regular: e.final_regular ?? e.fields?.totals?.regular ?? 0,
    overtime: e.final_overtime ?? e.fields?.totals?.overtime ?? 0,
    total: e.final_total ?? e.fields?.totals?.total ?? 0,
    corrected: e.final_total != null,
  });

  const totalHours = current.reduce((a, e) => a + Number(payroll(e).total || 0), 0);
  const flagged = current.filter((e) => (e.validation?.errors?.length || 0) > 0).length;
  const awaiting = current.filter((e) => (e.status || "submitted") === "submitted").length;

  // Who hasn't submitted for this period — the actual month-end chase list.
  const notSubmitted = useMemo(() => {
    if (period === "all") return [];
    const done = new Set(current.map((e) => e.user_id));
    return profiles.filter((p) => p.role !== "admin" && !done.has(p.id));
  }, [profiles, current, period]);

  const STATUS_BADGE = {
    submitted: ["amber", "awaiting review"],
    approved: ["green", "approved"],
    rejected: ["red", "rejected"],
    superseded: ["gray", "superseded"],
  };

  // Triage bucket for a submission: prefer the engine's review_status; fall back
  // to the stored validation (older submissions predate review_status).
  const reviewOf = (e) => {
    const rs = e.fields?.review_status;
    if (rs === "auto_accepted" || rs === "needs_review" || rs === "blocked") return rs;
    return (e.validation?.errors?.length || 0) > 0 ? "blocked"
      : (e.validation?.warnings?.length || 0) > 0 ? "needs_review" : "needs_review";
  };
  const counts = { auto_accepted: 0, needs_review: 0, blocked: 0 };
  pEdits.forEach((e) => { counts[reviewOf(e)]++; });
  const shownEdits = triage === "all" ? pEdits : pEdits.filter((e) => reviewOf(e) === triage);

  return (
    <>
      <Topbar profile={profile} active="admin" />
      <div className="container" style={{ padding: "22px 24px 60px" }}>
        <div className="between" style={{ flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
          <div>
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>Admin console</h1>
            <p className="muted">Review employee submissions, audit edits, and make corrections.</p>
          </div>
          {periods.length > 0 && (
            <div className="field" style={{ margin: 0, minWidth: 190 }}>
              <label>Month</label>
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                {periods.map((p) => (
                  <option key={p.key} value={p.key}>{label(p)} ({p.n})</option>
                ))}
                <option value="all">All months ({edits.length})</option>
              </select>
            </div>
          )}
        </div>

        <div className="tiles" style={{ margin: "14px 0 20px" }}>
          <div className="tile"><div className="v">{new Set(current.map((e) => e.user_id)).size}</div><div className="l">Employees this month</div></div>
          <div className="tile"><div className="v" style={{ color: awaiting ? "var(--amber)" : "var(--green)" }}>{awaiting}</div><div className="l">Awaiting review</div></div>
          <div className="tile tot"><div className="v">{Math.round(totalHours)}</div><div className="l">Total hours</div></div>
          <div className="tile"><div className="v" style={{ color: notSubmitted.length ? "var(--red)" : "var(--green)" }}>{notSubmitted.length}</div><div className="l">Not submitted</div></div>
        </div>

        {/* Month-end chase list: who still owes you a timesheet. */}
        {period !== "all" && notSubmitted.length > 0 && (
          <div className="card card-pad" style={{ marginBottom: 20 }}>
            <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
              <h3 className="card-title" style={{ marginBottom: 0 }}>
                Not submitted yet ({notSubmitted.length})
              </h3>
              <span className="muted" style={{ fontSize: 12 }}>
                Employees with no timesheet for this period.
              </span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {notSubmitted.map((p) => (
                <a key={p.id} href={`mailto:${p.email}?subject=${encodeURIComponent("Timesheet reminder")}`}
                   className="badge gray" style={{ textDecoration: "none" }}
                   title={`Email ${p.email}`}>
                  {p.full_name || p.email}
                </a>
              ))}
            </div>
          </div>
        )}

        {period !== "all" && (
          <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <a className="btn btn-primary btn-sm"
               href={`/api/admin/export?year=${period.split("-")[0]}&month=${period.split("-")[1]}`}>
              ⬇ Export approved for payroll (CSV)
            </a>
            <a className="btn btn-ghost btn-sm"
               href={`/api/admin/export?year=${period.split("-")[0]}&month=${period.split("-")[1]}&all=1`}>
              Export all submissions
            </a>
          </div>
        )}

        <div className="tabs">
          {[["submissions", "Submissions"], ["employees", "Employees"], ["files", "Files"], ["revisions", "Admin revisions"]].map(([k, label]) => (
            <div key={k} className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
              {label}
              {k === "revisions" && pAdminEdits.length > 0 && <span className="badge gray" style={{ marginLeft: 6 }}>{pAdminEdits.length}</span>}
            </div>
          ))}
        </div>

        {tab === "submissions" && (
          <>
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {[["all", "All", edits.length, "gray"],
              ["blocked", "🔴 Blocked", counts.blocked, "red"],
              ["needs_review", "🟡 Needs review", counts.needs_review, "amber"],
              ["auto_accepted", "✅ Clean", counts.auto_accepted, "green"]].map(([k, label, n, color]) => (
              <button key={k} onClick={() => setTriage(k)}
                className="btn btn-sm"
                style={{
                  border: triage === k ? "2px solid var(--brand)" : "1px solid var(--line-strong)",
                  background: triage === k ? "var(--brand-soft)" : "var(--surface)", color: "var(--txt)",
                }}>
                {label} <span className={"badge " + color} style={{ marginLeft: 4 }}>{n}</span>
              </button>
            ))}
          </div>
          <Table headers={["Employee", "Client", "Period", "Regular", "OT", "Total", "Review", "Checks", "Submitted", ""]}>
            {shownEdits.length === 0 && <Empty cols={10} text="No submissions in this bucket." />}
            {shownEdits.map((e) => {
              const p = pmap[e.user_id] || {};
              const t = payroll(e);
              const sb = STATUS_BADGE[e.status || "submitted"] || STATUS_BADGE.submitted;
              const errs = e.validation?.errors?.length || 0;
              const rv = reviewOf(e);
              const rvBadge = rv === "auto_accepted" ? ["green", "clean"]
                : rv === "blocked" ? ["red", "blocked"] : ["amber", "review"];
              return (
                <tr key={e.id}>
                  <td><b>{p.full_name || e.fields?.employee_name || "—"}</b><br /><span className="muted" style={{ fontSize: 12 }}>{p.email}</span></td>
                  <td>{e.fields?.client || p.client || "—"}</td>
                  <td>{periodLabel(e.month, e.year)}</td>
                  <td>{t.regular}</td>
                  <td>{t.overtime}</td>
                  <td>
                    <b>{t.total}</b>
                    {t.corrected && <span className="badge purple" style={{ marginLeft: 6 }} title="Admin-corrected — this is the figure payroll uses">corrected</span>}
                  </td>
                  <td>
                    <span className={"badge " + sb[0]}>{sb[1]}</span>
                    {" "}<span className={"badge " + rvBadge[0]} title="AI confidence">{rvBadge[1]}</span>
                  </td>
                  <td>{errs > 0 ? <span className="badge red">{errs} error{errs > 1 ? "s" : ""}</span> : <span className="badge green">clean</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{fmt(e.created_at)}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setDetail(e)}>Review</button></td>
                </tr>
              );
            })}
          </Table>
          </>
        )}

        {tab === "employees" && (
          <Table headers={["Name", "Email", "Role", "Employer", "Client", "Job title", "Manager"]}>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td><b>{p.full_name || "—"}</b></td>
                <td>{p.email}</td>
                <td>{p.role === "admin" ? <span className="badge purple">admin</span> : <span className="badge gray">employee</span>}</td>
                <td>{p.employer || "—"}</td>
                <td>{p.client || "—"}</td>
                <td>{p.job_title || "—"}</td>
                <td>{p.manager_name || "—"}</td>
              </tr>
            ))}
          </Table>
        )}

        {tab === "files" && (
          <Table headers={["Employee", "File", "Period", "Type", "Size", "Uploaded", ""]}>
            {pFiles.length === 0 && <Empty cols={7} text="No files for this month." />}
            {pFiles.map((f) => {
              const p = pmap[f.user_id] || {};
              return (
                <tr key={f.id}>
                  <td>{p.full_name || "—"}</td>
                  <td>{f.file_name}</td>
                  <td>{periodLabel(f.month, f.year)}</td>
                  <td className="muted">{f.mime_type || "—"}</td>
                  <td className="muted">{f.size_bytes ? Math.round(f.size_bytes / 1024) + " KB" : "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{fmt(f.created_at)}</td>
                  <td><DownloadBtn api={api} path={f.storage_path} /></td>
                </tr>
              );
            })}
          </Table>
        )}

        {tab === "revisions" && (
          <Table headers={["Employee", "Period", "Edited by admin", "Note", "When"]}>
            {pAdminEdits.length === 0 && <Empty cols={5} text="No admin revisions for this month." />}
            {pAdminEdits.map((a) => {
              const p = pmap[a.employee_user_id] || {};
              const ad = pmap[a.admin_user_id] || {};
              return (
                <tr key={a.id}>
                  <td><b>{p.full_name || "—"}</b></td>
                  <td>{periodLabel(a.month, a.year)}</td>
                  <td>{ad.full_name || "admin"}</td>
                  <td>{a.note || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{fmt(a.created_at)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </div>

      {detail && (
        <SubmissionDetail
          edit={detail} profile={pmap[detail.user_id] || {}} adminProfile={profile}
          sourceFile={files.find((f) => f.user_id === detail.user_id
            && f.month === detail.month && f.year === detail.year)}
          api={api} onClose={() => setDetail(null)}
          onSaved={() => { setDetail(null); router.refresh(); }}
        />
      )}
    </>
  );
}

function SubmissionDetail({ edit, profile, adminProfile, sourceFile, api, onClose, onSaved }) {
  // `days` is the heavy part of a submission (one entry per calendar day), so
  // the list query no longer carries it. Fetch it for just this submission.
  const [days, setDays] = useState(edit.days || []);
  const [loadingDays, setLoadingDays] = useState(!edit.days);
  useEffect(() => {
    if (edit.days) return;
    let alive = true;
    api.from("ts_employee_edits").select("days,questionnaire").eq("id", edit.id).single()
      .then(({ data }) => {
        if (!alive) return;
        setDays(data?.days || []);
        setLoadingDays(false);
      });
    return () => { alive = false; };
  }, [edit.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dayIdx, setDayIdx] = useState(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [preview, setPreview] = useState(false);
  // Some documents only provide SUMMARY totals (weekly rows / a stated month
  // total) with no per-day breakdown -- their day grid is empty, so recomputing
  // from days would wrongly show 0. Fall back to the totals stored at
  // extraction time, and never clobber them with zeros on an admin save.
  const dayR = rollup(days);
  const stored = edit.fields?.totals || {};
  const summaryOnly = dayR.total === 0 && Number(stored.total) > 0;
  const r = summaryOnly
    ? {
        regular: stored.regular ?? stored.total ?? 0,
        overtime: stored.overtime ?? 0,
        total: stored.total ?? 0,
        daysWorked: stored.daysWorked ?? stored.days_worked ?? "—",
      }
    : dayR;
  const q = edit.questionnaire || {};

  async function saveAdminEdit() {
    setSaving(true);
    const { error } = await api.from("ts_admin_edits").insert({
      timesheet_id: edit.timesheet_id, employee_user_id: edit.user_id,
      admin_user_id: adminProfile.id, month: edit.month, year: edit.year,
      fields: { ...(edit.fields || {}), totals: r }, days,
      questionnaire: q, validation: edit.validation || {}, note: note || null,
    });
    if (error) { setSaving(false); setSaveErr(error.message || "couldn't save this revision"); return; }

    // Writing the revision is not enough: without this the submissions table and
    // the payroll export would keep reporting the employee's uncorrected hours.
    // Promote the corrected totals to the numbers of record on the submission.
    const res = await fetch("/api/admin/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editId: edit.id, note: note || null,
                             finals: { regular: r.regular, overtime: r.overtime, total: r.total } }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSaveErr(j.error || "revision saved, but the payroll total wasn't updated");
      return;
    }
    setSaveErr("");
    setSaved(true);
    setTimeout(() => (onSaved ? onSaved() : onClose()), 900);
  }

  // Approve / reject / reopen — the review decision itself.
  async function setStatus(status) {
    setSaving(true); setSaveErr("");
    const res = await fetch("/api/admin/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editId: edit.id, status, note: note || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSaveErr(j.error || "couldn't update the review status");
      return;
    }
    onSaved ? onSaved() : onClose();
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={"modal " + (preview && sourceFile ? "modal-split" : "wide")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 16 }}>{profile.full_name || edit.fields?.employee_name} · {periodLabel(edit.month, edit.year)}</h3>
            <div className="muted" style={{ fontSize: 12 }}>{profile.email} · {edit.fields?.client || profile.client || "—"}</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {sourceFile && (
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview((p) => !p)} title="Verify against the original document">
                {preview ? "Hide document" : "📄 Preview document"}
              </button>
            )}
            <button className="x" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="modal-cols">
        <div className="modal-body">
          <div className="tiles" style={{ marginBottom: 16 }}>
            <div className="tile reg"><div className="v">{r.regular}</div><div className="l">Regular</div></div>
            <div className="tile ot"><div className="v">{r.overtime}</div><div className="l">Overtime</div></div>
            <div className="tile tot"><div className="v">{r.total}</div><div className="l">Total</div></div>
            <div className="tile"><div className="v">{r.daysWorked}</div><div className="l">Days worked</div></div>
          </div>

          {summaryOnly && (
            <div className="alert info" style={{ marginBottom: 14 }}>
              This document only provided <b>summary totals</b> (weekly rows or a
              stated month total) — there is no per-day breakdown, so the calendar
              below is empty. The totals above come from the document’s summary.
              Use “Preview document” to verify against the original.
            </div>
          )}

          {(edit.validation?.errors?.length > 0) && (
            <div className="alert error" style={{ marginBottom: 14 }}>
              Employee submitted with {edit.validation.errors.length} unresolved error(s).
            </div>
          )}

          <h3 className="card-title">Questionnaire answers</h3>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <KV k="Regular (stated)" v={q.regularHours} />
            <KV k="Overtime (stated)" v={q.overtimeHours} />
            <KV k="Worked weekends" v={q.workedWeekends} />
            <KV k="Holidays taken" v={q.holidaysTaken} />
            <KV k="Holidays paid" v={q.holidaysPaid} />
            <KV k="PTO days" v={q.ptoDays} />
          </div>
          {q.notes && <div className="alert info" style={{ marginBottom: 16 }}>“{q.notes}”</div>}

          <AgentTrace trace={edit.fields?.agent_trace} flow={edit.fields?.flow} />

          <h3 className="card-title">Calendar — click a day to correct as admin</h3>
          <Calendar calendar={days} month={edit.month} year={edit.year} onDayClick={setDayIdx} />

          <div className="field" style={{ marginTop: 16 }}>
            <label>Admin note (why you changed it)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Corrected Apr 14 — client confirmed 8h" />
          </div>
          {saveErr && <div className="alert error" style={{ margin: "10px 0" }}>{saveErr}</div>}
          <div className="between">
            <span className="muted" style={{ fontSize: 12 }}>Saved as a separate admin revision; the employee’s submission is preserved.</span>
            <div className="row">
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
              <button className="btn btn-ghost" disabled={saving} onClick={() => setStatus("rejected")}
                      style={{ color: "var(--red)" }} title="Send back to the employee to resubmit">
                Reject
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={saveAdminEdit}>
                {saved ? "Saved ✓" : saving ? "Saving…" : "Save admin revision"}
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={() => setStatus("approved")}
                      style={{ background: "var(--green)", borderColor: "var(--green)" }}
                      title="Sign off — this is what the payroll export pays">
                Approve
              </button>
            </div>
          </div>
        </div>
        {preview && sourceFile && (
          <DocPreviewPanel api={api} path={sourceFile.storage_path}
            fileName={sourceFile.file_name} onClose={() => setPreview(false)} />
        )}
        </div>
      </div>

      {dayIdx != null && (
        <DayModal day={days[dayIdx]} onClose={() => setDayIdx(null)}
          onSave={(upd) => { const n = days.slice(); n[dayIdx] = upd; setDays(n); setDayIdx(null); }} />
      )}
    </div>
  );
}

// Shows the engine's internal sub-agent trace for a submission: which agents ran,
// what they decided, and which model produced the kept numbers. Lets an admin see
// HOW the figures were derived, right next to the source document.
function AgentTrace({ trace, flow }) {
  const [open, setOpen] = useState(false);
  if (!trace || !Array.isArray(trace.actions) || trace.actions.length === 0) {
    return null;
  }
  const f = flow || trace.flow;
  const model = (m) => (m || "").replace(/^openai\//, "").replace(/^google\//, "")
    .replace(/^local\//, "local · ");
  const icon = {
    Classifier: "ti-file-search", Parser: "ti-table", OCR: "ti-scan",
    Normalizer: "ti-adjustments", "Normalizer:Local": "ti-cpu",
    "Normalizer:Cloud": "ti-cloud", VisionReader: "ti-eye", Reconciler: "ti-scale",
    Validator: "ti-checks",
  };
  return (
    <div className="card" style={{ background: "var(--surface-2)", marginBottom: 16 }}>
      <div className="between" style={{ padding: "10px 12px", cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="card-title" style={{ margin: 0 }}>How the AI processed this</span>
          {f && <span className={"badge " + (f === "budget" ? "green" : "amber")}>{f} flow</span>}
          {trace.handled_by && <span className="chip">kept: {trace.handled_by}</span>}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{open ? "hide ▲" : "show ▼"}</span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "8px 12px" }}>
          {trace.actions.map((a, i) => (
            <div key={i} className="row" style={{
              gap: 8, alignItems: "baseline", padding: "5px 0",
              borderBottom: i < trace.actions.length - 1 ? "1px solid var(--line)" : "none",
              opacity: a.ok === false ? 0.6 : 1,
            }}>
              <span className="chip" style={{ minWidth: 118, textAlign: "center" }}>{a.agent}</span>
              <span style={{ fontSize: 12, color: a.ok === false ? "var(--red)" : "var(--muted)", fontWeight: 600, minWidth: 84 }}>
                {a.action}
              </span>
              <span style={{ fontSize: 12, flex: 1 }}>
                {a.detail}
                {a.model && <span className="badge gray" style={{ marginLeft: 6 }}>{model(a.model)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline source-document preview PANEL: renders the stored file to scrollable
// page images (via the admin-preview route -> engine) and sits on the RIGHT of
// the submission detail so an admin can verify against the original side-by-side.
function DocPreviewPanel({ api, path, fileName, onClose }) {
  const [pages, setPages] = useState([]);
  const [doc, setDoc] = useState(null);   // { url, kind } browser-native preview
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState(1);
  const clamp = (z) => Math.min(4, Math.max(0.4, z));

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/admin-preview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "preview failed");
        if (!active) return;
        if (d.doc) setDoc(d.doc);
        else setPages(d.pages || []);
      } catch (e) {
        if (active) setErr(String(e.message || e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [path]);

  async function openOriginal() {
    const { data } = await api.storage.from("ts-uploads").createSignedUrl(path, 120);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  return (
    <div className="docpreview-panel">
      <div className="pv-bar">
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          📄 {fileName || "Source document"}
        </span>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => clamp(z * 0.8))} title="Zoom out">−</button>
          <span className="muted" style={{ fontSize: 11, minWidth: 38, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => clamp(z * 1.25))} title="Zoom in">+</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setZoom(1)} title="Fit">⤢</button>
          <button className="btn btn-ghost btn-sm" onClick={openOriginal} title="Open original in a new tab">open ↗</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Hide document">×</button>
        </div>
      </div>
      <div className="pv-body" style={{ "--z": zoom }}>
          {loading && (
            <div style={{ color: "#e2e8f0", textAlign: "center", padding: 40, fontSize: 13 }}>
              <span className="spinner" style={{ marginRight: 8 }} /> Rendering document…
            </div>
          )}
          {err && (
            <div style={{ color: "#fca5a5", textAlign: "center", padding: 40, fontSize: 13 }}>
              Couldn’t render preview: {err}<br />
              <a className="src-link" onClick={openOriginal} role="button" style={{ color: "#93c5fd" }}>Open the original ↗</a>
            </div>
          )}
          {!loading && !err && doc?.kind === "pdf" && (
            <iframe className="pv-frame" src={doc.url} title={fileName || "document"} />
          )}
          {!loading && !err && doc?.kind === "image" && (
            <img src={doc.url} alt={fileName || "document"} />
          )}
          {!loading && !err && doc?.kind === "html" && (
            // Sandboxed: this markup comes from an employee-uploaded document.
            // No allow-* tokens => opaque origin, scripting disabled.
            <iframe className="pv-frame" sandbox="" srcDoc={doc.html}
                    title={fileName || "document"} style={{ background: "#fff" }} />
          )}
          {!loading && !err && doc && !["pdf", "image", "html"].includes(doc.kind) && (
            <div className="pv-note">
              <div style={{ fontSize: 26 }}>📊</div>
              <b>No in-browser preview for this file type.</b>
              <span>This format can’t be rendered here — open the original instead.</span>
              <a className="btn btn-ghost btn-sm" onClick={openOriginal} role="button">Open original ↗</a>
            </div>
          )}
          {!loading && !err && !doc && pages.map((src, i) => <img key={i} src={src} alt={`page ${i + 1}`} />)}
        </div>
      </div>
  );
}

function DownloadBtn({ api, path }) {
  const [busy, setBusy] = useState(false);
  async function dl() {
    setBusy(true);
    const { data } = await api.storage.from("ts-uploads").createSignedUrl(path, 120);
    setBusy(false);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }
  return <button className="btn btn-ghost btn-sm" disabled={busy} onClick={dl}>{busy ? "…" : "Download"}</button>;
}

function Table({ headers, children }) {
  return (
    <div className="card" style={{ overflow: "auto" }}>
      <table className="tbl">
        <thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Empty({ cols, text }) {
  return <tr><td colSpan={cols} style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>{text}</td></tr>;
}
function KV({ k, v }) {
  return <div className="field" style={{ marginBottom: 6 }}><label>{k}</label><div>{v ?? "—"}</div></div>;
}
function fmt(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ts; }
}
