"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import Calendar from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import { createClient } from "@/lib/api/client";
import { periodLabel } from "@/lib/month";
import { rollup } from "@/lib/engine";

export default function AdminClient({ profile, profiles, edits, timesheets, files, adminEdits, aiFlow = "premium" }) {
  const supabase = createClient();
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

  const totalHours = pEdits.reduce((a, e) => a + (e.fields?.totals?.total || 0), 0);
  const flagged = pEdits.filter((e) => (e.validation?.errors?.length || 0) > 0).length;

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
          <div className="tile"><div className="v">{new Set(pEdits.map((e) => e.user_id)).size}</div><div className="l">Employees this month</div></div>
          <div className="tile"><div className="v">{pEdits.length}</div><div className="l">Submissions</div></div>
          <div className="tile tot"><div className="v">{Math.round(totalHours)}</div><div className="l">Total hours</div></div>
          <div className="tile"><div className="v" style={{ color: flagged ? "var(--red)" : "var(--green)" }}>{flagged}</div><div className="l">With errors</div></div>
        </div>

        <FlowPicker supabase={supabase} adminId={profile.id} initial={aiFlow} />

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
          <Table headers={["Employee", "Client", "Period", "Regular", "OT", "Total", "Triage", "Status", "Submitted", ""]}>
            {shownEdits.length === 0 && <Empty cols={10} text="No submissions in this bucket." />}
            {shownEdits.map((e) => {
              const p = pmap[e.user_id] || {};
              const t = e.fields?.totals || {};
              const errs = e.validation?.errors?.length || 0;
              const rv = reviewOf(e);
              const rvBadge = rv === "auto_accepted" ? ["green", "clean"]
                : rv === "blocked" ? ["red", "blocked"] : ["amber", "review"];
              return (
                <tr key={e.id}>
                  <td><b>{p.full_name || e.fields?.employee_name || "—"}</b><br /><span className="muted" style={{ fontSize: 12 }}>{p.email}</span></td>
                  <td>{e.fields?.client || p.client || "—"}</td>
                  <td>{periodLabel(e.month, e.year)}</td>
                  <td>{t.regular ?? "—"}</td>
                  <td>{t.overtime ?? "—"}</td>
                  <td><b>{t.total ?? "—"}</b></td>
                  <td><span className={"badge " + rvBadge[0]}>{rvBadge[1]}</span></td>
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
                  <td><DownloadBtn supabase={supabase} path={f.storage_path} /></td>
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
          supabase={supabase} onClose={() => setDetail(null)}
          onSaved={() => { setDetail(null); router.refresh(); }}
        />
      )}
    </>
  );
}

function SubmissionDetail({ edit, profile, adminProfile, sourceFile, supabase, onClose, onSaved }) {
  const [days, setDays] = useState(edit.days || []);
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
    const { error } = await supabase.from("ts_admin_edits").insert({
      timesheet_id: edit.timesheet_id, employee_user_id: edit.user_id,
      admin_user_id: adminProfile.id, month: edit.month, year: edit.year,
      fields: { ...(edit.fields || {}), totals: r }, days,
      questionnaire: q, validation: edit.validation || {}, note: note || null,
    });
    setSaving(false);
    if (error) { setSaveErr(error.message || "couldn't save this revision"); return; }
    setSaveErr("");
    setSaved(true);
    setTimeout(() => (onSaved ? onSaved() : onClose()), 900);
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
              <button className="btn btn-primary" disabled={saving} onClick={saveAdminEdit}>
                {saved ? "Saved ✓" : saving ? "Saving…" : "Save admin revision"}
              </button>
            </div>
          </div>
        </div>
        {preview && sourceFile && (
          <DocPreviewPanel supabase={supabase} path={sourceFile.storage_path}
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
function DocPreviewPanel({ supabase, path, fileName, onClose }) {
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
    const { data } = await supabase.storage.from("ts-uploads").createSignedUrl(path, 120);
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
          {!loading && !err && doc && doc.kind !== "pdf" && doc.kind !== "image" && (
            <div className="pv-note">
              <div style={{ fontSize: 26 }}>📊</div>
              <b>No in-browser preview for this file type.</b>
              <span>Spreadsheets and Word files can’t be rendered here — open the original instead.</span>
              <a className="btn btn-ghost btn-sm" onClick={openOriginal} role="button">Open original ↗</a>
            </div>
          )}
          {!loading && !err && !doc && pages.map((src, i) => <img key={i} src={src} alt={`page ${i + 1}`} />)}
        </div>
      </div>
  );
}

// Admin control: which AI flow processes employee uploads.
function FlowPicker({ supabase, adminId, initial }) {
  const [flow, setFlow] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  async function choose(next) {
    if (next === flow || saving) return;
    setSaving(true); setSaved("");
    // updated_at is refreshed server-side on conflict; there is no updated_by column
    const { error } = await supabase.from("ts_app_settings").upsert(
      { key: "ai_flow", value: next },
      { onConflict: "key" }
    );
    setSaving(false);
    if (error) { setSaved("Failed to save: " + (error.message || error)); return; }
    setFlow(next);
    setSaved("Saved ✓ — new uploads will use the " + next + " flow.");
  }

  const opts = [
    { key: "direct_serverless", title: "🚀 Direct (serverless)", desc: "Runs entirely inside the web app — no Python engine, no server. Direct++ (read → arithmetic repair → cross-family verify) in a Vercel function; needs only the OpenRouter key. Excel arrives as extracted text." },
    { key: "consensus", title: "🎯 Consensus", desc: "Highest accuracy — needs TWO agreeing derivations (a deterministic read + a blind model read) before a number auto-accepts. Clean sheets whose printed total matches exit free; disagreements go to review, never a silent wrong number." },
    { key: "premium_plus", title: "✨ Premium+", desc: "Best value — Premium's cheap parse-first, PLUS a full-image GPT vision re-read for any scan it under-reads. Recovers faint scans (e.g. Rajani 3h → correct) for pennies." },
    { key: "direct", title: "⚡ Direct", desc: "Whole file to GPT-5.4-nano with one exhaustive prompt, escalating to 5.4-mini / GPT-5 on hard docs. One request per file." },
    { key: "premium", title: "⭐ Premium", desc: "Parse-first — GPT-4o-mini + Gemini second opinion on hard files. Cheapest cloud." },
    { key: "budget", title: "💰 Budget", desc: "Near-zero cost — free local AI first (slower), cloud only as fallback. No Gemini." },
  ];

  return (
    <div className="card card-pad" style={{ marginBottom: 20 }}>
      <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 className="card-title" style={{ marginBottom: 4 }}>AI processing flow</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            Applies to every employee upload processed with AI.
          </div>
        </div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {opts.map((o) => (
            <button key={o.key} onClick={() => choose(o.key)} disabled={saving}
              title={o.desc}
              className="btn"
              style={{
                flexDirection: "column", alignItems: "flex-start", gap: 2,
                maxWidth: 320, textAlign: "left",
                border: flow === o.key ? "2px solid var(--brand)" : "1px solid var(--line-strong)",
                background: flow === o.key ? "var(--brand-soft)" : "var(--surface)",
                color: "var(--txt)",
              }}>
              <span style={{ fontWeight: 700 }}>
                {o.title} {flow === o.key && <span className="badge green" style={{ marginLeft: 6 }}>active</span>}
              </span>
              <span className="muted" style={{ fontSize: 11, fontWeight: 400, whiteSpace: "normal" }}>{o.desc}</span>
            </button>
          ))}
        </div>
      </div>
      {saved && (
        <div className={"alert " + (saved.startsWith("Failed") ? "error" : "ok")} style={{ marginTop: 10 }}>
          {saved}
        </div>
      )}
    </div>
  );
}

function DownloadBtn({ supabase, path }) {
  const [busy, setBusy] = useState(false);
  async function dl() {
    setBusy(true);
    const { data } = await supabase.storage.from("ts-uploads").createSignedUrl(path, 120);
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
