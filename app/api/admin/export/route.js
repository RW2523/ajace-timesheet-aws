import { currentUser } from "@/lib/aws/auth";
import { query } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";
import { payableProblems } from "@/lib/hours";
// The same three identity keys the create-a-person door and the browser use.
// One definition of "the same human", or the gate here and the gate there
// disagree about which rows are the same person — see lib/roster.js.
import { codeKey, nameKey } from "@/lib/roster";
import { canExport } from "@/lib/aws/roles";

export const runtime = "nodejs";

// Payroll export: one row per employee for a period, as CSV.
// The hours exported are the NUMBERS OF RECORD — an admin correction
// (final_*) wins over what the employee submitted, which is the whole point of
// reviewing. Superseded submissions are excluded so a resubmission can never
// double-count.
//
// A timesheet an ADMIN filed on behalf of an employee (/api/admin/timesheet)
// lands in this same table, so it exports through this same query — with
// Origin/Entered by columns so whoever runs payroll can see hours the employee
// never self-reported.
const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Guard against CSV/formula injection when opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function GET(request) {
  const user = await currentUser();
  if (!user) return new Response("not authenticated", { status: 401 });
  if (!canExport(user)) return new Response("forbidden", { status: 403 });

  const sp = new URL(request.url).searchParams;
  const year = parseInt(sp.get("year") || "", 10);
  const month = parseInt(sp.get("month") || "", 10);
  if (!year || !month || month < 1 || month > 12) {
    return new Response("year and month are required", { status: 400 });
  }
  // Default to the numbers you'd actually pay: approved only.
  const approvedOnly = sp.get("all") !== "1";

  // LEFT JOIN, DELIBERATELY. This was an inner join on ts_profiles, so an
  // approved timesheet belonging to an account with no profile row vanished
  // from the file — no row, no warning, and a TOTAL quietly short by that
  // person's whole month. The export shouts about paying somebody twice; going
  // silent about not paying them at all is the same size of mistake, pointed the
  // other way. The submission is the payroll record; the profile is only
  // descriptive. Missing description is never a reason to drop hours, so the row
  // is emitted with whatever identity auth_users can still supply and flagged
  // loudly for the person running payroll.
  const rows = await query(
    `select coalesce(p.full_name, '') as full_name,
            coalesce(p.email, u.email) as email,
            p.employee_code, p.employer, p.client,
            (p.id is null) as profile_missing,
            e.user_id, e.year, e.month, e.status, e.created_at, e.reviewed_at, e.review_note,
            coalesce(e.final_regular,  (e.fields->'totals'->>'regular')::numeric)  as regular,
            coalesce(e.final_overtime, (e.fields->'totals'->>'overtime')::numeric) as overtime,
            -- PAID BUT NOT WORKED — holiday pay, PTO, sick. This is a THIRD hour
            -- bucket, not a subset of the two above: lib/hours.js sums
            -- regular + overtime + other into the total, has done since the
            -- extraction first produced it, and components/DayModal.js lets it be
            -- typed by hand. It had no column here, so a month of 2h regular and
            -- 8h holiday exported as "2, 0, 10" — an import that sums the hour
            -- columns underpaid by 8h, one that reads Total paid 10h, and nothing
            -- in the file explained the gap.
            --   corrected row  -> final_other, falling back to the residual for
            --                     rows corrected before final_other existed;
            --   uncorrected    -> what the submission itself recorded.
            -- The two branches never mix: reading a corrected total beside the
            -- SUBMITTED breakdown is how a row stops adding up.
            case when e.final_total is not null
                   then coalesce(e.final_other,
                                 e.final_total - coalesce(e.final_regular, 0)
                                               - coalesce(e.final_overtime, 0))
                   else coalesce((e.fields->'totals'->>'other')::numeric, 0)
            end as other,
            coalesce(e.final_total,    (e.fields->'totals'->>'total')::numeric)    as total,
            (e.final_total is not null) as corrected_by_admin,
            coalesce(e.fields->'entry'->>'origin', 'employee') as origin,
            coalesce(e.fields->'entry'->>'by_name', e.fields->'entry'->>'by_email') as entered_by,
            -- WHO SIGNED IT OFF. This was selected nowhere and printed nowhere,
            -- so the CSV said an approval had happened without ever saying whose
            -- it was — and a row an admin filed for themselves and then approved
            -- themselves was byte-for-byte identical to an ordinary employee's
            -- reviewed submission. The reviewer is half of "reviewed"; a payroll
            -- file that omits it is asking to be trusted rather than checked.
            coalesce(rp.full_name, ru.email) as reviewed_by_name,
            (e.reviewed_by is not null and e.reviewed_by = e.user_id) as self_reviewed
       from public.ts_employee_edits e
       join public.auth_users u on u.id = e.user_id
       left join public.ts_profiles p on p.id = e.user_id
       -- LEFT joins, same reasoning as the profile join above: an unreadable
       -- reviewer must never remove an approved row from payroll.
       left join public.auth_users  ru on ru.id = e.reviewed_by
       left join public.ts_profiles rp on rp.id = e.reviewed_by
      where e.year = $1 and e.month = $2
        and e.status <> 'superseded'
        and ($3 = false or e.status = 'approved')
      order by p.full_name nulls last, coalesce(p.email, u.email)`,
    [year, month, approvedOnly]
  );

  // ---- the overpayment assertion -----------------------------------------
  // Only approved rows are ever paid, and there must be exactly one per person
  // per period. Three things keep that true: the DB trigger supersedes a
  // resubmission, /api/admin/review supersedes every other current row when it
  // approves one, and /api/admin/timesheet supersedes before filing on an
  // employee's behalf. If a row somehow slips past all three, FAIL LOUDLY —
  // emitting a CSV that pays somebody twice is far worse than a blocked export.
  const seen = new Map();
  for (const r of rows) {
    if (r.status !== "approved") continue;
    seen.set(r.user_id, (seen.get(r.user_id) || 0) + 1);
  }
  const dupes = rows.filter((r) => r.status === "approved" && seen.get(r.user_id) > 1);
  if (dupes.length > 0) {
    const names = [...new Set(dupes.map((r) => r.full_name || r.email))];
    console.error(`[export] REFUSED ${year}-${month}: duplicate approved rows for ${names.join(", ")}`);
    await audit({ actor: user, action: "export.refused", detail: { year, month, duplicates: names },
                  ip: clientIp(request) });
    return new Response(
      `Export refused: ${names.join(", ")} ${names.length === 1 ? "has" : "have"} more than one ` +
      `APPROVED timesheet for ${year}-${String(month).padStart(2, "0")}. ` +
      `Paying this file would pay them twice. Open the admin console, decide which ` +
      `submission is the real one, and reject or replace the other.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // ---- the SAME-PERSON assertion ------------------------------------------
  // The assertion above counts approved rows per user_id. It is correct and it
  // is not enough: it asks "has this ACCOUNT been paid twice?", and the way one
  // human gets paid twice is by having two accounts.
  //
  // That happened. Three profiles were created for "Nora New" — nora.new@,
  // nora.new+payroll@ and nora.nеw@ (Cyrillic е) — all carrying employee_code
  // EC-NORA, one approved timesheet each. Three distinct user_ids, so the loop
  // above counted 1, 1, 1 and this file went out with 32 payable hours and three
  // payslips for one person.
  //
  // employee_code is the column the payroll import JOINS ON. Two people sharing
  // one is not a formatting problem, it is two rows the downstream system cannot
  // distinguish, so this REFUSES — the same call the double-approval check makes,
  // for the same reason: a blocked export costs an afternoon, a wrong one costs
  // somebody's wages.
  //
  // Registering people is now guarded at the door (lib/aws/people.js) and by a
  // unique index (deploy/db/schema.sql), but neither reaches backwards into rows
  // that already exist, and this is the last gate before the money leaves.
  const byCode = new Map();
  for (const r of rows) {
    if (r.status !== "approved") continue;
    const k = codeKey(r.employee_code);
    if (!k) continue;                       // no code: identity falls back to email, which is unique
    if (!byCode.has(k)) byCode.set(k, new Map());
    byCode.get(k).set(r.user_id, r);
  }
  const sharedCodes = [...byCode.entries()].filter(([, who]) => who.size > 1);
  if (sharedCodes.length > 0) {
    const detail = sharedCodes.map(([k, who]) =>
      `${[...who.values()][0].employee_code || k} is shared by ` +
      `${[...who.values()].map((r) => `${r.full_name || "(no name)"} <${r.email}>`).join(" and ")}`);
    console.error(`[export] REFUSED ${year}-${month}: shared employee codes — ${detail.join("; ")}`);
    await audit({ actor: user, action: "export.refused",
                  detail: { year, month, sharedEmployeeCodes: detail }, ip: clientIp(request) });
    return new Response(
      `Export refused for ${year}-${String(month).padStart(2, "0")}: ${detail.join("; ")}. ` +
      `Payroll matches people on their employee code, so it cannot tell these records apart — ` +
      `paying this file would pay one code more than once. If these are the same person, keep ` +
      `one record and reject the other timesheet. If they really are different people, give ` +
      `each of them their own employee code first.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // ---- the impossible-figure assertion ------------------------------------
  // The write paths now bound every payable number (lib/hours.js), but a fix to
  // a write path cannot reach backwards: rows stored before it exists are still
  // here, and a negative total in a payroll CSV is read downstream as a clawback
  // against somebody's wages. So the last gate before the money leaves checks
  // the figures it is about to print, exactly as it checks for double payment.
  const unreal = [];
  for (const r of rows) {
    if (r.status !== "approved") continue;
    const who = r.full_name || r.email;
    for (const [v, what] of [[r.regular, "regular hours"], [r.overtime, "overtime hours"],
                             [r.other, "other (paid, not worked) hours"],
                             [r.total, "total hours"]]) {
      for (const p of payableProblems(v, what)) unreal.push(`${who}: ${p}`);
    }
  }
  if (unreal.length > 0) {
    console.error(`[export] REFUSED ${year}-${month}: impossible figures — ${unreal.join("; ")}`);
    await audit({ actor: user, action: "export.refused",
                  detail: { year, month, impossible: unreal }, ip: clientIp(request) });
    return new Response(
      `Export refused for ${year}-${String(month).padStart(2, "0")}: ` +
      `${unreal.join("; ")}. These hours cannot be paid as they stand. Open the admin ` +
      `console and correct the submission before exporting.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const payable = (r) => r.status === "approved";

  // ---- the adding-up assertion --------------------------------------------
  // Every hour column in this file must account for the total beside it:
  //   Regular + Overtime + Other = Total.
  // Downstream payroll imports differ in which columns they read — some sum the
  // hour columns, some take the stated total — and a row where those two answers
  // disagree pays a different wage depending on which importer opens it. That is
  // not a formatting problem, it is two different amounts of money.
  //
  // Tolerance is one cent: each figure was rounded to 2dp independently
  // (lib/hours.js round2), so three rounded parts can miss a rounded sum by a
  // hundredth without anything being wrong. Anything larger is a row whose own
  // numbers contradict each other, and the answer is the same as for a duplicate
  // approval — refuse, and say which row and by how much. A wrong CSV is paid;
  // a refused one is fixed.
  const mismatched = [];
  for (const r of rows) {
    if (!payable(r)) continue;
    const parts = Number(r.regular || 0) + Number(r.overtime || 0) + Number(r.other || 0);
    const gap = Number(r.total || 0) - parts;
    if (Math.abs(gap) > 0.01) {
      mismatched.push(
        `${r.full_name || r.email}: regular ${Number(r.regular || 0)} + overtime ` +
        `${Number(r.overtime || 0)} + other ${Number(r.other || 0)} = ${Math.round(parts * 100) / 100}, ` +
        `but the total says ${Number(r.total || 0)} (${gap > 0 ? "+" : ""}${Math.round(gap * 100) / 100}h unaccounted for)`
      );
    }
  }
  if (mismatched.length > 0) {
    console.error(`[export] REFUSED ${year}-${month}: hours do not add up — ${mismatched.join("; ")}`);
    await audit({ actor: user, action: "export.refused",
                  detail: { year, month, notAddingUp: mismatched }, ip: clientIp(request) });
    return new Response(
      `Export refused for ${year}-${String(month).padStart(2, "0")}: the hour columns do not ` +
      `add up to the total being paid. ${mismatched.join("; ")}. Paying this file would pay a ` +
      `different amount depending on which columns the payroll import reads. Open the admin ` +
      `console and correct the submission before exporting.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // ---- the underpayment warning -------------------------------------------
  // Nothing here is dropped or blocked: the hours are real and they are in the
  // file. But a row with no profile has no employee code and no employer, so it
  // cannot be matched by a payroll import — it needs a human. Say so in the
  // file, in the server log, and in the audit trail.
  const orphans = rows.filter((r) => r.profile_missing && payable(r));
  if (orphans.length > 0) {
    const who = orphans.map((r) => r.email || r.user_id);
    console.error(
      `[export] ${year}-${month}: ${orphans.length} APPROVED timesheet(s) belong to accounts with ` +
      `no employee profile: ${who.join(", ")}. Exported and flagged — create their profiles before paying.`
    );
    await audit({ actor: user, action: "export.profile_missing",
                  detail: { year, month, accounts: who }, ip: clientIp(request) });
  }

  // ---- the self-approval warning ------------------------------------------
  // /api/admin/review now refuses to let anyone review their own submission
  // (lib/aws/roles.js isSelfReview), so no NEW row can reach this state. A fix
  // to a write path cannot reach backwards, though — exactly the reasoning the
  // impossible-figure assertion above is built on — and rows approved by their
  // own subject before that refusal existed are still sitting in the table.
  //
  // WARN, DO NOT REFUSE, and the difference is deliberate. A duplicate approved
  // row would pay somebody twice and impossible figures cannot be paid at all,
  // so those block the file. A self-approved row is hours that are probably
  // perfectly real; blocking the whole company's payroll over one of them is an
  // underpayment of everybody else, which this route already treats as the same
  // size of mistake pointed the other way. So it is paid, and it is impossible
  // to miss: named in the row's own Data warning column, in the server log, and
  // in the audit trail.
  const selfApproved = rows.filter((r) => r.self_reviewed && payable(r));
  if (selfApproved.length > 0) {
    const who = selfApproved.map((r) => r.full_name || r.email);
    console.error(
      `[export] ${year}-${month}: ${selfApproved.length} APPROVED timesheet(s) were signed off by ` +
      `their own subject: ${who.join(", ")}. Exported and flagged — have another admin re-check them.`
    );
    await audit({ actor: user, action: "export.self_approved",
                  detail: { year, month, people: who }, ip: clientIp(request) });
  }

  // ---- the same-name warning ----------------------------------------------
  // Two payable rows under one name. Unlike a shared employee code this is NOT
  // refused, and the difference is the whole judgement:
  //
  //   a shared employee CODE is always wrong — it is the payroll import's join
  //     key, and two people cannot have one;
  //   a shared NAME may be perfectly correct — there are two John Smiths in
  //     plenty of companies and both of them have to be paid.
  //
  // A control that blocks the whole company's payroll over a legitimate pair of
  // namesakes, with no way through, is a control that gets switched off. So the
  // file goes out and the ambiguity is made impossible to miss instead: the
  // Employee column carries the email that tells them apart, the row's own Data
  // warning says so, and the audit log records it. The place a duplicate PERSON
  // gets stopped is the door they are created at (lib/aws/people.js NamesakeError,
  // which asks the admin and records the answer) — not here, where all that is
  // left is deciding whether to pay real approved hours.
  const byName = new Map();
  for (const r of rows) {
    if (!payable(r)) continue;
    const k = nameKey(r.full_name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(r.user_id);
  }
  const ambiguousName = (r) => {
    const k = nameKey(r.full_name);
    return !!k && (byName.get(k)?.size || 0) > 1;
  };
  const namesakeRows = rows.filter((r) => payable(r) && ambiguousName(r));
  if (namesakeRows.length > 0) {
    const who = [...new Set(namesakeRows.map((r) => `${r.full_name} <${r.email}>`))];
    console.error(
      `[export] ${year}-${month}: ${namesakeRows.length} payable row(s) share a name with another ` +
      `person being paid this period: ${who.join(", ")}. Exported and flagged — confirm they are ` +
      `different people before paying.`
    );
    await audit({ actor: user, action: "export.same_name",
                  detail: { year, month, people: who }, ip: clientIp(request) });
  }

  // "Other hours" sits BETWEEN Overtime and Total, so the three hour columns are
  // adjacent and visibly sum to the column after them. It is named for what it
  // pays rather than for what the code calls it, because the person opening this
  // file is running payroll, not reading lib/hours.js.
  // The four hour headings are named ONCE and reused by the footer below, which
  // finds its columns by looking them up rather than by counting commas.
  // NO COMMA IN A HEADING. The heading row is a CSV row like any other, and a
  // heading of "Other hours (paid, not worked)" splits into two columns in every
  // naive parser — shifting every heading after it one place right, so "Total
  // hours" sits above Status and the file mislabels its own money columns.
  // (The row cells go through csvCell, which would have quoted it; the heading
  // row now does too, and the punctuation is avoided as well. Belt and braces:
  // this file is read by other people's importers, not just by Excel.)
  const H = { regular: "Regular hours", overtime: "Overtime hours",
              other: "Other hours (holiday/PTO/sick)", total: "Total hours" };
  const header = ["Employee","Email","Employee code","Employer","Client","Year","Month",
                  H.regular, H.overtime, H.other,
                  H.total,"Status","Payable",
                  "Origin","Entered by","Corrected by admin",
                  "Submitted at","Reviewed at","Reviewed by","Review note","Data warning"];
  const body = rows.map((r) => [
    // A name that belongs to two people being paid this month is not an
    // identifier, so it does not go in the identity column on its own — the
    // address that actually tells them apart goes with it. Three rows reading
    // "Nora New" are three rows a human checking the file cannot check.
    (r.full_name || (r.profile_missing ? `(no employee profile) ${r.email || r.user_id}` : "")) +
      (ambiguousName(r) ? ` <${r.email}>` : ""),
    r.email, r.employee_code, r.employer, r.client, r.year, r.month,
    r.regular ?? 0, r.overtime ?? 0, r.other ?? 0, r.total ?? 0,
    r.status, payable(r) ? "yes" : "no",
    r.origin === "admin" ? "entered by admin" : "employee",
    r.origin === "admin" ? (r.entered_by || "admin") : "",
    r.corrected_by_admin ? "yes" : "",
    r.created_at?.toISOString?.().slice(0, 19).replace("T", " ") ?? "",
    r.reviewed_at?.toISOString?.().slice(0, 19).replace("T", " ") ?? "",
    // "reviewed at 09:41" with no name is a timestamp, not an approval.
    r.reviewed_at ? (r.reviewed_by_name || "(reviewer account deleted)") : "",
    r.review_note,
    // Both warnings can be true of one row, so they are joined rather than
    // chosen between — an earlier ternary here would have hidden whichever one
    // lost.
    [
      r.profile_missing
        ? "NO EMPLOYEE PROFILE - hours are real; create this person's profile before paying"
        : "",
      r.self_reviewed
        ? "SELF-APPROVED - filed and signed off by the same person; have another admin re-check before paying"
        : "",
      ambiguousName(r)
        ? "SAME NAME AS ANOTHER PERSON PAID THIS PERIOD - confirm this is a different human, not a duplicate record, before paying"
        : "",
    ].filter(Boolean).join(" | "),
  ].map(csvCell).join(","));

  // The TOTAL only ever sums PAYABLE rows. The `all=1` export deliberately
  // includes rejected and still-pending submissions; summing those made the
  // footer larger than the payroll run it sat next to.
  const paidRows = rows.filter(payable);
  const sumOf = (k) => paidRows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const totalHours = sumOf("total");
  // The footer used to be a hand-counted run of commas (",,,,,,,,,"), which put
  // the grand total under whichever column happened to be tenth. It stopped
  // being "Total hours" the moment a column was inserted to its left, and a
  // payroll total sitting under an unrelated heading is read as that column's
  // sum. Derived from the header instead, so inserting a column moves it.
  //
  // EVERY hour column is footed, not just the total: a footer that filled in one
  // of three hour columns invites the reader to assume the blanks are zero, and
  // "regular 0, overtime 0, total 812.00" is the same lie the rows themselves
  // used to tell. Footed across, the summary line adds up the way each row does.
  const totalCol = header.indexOf(H.total);
  const footer = header.map((h, i) =>
    i === 0 ? (approvedOnly ? "TOTAL" : "TOTAL (approved only)")
    : i === header.indexOf(H.regular)  ? sumOf("regular").toFixed(2)
    : i === header.indexOf(H.overtime) ? sumOf("overtime").toFixed(2)
    : i === header.indexOf(H.other)    ? sumOf("other").toFixed(2)
    : i === totalCol ? totalHours.toFixed(2)
    : ""
  );
  const csv = [
    // Escaped like every other row: a heading is data too, and an unescaped one
    // carrying a comma or a quote silently re-columns the whole file.
    header.map(csvCell).join(","),
    ...body,
    "",
    // Trailing empties are trimmed so the footer looks like the one payroll has
    // always seen; the cells up to and including the total are all still there.
    footer.slice(0, totalCol + 1).map(csvCell).join(","),
  ].join("\r\n");

  const name = `timesheets-${year}-${String(month).padStart(2, "0")}${approvedOnly ? "-approved" : "-all"}.csv`;
  console.info(`[export] ${user.email} exported ${rows.length} row(s) for ${year}-${month}`);
  await audit({ actor: user, action: "export",
                detail: { year, month, rows: rows.length, payableRows: paidRows.length,
                          adminEntered: rows.filter((r) => r.origin === "admin").length,
                          profileMissingRows: orphans.length,
                          selfApprovedRows: selfApproved.length,
                          approvedOnly, totalHours },
                ip: clientIp(request) });
  return new Response("﻿" + csv, {   // BOM so Excel reads UTF-8 correctly
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
