"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Topbar from "@/components/Topbar";
import Calendar from "@/components/Calendar";
import DayModal from "@/components/DayModal";
import useDialogKeys from "@/components/useDialogKeys";
import { createClient } from "@/lib/api/client";
import { periodLabel, defaultPeriod as processingPeriod, MONTHS } from "@/lib/month";
import { rollup } from "@/lib/engine";
// Only the required-field marker survives here: "who is this timesheet
// for?" now lives on the timesheet tab, with the rest of the filing flow.
import { Req } from "@/components/TimesheetTargetPicker";
// The SAME predicates the server enforces with (lib/aws/roles.js is pure, so it
// bundles into a client component untouched). Re-typing `role === "admin"` here
// is how a screen ends up disagreeing with the route it posts to.
import { canFileForOthers, canReview, canExport } from "@/lib/aws/roles";

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
  // Filing in someone else's name — and adding a person — is privileged, so the
  // trigger is not shown to anyone who would be refused. The page guard and the
  // server route are the gates that MATTER; this only keeps the button honest.
  const canFile = canFileForOthers(profile);
  // ...and the ones an HR user must NOT be offered. Every one of these is
  // enforced server-side too (/api/admin/review, /api/admin/export and
  // /api/storage/get all test for admin themselves) — the point of testing it
  // again here is that a button which always answers "forbidden" is worse than
  // no button: it reads as a broken payroll console rather than as a boundary.
  const reviewer = canReview(profile);
  const exporter = canExport(profile);

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

  // ---- people this console cannot tell apart -------------------------------
  // The chase list rendered `full_name` and nothing else, so three payroll
  // records for one person showed as three identical grey badges reading
  // "Nora New" — the console made the duplicate HARDER to spot than the raw
  // table would have. Two things follow from that, both here:
  //
  //   duplicateIdentity(p) — true when this person's name (or employee code) is
  //     shared with somebody else, so every list that shows a name can show the
  //     address that distinguishes them instead of three of the same word;
  //   duplicatePeople      — the warning card, because a shared employee_code
  //     will make the payroll export REFUSE and the operator should learn that
  //     here, in the console, not from a failed export on payroll day.
  const dupNames = useMemo(() => {
    const byName = {}, byCode = {};
    profiles.forEach((p) => {
      const n = String(p.full_name || "").trim().toLowerCase().replace(/\s+/g, " ");
      const c = String(p.employee_code || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (n) (byName[n] = byName[n] || []).push(p);
      if (c) (byCode[c] = byCode[c] || []).push(p);
    });
    return { byName, byCode };
  }, [profiles]);
  const duplicateIdentity = (p) => {
    const n = String(p?.full_name || "").trim().toLowerCase().replace(/\s+/g, " ");
    const c = String(p?.employee_code || "").trim().toLowerCase().replace(/\s+/g, " ");
    return (n && (dupNames.byName[n]?.length || 0) > 1) ||
           (c && (dupNames.byCode[c]?.length || 0) > 1);
  };
  const duplicatePeople = useMemo(() => {
    const out = [];
    Object.entries(dupNames.byCode).forEach(([code, ps]) => {
      if (ps.length > 1) out.push({ kind: "code", what: ps[0].employee_code || code, people: ps });
    });
    Object.entries(dupNames.byName).forEach(([, ps]) => {
      if (ps.length > 1) out.push({ kind: "name", what: ps[0].full_name, people: ps });
    });
    return out;
  }, [dupNames]);

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
            {/* Name the screen for the job the reader is actually allowed to do
                on it. "Review submissions and make corrections" is a list of
                things an HR user will be refused, and a payroll console that
                describes powers you do not have is how somebody concludes the
                system is broken and works around it. */}
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>
              {reviewer ? "Admin console" : "Payroll console"}
            </h1>
            <p className="muted">
              {reviewer
                ? "Review employee submissions, audit edits, and make corrections."
                : "See who has filed and who still owes you a timesheet. Filing on somebody's behalf — with the document upload and AI extraction — is on the timesheet tab. Approving, correcting and payroll export are an admin's."}
            </p>
          </div>
          <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            {/* A LINK, NOT NOTHING. Filing moved to the timesheet tab, where it
                gets the document upload, the AI extraction and the review grid
                this console's modal never had. But HR's ONLY reasons to be on
                this page are filing and registering people (app/admin/page.js
                lets them through on canFileForOthers precisely for that), so
                deleting the affordance with no signpost would strand a whole
                role on a console whose review, export and files features all
                refuse them.

                `for=other` sets the picker's MODE and nothing else — a
                non-identifying enum. An employee id never appears in a URL; it
                is only ever chosen in the dropdown. */}
            {canFile && (
              <Link className="btn btn-primary btn-sm" href="/dashboard?for=other">
                File a timesheet
              </Link>
            )}
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

        {/* TWO RECORDS THAT MIGHT BE ONE PERSON.
            The alert above catches one ACCOUNT approved twice. This catches the
            other shape of the same mistake — one HUMAN holding two accounts —
            which that check is blind to because each account has exactly one
            approved row. A shared employee code additionally makes the export
            refuse (payroll matches on it), so it is an error; a shared name may
            be two genuine namesakes, so it is a warning. */}
        {duplicatePeople.length > 0 && (
          <div className={`alert ${duplicatePeople.some((d) => d.kind === "code") ? "error" : "warn"}`}
               style={{ marginBottom: 18 }}>
            <b>Some people may be registered twice.</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {duplicatePeople.map((d) => (
                <li key={`${d.kind}:${d.what}`} style={{ fontSize: 13 }}>
                  {d.kind === "code"
                    ? <>Employee code <b>{d.what}</b> is held by {d.people.length} records — payroll
                        matches people on that code, so <b>the export will refuse this period</b> until
                        each of them has their own: </>
                    : <>{d.people.length} records are named <b>{d.what}</b> — if they are the same
                        person, that is two payslips: </>}
                  {d.people.map((p) => p.email).join(", ")}
                </li>
              ))}
            </ul>
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
                  {/* A name shared with somebody else is not a label, it is a
                      riddle: this list showed three badges all reading "Nora
                      New". When the name doesn't identify the person, the
                      address that does goes on the badge. */}
                  {p.full_name || p.email}
                  {p.full_name && duplicateIdentity(p) && (
                    <span style={{ opacity: 0.7 }}> · {p.email}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Export is admin-only by a decision written down in lib/aws/roles.js:
            the CSV is the bulk-PII egress path for the whole company. */}
        {period !== "all" && exporter && (
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

        {/* Files (the stored source documents) and Admin revisions (the
            correction trail) are reviewer-only, and not just visually:
            app/admin/page.js does not fetch either one for a non-reviewer, and
            lib/aws/data.js would refuse ts_admin_edits anyway. Rendering the
            tabs would show HR two permanently empty tables that look like
            "no documents exist" rather than "not yours to see". */}
        <div className="tabs">
          {[["submissions", "Submissions"], ["employees", "Employees"],
            ...(reviewer ? [["files", "Files"], ["revisions", "Admin revisions"]] : []),
           ].map(([k, tabLabel]) => (
            /* <button>, not <div onClick>: as divs these carried no tabIndex,
               no role and no key handler, so three of the four admin sections
               were unreachable without a mouse. The same .tab class is already
               an <a href> in Topbar. */
            <button type="button" key={k} aria-current={tab === k ? "page" : undefined}
                    className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
              {tabLabel}
              {k === "revisions" && pAdminEdits.length > 0 && <span className="badge gray" style={{ marginLeft: 6 }}>{pAdminEdits.length}</span>}
            </button>
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
                    {/* The word on the button is a promise about what opens.
                        An HR user gets the read-only panel, so it must not say
                        "Review" — that is the one thing they cannot do here. */}
                    <button className="btn btn-ghost btn-sm" onClick={() => setDetail(e)}>
                      {isReplaced || !reviewer ? "View" : "Review"}
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
                {/* Spell the role the person actually has. The old ternary
                    printed "employee" for anything that wasn't "admin", so an
                    HR user — who can file timesheets in other people's names —
                    was listed here as an ordinary employee. */}
                <td>{p.role === "admin" ? <span className="badge purple">admin</span>
                   : p.role === "hr" ? <span className="badge amber">HR</span>
                   : <span className="badge gray">employee</span>}</td>
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

      {detail && (
        <SubmissionDetail
          edit={detail} profile={pmap[detail.user_id] || {}} adminProfile={profile}
          reviewer={pmap[detail.reviewed_by] || null}
          /* WHO reviewed it (above) vs MAY I review it (below) — two different
             questions that were one word apart, so the second one is named for
             the decision it gates. */
          canDecide={reviewer}
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

function SubmissionDetail({ edit, profile, adminProfile, reviewer, canDecide, sourceFile, api, onClose, onSaved }) {
  // `days` is the heavy part of a submission (one entry per calendar day), so
  // the list query no longer carries it. Fetch it for just this submission.
  //
  // THE GRID OF RECORD IS `final_days` ONCE A CORRECTION EXISTS. `days` is the
  // employee's original submission and never changes; final_days is the grid the
  // paid final_total was summed from (/api/admin/review). Showing `days` after a
  // correction put the pre-correction hours back on screen under a corrected
  // total — and, because this grid is exactly what the next save posts back, the
  // next correction was summed from those stale hours and silently reverted the
  // previous one.
  const gridOf = (e) => (Array.isArray(e?.final_days) ? e.final_days : e?.days);
  const [days, setDays] = useState(gridOf(edit) || []);
  const [baseDays, setBaseDays] = useState(JSON.stringify(gridOf(edit) || []));
  const [loadingDays, setLoadingDays] = useState(!gridOf(edit));
  useEffect(() => {
    if (gridOf(edit)) return;
    let alive = true;
    api.from("ts_employee_edits").select("days,final_days,questionnaire").eq("id", edit.id).single()
      .then(({ data }) => {
        if (!alive) return;
        setDays(gridOf(data) || []);
        setBaseDays(JSON.stringify(gridOf(data) || []));
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
  const dialogRef = useDialogKeys(onClose);
  // Some documents only provide SUMMARY totals (weekly rows / a stated month
  // total) with no per-day breakdown -- their day grid is empty, so recomputing
  // from days would wrongly show 0. Fall back to the totals stored at
  // extraction time, and never clobber them with zeros on an admin save.
  const dayR = rollup(days);
  const submitted = edit.fields?.totals || {};
  const summaryOnly = !loadingDays && dayR.total === 0 && Number(submitted.total) > 0;
  // A summary-only document has no grid to roll up, so its figures come from the
  // row — and the row's figures are the CORRECTED ones when a correction exists.
  // Reading only fields.totals here showed the admin the employee's original
  // numbers on a submission payroll was already paying a corrected amount for,
  // and seeded the correction box with them.
  const stored = edit.final_total != null
    ? { regular: edit.final_regular, overtime: edit.final_overtime,
        // Paid-but-not-worked hours are part of the total, so a screen that shows
        // the total must show them too — otherwise the reviewer signs off "2 + 0 =
        // 10". Corrected rows before final_other existed have to fall back to the
        // residual, exactly as the payroll export does.
        other: edit.final_other ?? (Number(edit.final_total) - Number(edit.final_regular || 0)
                                                            - Number(edit.final_overtime || 0)),
        total: edit.final_total,
        daysWorked: submitted.daysWorked ?? submitted.days_worked }
    : submitted;
  const storedView = {
    regular: Number(stored.regular ?? stored.total ?? 0),
    overtime: Number(stored.overtime ?? 0),
    other: Number(stored.other ?? 0),
    total: Number(stored.total ?? 0),
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
  // YOUR OWN TIMESHEET. An admin can file their own hours (the "myself" option
  // in the Add-timesheet modal, or the ordinary employee dashboard), and the row
  // lands in the very queue this console renders. /api/admin/review REFUSES to
  // review it (lib/aws/roles.js isSelfReview) — that refusal is the control, and
  // it holds against curl. This is only so the buttons that would call it aren't
  // sitting there waiting to fail: an approve button that always errors teaches
  // an admin the console is broken, not that the rule exists.
  const isOwnSubmission =
    !!adminProfile?.id && String(adminProfile.id) === String(edit.user_id);
  // Same effect as "replaced" on every editing control: read-only.
  // ...and the third reason a panel is read-only: THE VIEWER MAY NOT DECIDE AT
  // ALL. An HR user reaches this console to file hours and to see who still
  // owes a timesheet; approving, rejecting and correcting are an admin's
  // (lib/aws/roles.js), and /api/admin/review refuses HR on the server. Folding
  // it into `locked` rather than adding a second read-only flag is deliberate:
  // one variable disables the day grid, the correction inputs, the note and all
  // four decision buttons, so a control cannot be added later and be caught by
  // only one of the two.
  const locked = isReplaced || isOwnSubmission || !canDecide;
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
        // Without this the revision trail records a total it cannot explain —
        // the same gap the payroll CSV had, preserved forever in the audit row
        // an auditor would use to check the CSV against.
        other: submission?.final_other ?? r.other ?? 0,
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
      <div className={"modal " + (preview && sourceFile ? "modal-split" : "wide")}
           ref={dialogRef} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true"
           aria-label={`${profile.full_name || edit.fields?.employee_name} · ${periodLabel(edit.month, edit.year)}`}>
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
            <button className="x" onClick={onClose} aria-label="Close">×</button>
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
          {isOwnSubmission && !isReplaced && (
            <div className="alert warn" style={{ marginBottom: 14 }}>
              This is <b>your own timesheet</b>. Whoever files hours must not be the one who signs
              them off, so you can’t approve, reject or correct it — <b>another admin</b> has to.
              Until one does, it stays out of the payroll export like any unreviewed submission.
            </div>
          )}
          {/* Say WHY it is read-only. A panel with no buttons and no sentence
              reads as a bug; the same rule that stops HR approving what HR typed
              is the reason this one is a viewer. */}
          {!canDecide && !isReplaced && !isOwnSubmission && (
            <div className="alert info" style={{ marginBottom: 14 }}>
              You’re viewing this submission. Approving, rejecting and correcting payroll figures
              are an <b>admin’s</b> — whoever files hours must not be the one who signs them off.
            </div>
          )}
          {enteredByAdmin(edit) && (
            <div className="alert info" style={{ marginBottom: 14 }}>
              Filed by <b>{edit.fields.entry.by_name || edit.fields.entry.by_email}</b> on the
              employee’s behalf{edit.fields.entry.at ? ` on ${fmt(edit.fields.entry.at)}` : ""}
              {edit.fields.entry.note ? ` — “${edit.fields.entry.note}”` : ""}.
            </div>
          )}

          <div className={"tiles" + (Number(r.other) > 0 ? " tiles-5" : "")} style={{ marginBottom: 16 }}>
            <div className="tile reg"><div className="v">{r.regular}</div><div className="l">Regular</div></div>
            <div className="tile ot"><div className="v">{r.overtime}</div><div className="l">Overtime</div></div>
            {/* Same reason as the entry preview: this is the screen where the
                hours are signed off, and Regular + Overtime does not equal Total
                on any submission carrying holiday pay, PTO or sick time. */}
            {Number(r.other) > 0 ? (
              <div className="tile"><div className="v">{r.other}</div>
                <div className="l">Other (paid, not worked)</div></div>
            ) : null}
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
              {!locked && (
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
            Calendar{locked ? "" : " — click a day to correct as admin"}
          </h3>
          <Calendar calendar={days} month={edit.month} year={edit.year}
                    onDayClick={locked ? () => {} : setDayIdx} />

          {/* The decision controls carry the only Close button, so a read-only
              panel needs its own — leaving just the × means the way out of a
              payroll record is an unlabelled glyph. */}
          {locked && (
            <div className="between" style={{ marginTop: 16 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                Read-only — nothing on this panel changes the record.
              </span>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          )}

          {!locked && (
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
            /* pv-err / pv-link: the two colours here were hard-coded per call
               site and both missed AA on this pane's slate. A <button> because
               this link is the only way out of a preview that didn't render. */
            <div className="pv-err" style={{ textAlign: "center", padding: 40, fontSize: 13 }}>
              Couldn’t render preview: {err}<br />
              <button type="button" className="pv-link" onClick={openOriginal}>Open the original ↗</button>
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
              <button type="button" className="btn btn-ghost btn-sm" onClick={openOriginal}>Open original ↗</button>
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
    /* tbl-wrap is the class the mobile table treatment (momentum scrolling) was
       written for; it had never been applied anywhere, and the horizontal scroll
       was coming from an inline overflow instead. */
    <div className="card tbl-wrap">
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
