"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import Calendar from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import { createClient } from "@/lib/api/client";
import { periodLabel, defaultPeriod as processingPeriod, MONTHS } from "@/lib/month";
import { rollup, buildCalendar } from "@/lib/engine";

// ---------------------------------------------------------------------------
// ONE VOCABULARY, ONE SOURCE FOR EVERY NUMBER ON THIS SCREEN.
//
// A row used to carry three overlapping badge families at once — the human
// decision (`status`), the AI's verdict at submission (`fields.review_status`)
// and a second green "clean" sourced from `validation.errors` — so an approved
// timesheet could read "approved | review | clean" simultaneously. Now:
//
//   * exactly ONE pill says where the row is in the payroll process, and it is
//     always the human decision: awaiting review / approved / rejected / replaced;
//   * the AI verdict is a QUEUE-SORTING device for PENDING work only. It is a
//     coloured dot on rows still awaiting a decision, and a line of text in the
//     detail modal. Once a human has decided, it disappears from the row;
//   * the validator's output is not a badge at all — it is plain text in an
//     "Issues" column. The word "clean" no longer exists in this console;
//   * qualifier chips ("corrected", "entered by admin") are orthogonal facts
//     about the numbers, not workflow states.
//
// Every count — tiles, buckets, table body — is computed from the SAME
// period-scoped arrays below, so they cannot disagree.
// ---------------------------------------------------------------------------

const STATUS_BADGE = {
  submitted: ["amber", "awaiting review"],
  approved: ["green", "approved"],
  rejected: ["red", "rejected"],
  superseded: ["gray", "replaced"],
};
const statusOf = (e) => e.status || "submitted";

// The AI's verdict AT SUBMISSION TIME — a historical fact about the extraction,
// never mutated by a review. `none` means no AI ran at all (manual entry, an
// admin-filed sheet, or a legacy row); those must not be labelled with an AI
// word in either direction, which is what the old fallback did by returning
// "needs_review" from both branches of its final ternary.
const AI_VERDICT = (e) => {
  const rs = e.fields?.review_status;
  return rs === "auto_accepted" || rs === "needs_review" || rs === "blocked" ? rs : "none";
};
const AI_LABEL = {
  blocked: "AI blocked this extraction",
  needs_review: "AI flagged this for review",
  auto_accepted: "AI found no problems",
  none: "No AI ran on this submission (entered by hand)",
};
const enteredByAdmin = (e) => e.fields?.entry?.origin === "admin";

export default function AdminClient({ profile, profiles, edits, files, adminEdits }) {
  const api = createClient();
  const router = useRouter();
  const pmap = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const [tab, setTab] = useState("submissions");
  const [detail, setDetail] = useState(null);
  const [bucket, setBucket] = useState("all");
  const [adding, setAdding] = useState(false);

  // Only active, non-admin people are expected to file a timesheet. Deactivated
  // leavers used to sit on the month-end chase list forever.
  const roster = useMemo(
    () => profiles.filter((p) => p.role !== "admin" && p.active !== false),
    [profiles]
  );

  // ----- month/period selector -----
  // Periods that actually have data, newest first. `n` counts CURRENT
  // submissions (superseded history excluded) so the dropdown agrees with the
  // table it filters.
  const periods = useMemo(() => {
    const m = {};
    const bump = (x) => {
      if (x.month == null || x.year == null) return;
      const k = `${x.year}-${x.month}`;
      m[k] = m[k] || { key: k, year: x.year, month: x.month, n: 0 };
    };
    files.forEach(bump); adminEdits.forEach(bump); edits.forEach(bump);
    edits.forEach((e) => {
      if (statusOf(e) === "superseded") return;
      const k = `${e.year}-${e.month}`;
      if (m[k]) m[k].n++;
    });
    return Object.values(m).sort((a, b) => (b.year - a.year) || (b.month - a.month));
  }, [edits, files, adminEdits]);

  // ITEM 3 — "auto select the latest month that is getting processed or that
  // needs to be processed". The old rule sorted by SUBMISSION COUNT descending
  // and took the first, so the console opened on the busiest month, not the
  // latest. "Latest month with any data" is wrong too: `periods` is built from
  // uploaded files as well, so one stray upload for next month would hijack the
  // default. The console is a work queue, so:
  //
  //   the NEWEST period, not in the future, that still has outstanding work
  //     -> outstanding = a submission still awaiting a decision, OR an active
  //        employee who has not filed one
  //   else the month the business is currently processing (lib/month.js — the
  //     same rule the employee dashboard uses; two competing definitions of
  //     "current period" in a payroll app is how the next bug gets written)
  //   else the newest period that has data at all.
  const autoPeriod = useMemo(() => {
    if (periods.length === 0) return "all";
    const dp = processingPeriod();
    const ord = (y, m) => y * 12 + m;
    const dpKey = `${dp.year}-${dp.month}`;
    const candidates = periods.filter((p) => ord(p.year, p.month) <= ord(dp.year, dp.month));
    for (const p of candidates) {           // already newest-first
      const live = edits.filter((e) =>
        e.year === p.year && e.month === p.month && statusOf(e) !== "superseded");
      const pending = live.some((e) => statusOf(e) === "submitted");
      // A rejected row means that person still owes you one.
      const filed = new Set(live.filter((e) => statusOf(e) !== "rejected").map((e) => e.user_id));
      if (pending || roster.some((pr) => !filed.has(pr.id))) return p.key;
    }
    if (periods.some((p) => p.key === dpKey)) return dpKey;
    return (candidates[0] || periods[0]).key;
  }, [periods, edits, roster]);

  const [period, setPeriod] = useState(autoPeriod);
  // useState captures its initial value once. Without this the selection would
  // be frozen at first mount: a router.refresh() that brings in a NEWER period,
  // or a tab left open across a month boundary, would keep showing the old one.
  // A month the operator picked themselves is never yanked away from them.
  const [pickedPeriod, setPickedPeriod] = useState(false);
  useEffect(() => {
    const known = period === "all" || periods.some((p) => p.key === period);
    if (!known) { setPeriod(autoPeriod); return; }   // the selected month left the data
    if (!pickedPeriod && period !== autoPeriod) setPeriod(autoPeriod);
  }, [autoPeriod, periods, period, pickedPeriod]);

  const label = (p) => `${MONTHS[p.month - 1]} ${p.year}`;
  const selected = periods.find((p) => p.key === period) || null;

  const inPeriod = (x) => period === "all" || `${x.year}-${x.month}` === period;
  const pEdits = edits.filter(inPeriod);
  const pFiles = files.filter(inPeriod);
  const pAdminEdits = adminEdits.filter(inPeriod);

  // Superseded rows are history: a resubmission replaced them. `rows` is THE
  // working set — tiles, buckets and the table body all read it, so the numbers
  // above the table and the rows inside it can never describe different data.
  // Replaced rows stay reachable behind their own bucket (a wage-and-hour audit
  // needs them) but never count toward anything.
  const replaced = pEdits.filter((e) => statusOf(e) === "superseded");
  const rows = pEdits.filter((e) => statusOf(e) !== "superseded");
  const byStatus = { submitted: [], approved: [], rejected: [] };
  rows.forEach((e) => (byStatus[statusOf(e)] || byStatus.submitted).push(e));

  // THE numbers of record: an admin correction (final_*) wins over what the
  // employee submitted. This is what the export pays and what the tiles show.
  const payroll = (e) => ({
    regular: e.final_regular ?? e.fields?.totals?.regular ?? 0,
    overtime: e.final_overtime ?? e.fields?.totals?.overtime ?? 0,
    total: e.final_total ?? e.fields?.totals?.total ?? 0,
    corrected: e.final_total != null,
  });
  const sumHours = (list) => list.reduce((a, e) => a + Number(payroll(e).total || 0), 0);

  // Only APPROVED hours are payable, so that is what the headline number counts.
  // It used to sum every non-superseded row — including rejected ones — under
  // the unqualified label "Total hours", reporting hours the export won't pay.
  const approvedHours = sumHours(byStatus.approved);
  const awaitingHours = sumHours(byStatus.submitted);

  // Who hasn't filed for this period — the actual month-end chase list.
  // A REJECTED row does not count as done: those are exactly the people who
  // were told to resubmit and haven't.
  const notSubmitted = useMemo(() => {
    if (period === "all") return [];
    const filed = new Set(rows.filter((e) => statusOf(e) !== "rejected").map((e) => e.user_id));
    return roster.filter((p) => !filed.has(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, period, edits]);

  // Belt and braces for the one thing that must never happen. /api/admin/review
  // and /api/admin/timesheet both retire every other current row when they
  // approve one, and the export refuses to emit a CSV if this ever fires — but
  // the operator should see it here first, not as a failed payroll run.
  const doubleApproved = useMemo(() => {
    const n = {};
    byStatus.approved.forEach((e) => { n[e.user_id] = (n[e.user_id] || 0) + 1; });
    return Object.keys(n).filter((uid) => n[uid] > 1)
      .map((uid) => pmap[uid]?.full_name || pmap[uid]?.email || uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, period, pmap]);

  const BUCKETS = [
    ["all", "All", rows.length, "gray"],
    ["submitted", "Awaiting review", byStatus.submitted.length, "amber"],
    ["approved", "Approved", byStatus.approved.length, "green"],
    ["rejected", "Rejected", byStatus.rejected.length, "red"],
    ["superseded", "Replaced", replaced.length, "gray"],
  ];
  const SEVERITY = { blocked: 0, needs_review: 1, auto_accepted: 2, none: 2 };
  const shownEdits = useMemo(() => {
    const list = bucket === "all" ? rows
      : bucket === "superseded" ? replaced
      : byStatus[bucket] || [];
    // The AI verdict's one remaining job: order the pending queue so the
    // submissions most likely to need attention come first.
    if (bucket !== "submitted") return list;
    return [...list].sort((a, b) => SEVERITY[AI_VERDICT(a)] - SEVERITY[AI_VERDICT(b)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, edits, period]);

  return (
    <>
      <Topbar profile={profile} active="admin" />
      <div className="container" style={{ padding: "22px 24px 60px" }}>
        <div className="between" style={{ flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
          <div>
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>Admin console</h1>
            <p className="muted">Review employee submissions, audit edits, and make corrections.</p>
          </div>
          <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + Add timesheet for an employee
            </button>
            {periods.length > 0 && (
              <div className="field" style={{ margin: 0, minWidth: 190 }}>
                <label>Month</label>
                <select value={period}
                        onChange={(e) => { setPickedPeriod(true); setPeriod(e.target.value); }}>
                  {periods.map((p) => (
                    <option key={p.key} value={p.key}>{label(p)} ({p.n})</option>
                  ))}
                  <option value="all">All months ({edits.filter((e) => statusOf(e) !== "superseded").length})</option>
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="tiles" style={{ margin: "14px 0 20px" }}>
          <div className="tile">
            <div className="v">{new Set(rows.map((e) => e.user_id)).size}</div>
            <div className="l">Employees this month</div>
          </div>
          <div className="tile">
            <div className="v" style={{ color: byStatus.submitted.length ? "var(--amber)" : "var(--green)" }}>
              {byStatus.submitted.length}
            </div>
            <div className="l">Awaiting review</div>
          </div>
          <div className="tile tot">
            <div className="v">{Math.round(approvedHours)}</div>
            <div className="l">Approved hours</div>
            {/* Approved-only is the payable number. The awaiting hours are shown
                right beneath it so nothing is hidden by the narrower count. */}
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {awaitingHours > 0 ? `+${Math.round(awaitingHours)} h awaiting review` : "nothing awaiting review"}
            </div>
          </div>
          <div className="tile">
            <div className="v" style={{ color: notSubmitted.length ? "var(--red)" : "var(--green)" }}>
              {notSubmitted.length}
            </div>
            <div className="l">Not submitted</div>
          </div>
        </div>

        {doubleApproved.length > 0 && (
          <div className="alert error" style={{ marginBottom: 18 }}>
            <div>
              <b>{doubleApproved.join(", ")}</b> {doubleApproved.length === 1 ? "has" : "have"} more
              than one <b>approved</b> timesheet for this month. Payroll would pay them twice, so the
              CSV export will refuse to run until one of them is rejected or replaced.
            </div>
          </div>
        )}

        {/* Month-end chase list: who still owes you a timesheet. */}
        {period !== "all" && notSubmitted.length > 0 && (
          <div className="card card-pad" style={{ marginBottom: 20 }}>
            <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
              <h3 className="card-title" style={{ marginBottom: 0 }}>
                Not submitted yet ({notSubmitted.length})
              </h3>
              <span className="muted" style={{ fontSize: 12 }}>
                Active employees with no current timesheet for this period (a rejected one doesn’t count).
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
          {[["submissions", "Submissions"], ["employees", "Employees"], ["files", "Files"], ["revisions", "Admin revisions"]].map(([k, tabLabel]) => (
            <div key={k} className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
              {tabLabel}
              {k === "revisions" && pAdminEdits.length > 0 && <span className="badge gray" style={{ marginLeft: 6 }}>{pAdminEdits.length}</span>}
            </div>
          ))}
        </div>

        {tab === "submissions" && (
          <>
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {BUCKETS.map(([k, bLabel, n, color]) => (
              <button key={k} onClick={() => setBucket(k)}
                className="btn btn-sm"
                title={k === "superseded"
                  ? "Replaced by a newer submission — kept for audit, counted nowhere"
                  : undefined}
                style={{
                  border: bucket === k ? "2px solid var(--brand)" : "1px solid var(--line-strong)",
                  background: bucket === k ? "var(--brand-soft)" : "var(--surface)",
                  color: "var(--txt)",
                  opacity: k === "superseded" && n === 0 ? 0.55 : 1,
                }}>
                {bLabel} <span className={"badge " + color} style={{ marginLeft: 4 }}>{n}</span>
              </button>
            ))}
          </div>
          <Table headers={["Employee", "Client", "Period", "Regular", "OT", "Total", "Status", "Issues", "Submitted", ""]}>
            {shownEdits.length === 0 && <Empty cols={10} text="No submissions in this bucket." />}
            {shownEdits.map((e) => {
              const p = pmap[e.user_id] || {};
              const t = payroll(e);
              const st = statusOf(e);
              const sb = STATUS_BADGE[st] || STATUS_BADGE.submitted;
              const errs = e.validation?.errors?.length || 0;
              const warns = e.validation?.warnings?.length || 0;
              const verdict = AI_VERDICT(e);
              const isReplaced = st === "superseded";
              return (
                <tr key={e.id} style={isReplaced ? { opacity: 0.55 } : undefined}>
                  <td>
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      {/* AI triage marker: pending work only. Once a human has
                          decided, the machine's opinion is no longer the story. */}
                      {st === "submitted" && <AiDot verdict={verdict} />}
                      <b>{p.full_name || e.fields?.employee_name || "—"}</b>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>{p.email}</span>
                  </td>
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
                    {enteredByAdmin(e) && (
                      <span className="badge gray" style={{ marginLeft: 6 }}
                            title={`Filed by ${e.fields.entry.by_name || e.fields.entry.by_email} on the employee's behalf`}>
                        entered by admin
                      </span>
                    )}
                    {(st === "approved" || st === "rejected") && e.reviewed_at && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                        {pmap[e.reviewed_by]?.full_name ? `${pmap[e.reviewed_by].full_name} · ` : ""}{fmt(e.reviewed_at)}
                      </div>
                    )}
                    {st === "rejected" && e.review_note && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }} title={e.review_note}>
                        “{e.review_note.length > 44 ? e.review_note.slice(0, 44) + "…" : e.review_note}”
                      </div>
                    )}
                  </td>
                  {/* Not a badge. The validator's output is information about the
                      document, not a workflow state — the green "clean" badge
                      that used to live here collided with the triage wording. */}
                  <td style={{ fontSize: 12 }}>
                    {errs > 0
                      ? <span style={{ color: "var(--red)", fontWeight: 600 }}>{errs} error{errs > 1 ? "s" : ""}</span>
                      : warns > 0
                        ? <span style={{ color: "var(--amber)", fontWeight: 600 }}>{warns} warning{warns > 1 ? "s" : ""}</span>
                        : <span className="muted">—</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{fmt(e.created_at)}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => setDetail(e)}>
                      {isReplaced ? "View" : "Review"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </Table>
          </>
        )}

        {tab === "employees" && (
          <Table headers={["Name", "Email", "Role", "Status", "Employer", "Client", "Job title", "Manager"]}>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td><b>{p.full_name || "—"}</b></td>
                <td>{p.email}</td>
                <td>{p.role === "admin" ? <span className="badge purple">admin</span> : <span className="badge gray">employee</span>}</td>
                <td>{p.active === false ? <span className="badge red">deactivated</span> : <span className="badge green">active</span>}</td>
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

      {adding && (
        <AddTimesheetModal
          api={api} roster={roster} adminProfile={profile}
          initialPeriod={selected}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); setPickedPeriod(true); router.refresh(); }}
        />
      )}

      {detail && (
        <SubmissionDetail
          edit={detail} profile={pmap[detail.user_id] || {}} adminProfile={profile}
          reviewer={pmap[detail.reviewed_by] || null}
          sourceFile={files.find((f) => f.user_id === detail.user_id
            && f.month === detail.month && f.year === detail.year)}
          api={api} onClose={() => setDetail(null)}
          onSaved={() => { setDetail(null); router.refresh(); }}
        />
      )}
    </>
  );
}

// A dot, not a word: the AI's triage verdict routes pending work, it does not
// describe the row. Nothing is rendered when the AI was happy or never ran.
function AiDot({ verdict }) {
  if (verdict !== "blocked" && verdict !== "needs_review") return null;
  const color = verdict === "blocked" ? "var(--red)" : "var(--amber)";
  return (
    <span title={AI_LABEL[verdict]} aria-label={AI_LABEL[verdict]}
      style={{ width: 8, height: 8, borderRadius: "50%", background: color,
               display: "inline-block", flex: "0 0 auto" }} />
  );
}

// ---------------------------------------------------------------------------
// ITEM 1 — an admin files a timesheet FOR another employee.
//
// This deliberately does NOT go through /api/data: lib/aws/data.js forces the
// owner column to the caller, so a write for someone else lands on the admin's
// own record. It posts to /api/admin/timesheet, which re-checks the admin role
// on the server, derives the hours from `days`, retires any existing current
// row for that person+month, and stamps the row so it is distinguishable from
// something the employee submitted themselves.
// ---------------------------------------------------------------------------
function AddTimesheetModal({ api, roster, adminProfile, initialPeriod, onClose, onSaved }) {
  const dp = processingPeriod();
  const [pick, setPick] = useState("");            // what the admin typed
  const [month, setMonth] = useState(initialPeriod?.month || dp.month);
  const [year, setYear] = useState(initialPeriod?.year || dp.year);
  const [client, setClient] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState([]);
  const [dayIdx, setDayIdx] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState(null);  // existing rows to supersede

  // Type-to-filter over the registered employee list. A datalist gives the
  // browser's own filtering with no UI library and no new styling.
  const optionLabel = (p) => `${p.full_name || p.email}${p.email ? ` — ${p.email}` : ""}`;
  const employee = useMemo(
    () => roster.find((p) => optionLabel(p) === pick || p.email === pick.trim()) || null,
    [roster, pick]
  );

  useEffect(() => {
    if (employee && !client) setClient(employee.client || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee]);

  // A conflict is about one specific person+month; changing either makes the
  // "replace it" prompt stale, and acting on a stale prompt would supersede a
  // timesheet the admin never looked at.
  useEffect(() => { setConflict(null); }, [pick, month, year]);

  // Rebuild the (empty) month grid whenever the period changes, so weekends and
  // US holidays are marked exactly as they are on the employee's own screen.
  useEffect(() => {
    setDays(buildCalendar(null, Number(month), Number(year)));
  }, [month, year]);

  const totals = rollup(days);
  const ready = !!employee && note.trim().length >= 3 && totals.total > 0;

  async function submit(supersede) {
    setBusy(true); setErr("");
    try {
      // The document (if any) is stored under the EMPLOYEE's prefix, which
      // /api/storage/upload already allows an admin to write to. That keeps the
      // employee able to read their own source file and keeps the console's
      // per-employee file lookup working unchanged.
      let filePayload = null;
      if (file) {
        const ext = (file.name.split(".").pop() || "dat").toLowerCase();
        const path = `${employee.id}/${year}-${String(month).padStart(2, "0")}/${Date.now()}.${ext}`;
        const { error: upErr } = await api.storage.from("ts-uploads").upload(path, file);
        if (upErr) throw new Error(upErr.message || "couldn't upload that document");
        filePayload = { path, name: file.name, mime: file.type || null, size: file.size || null };
      }
      const res = await fetch("/api/admin/timesheet", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeUserId: employee.id, year: Number(year), month: Number(month),
          days, note: note.trim(), supersede: !!supersede,
          fields: { client: client || null },
          questionnaire: { enteredByAdmin: true, adminEmail: adminProfile?.email || null },
          file: filePayload,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (j.needsSupersede) { setConflict(j.existing || []); setBusy(false); return; }
        throw new Error(j.error || "couldn't file this timesheet");
      }
      setBusy(false);
      onSaved();
    } catch (e) {
      setBusy(false);
      setErr(String(e.message || e));
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 16 }}>Add a timesheet for an employee</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              Filed in the employee’s name, signed by you, and marked “entered by admin”.
            </div>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="grid-2">
            <div className="field">
              <label>Employee <Req /></label>
              <input list="ts-admin-roster" value={pick} autoComplete="off"
                     onChange={(e) => setPick(e.target.value)}
                     placeholder="Type a name or email…" />
              <datalist id="ts-admin-roster">
                {roster.map((p) => <option key={p.id} value={optionLabel(p)} />)}
              </datalist>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {employee
                  ? <span style={{ color: "var(--green)" }}>✓ {employee.full_name || employee.email}</span>
                  : `Pick one of ${roster.length} registered employees.`}
              </div>
            </div>
            <div className="field">
              <label>Period <Req /></label>
              <div className="row" style={{ gap: 8 }}>
                <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {[dp.year + 1, dp.year, dp.year - 1, dp.year - 2].map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Client</label>
              <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="optional" />
            </div>
            <div className="field">
              <label>Source document</label>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Optional. Stored against the employee so they can see it too.
              </div>
            </div>
          </div>

          <div className="field">
            <label>Why are you filing this for them? <Req /></label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="e.g. Paper timesheet handed in on 3 Aug — employee has no laptop access" />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Required. These hours are payable without anyone else reviewing them, so this
              note and the audit entry are the only record of why they exist.
            </div>
          </div>

          <div className="tiles" style={{ margin: "16px 0" }}>
            <div className="tile reg"><div className="v">{totals.regular}</div><div className="l">Regular</div></div>
            <div className="tile ot"><div className="v">{totals.overtime}</div><div className="l">Overtime</div></div>
            <div className="tile tot"><div className="v">{totals.total}</div><div className="l">Total</div></div>
            <div className="tile"><div className="v">{totals.daysWorked}</div><div className="l">Days worked</div></div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            These are a preview. The hours that get stored are recomputed on the server from the
            day entries below — the totals shown here are never posted.
          </div>

          <h3 className="card-title">Hours — click a day to enter them <Req /></h3>
          <Calendar calendar={days} month={Number(month)} year={Number(year)} onDayClick={setDayIdx} />

          {err && <div className="alert error" style={{ margin: "12px 0" }}>{err}</div>}

          {conflict && (
            <div className="alert warn" style={{ margin: "12px 0" }}>
              <div>
                <b>{employee?.full_name || "This employee"} already has a timesheet for {MONTHS[month - 1]} {year}</b>
                {" "}({conflict.map((c) => c.status).join(", ")}).
                Filing yours will mark {conflict.length === 1 ? "it" : "them"} as <b>replaced</b>, so payroll
                still sees exactly one timesheet for this month. The replaced {conflict.length === 1 ? "row stays" : "rows stay"} visible
                under the “Replaced” bucket.
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => submit(true)}>
                    {busy ? "Filing…" : "Replace it and file mine"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="between" style={{ marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Filed as approved and payable, in {employee?.full_name || "the employee"}’s name.
            </span>
            <div className="row">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!ready || busy || !!conflict}
                      onClick={() => submit(false)}>
                {busy ? "Filing…" : "File this timesheet"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {dayIdx != null && (
        <DayModal day={days[dayIdx]} onClose={() => setDayIdx(null)}
          onSave={(upd) => { const n = days.slice(); n[dayIdx] = upd; setDays(n); setDayIdx(null); }} />
      )}
    </div>
  );
}

// A required-field marker: what must be filled in, obvious before the save
// button refuses. Same `.req` class (and `--req` colour) as the employee form —
// NOT a local red copy. Red is reserved for "what you typed is wrong"; this is
// "you still have to fill this in", and one app must not spell it two ways.
function Req() {
  return <span className="req" title="Required" aria-hidden="true">*</span>;
}

function SubmissionDetail({ edit, profile, adminProfile, reviewer, sourceFile, api, onClose, onSaved }) {
  // `days` is the heavy part of a submission (one entry per calendar day), so
  // the list query no longer carries it. Fetch it for just this submission.
  const [days, setDays] = useState(edit.days || []);
  const [baseDays, setBaseDays] = useState(JSON.stringify(edit.days || []));
  const [loadingDays, setLoadingDays] = useState(!edit.days);
  useEffect(() => {
    if (edit.days) return;
    let alive = true;
    api.from("ts_employee_edits").select("days,questionnaire").eq("id", edit.id).single()
      .then(({ data }) => {
        if (!alive) return;
        setDays(data?.days || []);
        setBaseDays(JSON.stringify(data?.days || []));
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
  const summaryOnly = !loadingDays && dayR.total === 0 && Number(stored.total) > 0;
  const storedView = {
    regular: stored.regular ?? stored.total ?? 0,
    overtime: stored.overtime ?? 0,
    total: stored.total ?? 0,
    daysWorked: stored.daysWorked ?? stored.days_worked ?? "—",
  };
  // The day grid arrives in a second request. Until it does, `days` is empty and
  // rolling it up would flash 0 hours on a payroll screen, so show the stored
  // figures while loading and only switch to the derived ones once they exist.
  const r = loadingDays || summaryOnly ? storedView : dayR;
  // The only correction input for a summary-only document: two numbers, and the
  // server still computes the total from them rather than accepting one.
  const [sumReg, setSumReg] = useState("");
  const [sumOt, setSumOt] = useState("");
  useEffect(() => {
    if (!summaryOnly) return;
    setSumReg(String(storedView.regular));
    setSumOt(String(storedView.overtime));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryOnly]);

  const q = edit.questionnaire || {};
  const st = statusOf(edit);
  const sb = STATUS_BADGE[st] || STATUS_BADGE.submitted;
  const isReplaced = st === "superseded";
  const daysDirty = JSON.stringify(days) !== baseDays;
  const summaryDirty = summaryOnly &&
    (Number(sumReg) !== Number(storedView.regular) ||
     Number(sumOt) !== Number(storedView.overtime));

  // Save a correction. Two things must happen together, in this order:
  //  1. /api/admin/review — the numbers of record. It DERIVES the totals from
  //     the day grid we send; we never post a total. It also flips the row to
  //     'approved', because a correction that leaves the row "awaiting review"
  //     is excluded from the payroll export and silently doesn't get paid.
  //  2. ts_admin_edits — the append-only human revision trail, written only
  //     after (1) succeeded so it can never claim a correction that didn't apply.
  async function saveAdminEdit() {
    if (!note.trim()) {
      setSaveErr("Add a note saying what you changed — it goes on the payroll record.");
      return;
    }
    setSaving(true); setSaveErr("");
    const payload = { editId: edit.id, status: "approved", note: note.trim() };
    if (summaryOnly && !daysDirty) {
      // No per-day grid to sum. Only send corrected figures if they actually
      // changed; otherwise leave final_* null so the export keeps using the
      // document's own stated totals.
      if (summaryDirty) payload.summaryTotals = { regular: Number(sumReg) || 0, overtime: Number(sumOt) || 0 };
    } else if (daysDirty) {
      payload.days = days;
    }

    const res = await fetch("/api/admin/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSaving(false);
      setSaveErr(j.error || "couldn't update the payroll total");
      return;
    }
    const { submission } = await res.json().catch(() => ({}));

    const { error } = await api.from("ts_admin_edits").insert({
      timesheet_id: edit.timesheet_id, employee_user_id: edit.user_id,
      admin_user_id: adminProfile.id, month: edit.month, year: edit.year,
      // The figures of record are the server-derived ones this call just
      // returned, not the browser's arithmetic.
      fields: { ...(edit.fields || {}), totals: {
        regular: submission?.final_regular ?? r.regular,
        overtime: submission?.final_overtime ?? r.overtime,
        total: submission?.final_total ?? r.total,
      } },
      days, questionnaire: q, validation: edit.validation || {}, note: note.trim(),
    });
    setSaving(false);
    if (error) {
      setSaveErr(`the correction was applied, but the revision log entry failed: ${error.message || error}`);
      return;
    }
    setSaveErr("");
    setSaved(true);
    setTimeout(() => (onSaved ? onSaved() : onClose()), 900);
  }

  // Approve / reject / reopen — the review decision itself.
  async function setStatus(status) {
    if (status === "rejected" && !note.trim()) {
      setSaveErr("Say why you're rejecting it — the employee sees this note.");
      return;
    }
    setSaving(true); setSaveErr("");
    const res = await fetch("/api/admin/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editId: edit.id, status, note: note.trim() || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setSaveErr(j.error || "couldn't update the review status");
      return;
    }
    onSaved ? onSaved() : onClose();
  }

  const verdict = AI_VERDICT(edit);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={"modal " + (preview && sourceFile ? "modal-split" : "wide")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 16 }}>{profile.full_name || edit.fields?.employee_name} · {periodLabel(edit.month, edit.year)}</h3>
            <div className="muted" style={{ fontSize: 12 }}>{profile.email} · {edit.fields?.client || profile.client || "—"}</div>
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <span className={"badge " + sb[0]}>{sb[1]}</span>
              {edit.final_total != null && <span className="badge purple">corrected</span>}
              {enteredByAdmin(edit) && <span className="badge gray">entered by admin</span>}
              {(st === "approved" || st === "rejected") && edit.reviewed_at && (
                <span className="muted" style={{ fontSize: 12 }}>
                  by {reviewer?.full_name || "an admin"} · {fmt(edit.reviewed_at)}
                </span>
              )}
            </div>
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
          {isReplaced && (
            <div className="alert warn" style={{ marginBottom: 14 }}>
              This submission was <b>replaced</b> by a newer one for the same month. It is kept
              for audit only — it counts toward nothing and cannot be reviewed.
            </div>
          )}
          {enteredByAdmin(edit) && (
            <div className="alert info" style={{ marginBottom: 14 }}>
              Filed by <b>{edit.fields.entry.by_name || edit.fields.entry.by_email}</b> on the
              employee’s behalf{edit.fields.entry.at ? ` on ${fmt(edit.fields.entry.at)}` : ""}
              {edit.fields.entry.note ? ` — “${edit.fields.entry.note}”` : ""}.
            </div>
          )}

          <div className="tiles" style={{ marginBottom: 16 }}>
            <div className="tile reg"><div className="v">{r.regular}</div><div className="l">Regular</div></div>
            <div className="tile ot"><div className="v">{r.overtime}</div><div className="l">Overtime</div></div>
            <div className="tile tot"><div className="v">{r.total}</div><div className="l">Total</div></div>
            <div className="tile"><div className="v">{r.daysWorked}</div><div className="l">Days worked</div></div>
          </div>

          {summaryOnly && (
            <>
              <div className="alert info" style={{ marginBottom: 14 }}>
                This document only provided <b>summary totals</b> (weekly rows or a
                stated month total) — there is no per-day breakdown, so the calendar
                below is empty. The totals above come from the document’s summary.
                Use “Preview document” to verify against the original.
              </div>
              {!isReplaced && (
                <div className="grid-2" style={{ marginBottom: 16 }}>
                  <div className="field">
                    <label>Corrected regular hours</label>
                    <input type="number" min="0" step="0.25" value={sumReg}
                           onChange={(e) => setSumReg(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Corrected overtime hours</label>
                    <input type="number" min="0" step="0.25" value={sumOt}
                           onChange={(e) => setSumOt(e.target.value)} />
                  </div>
                </div>
              )}
            </>
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

          {/* The AI's verdict lives HERE, as a historical fact about the
              extraction — not as a badge on the row competing with the human
              decision. It is never rewritten by an approval. */}
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            AI verdict at submission: <b>{AI_LABEL[verdict]}</b>
          </div>

          <AgentTrace trace={edit.fields?.agent_trace} flow={edit.fields?.flow} />

          <h3 className="card-title">
            Calendar{isReplaced ? "" : " — click a day to correct as admin"}
          </h3>
          <Calendar calendar={days} month={edit.month} year={edit.year}
                    onDayClick={isReplaced ? () => {} : setDayIdx} />

          {!isReplaced && (
            <>
              <div className="field" style={{ marginTop: 16 }}>
                <label>
                  Admin note (why you changed it)
                  {(daysDirty || summaryDirty) && <Req />}
                </label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Corrected Apr 14 — client confirmed 8h" />
              </div>
              {saveErr && <div className="alert error" style={{ margin: "10px 0" }}>{saveErr}</div>}
              <div className="between">
                <span className="muted" style={{ fontSize: 12 }}>
                  Saved as a separate admin revision; the employee’s submission is preserved.
                  Approving retires any other timesheet this employee has for this month.
                </span>
                <div className="row">
                  <button className="btn btn-ghost" onClick={onClose}>Close</button>
                  {(st === "approved" || st === "rejected") && (
                    <button className="btn btn-ghost" disabled={saving} onClick={() => setStatus("submitted")}
                            title="Put it back in the review queue">
                      Reopen
                    </button>
                  )}
                  <button className="btn btn-ghost" disabled={saving || st === "rejected"} onClick={() => setStatus("rejected")}
                          style={{ color: "var(--red)" }} title="Send back to the employee to resubmit">
                    Reject
                  </button>
                  {/* Disabled until the day grid has arrived: approving a view
                      that hasn't finished loading would sign off numbers the
                      admin has not actually seen. */}
                  <button className="btn btn-primary" disabled={saving || loadingDays} onClick={saveAdminEdit}>
                    {saved ? "Saved ✓" : saving ? "Saving…" : loadingDays ? "Loading…" : "Save correction & approve"}
                  </button>
                  <button className="btn btn-primary" disabled={saving || loadingDays || st === "approved"} onClick={() => setStatus("approved")}
                          style={{ background: "var(--green)", borderColor: "var(--green)" }}
                          title="Sign off — this is what the payroll export pays">
                    Approve
                  </button>
                </div>
              </div>
            </>
          )}
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
