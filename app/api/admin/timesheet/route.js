import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { pool } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";
// THE hours formula and its bounds — imported, not re-typed. This route used to
// carry its own copy of the summation, which is how it also carried its own copy
// of the missing sanity check: days of [{regular:100},{regular:-40}] netted to a
// plausible-looking 60h and were filed against an employee who never saw them.
import { deriveTotalsStrict, HoursRangeError } from "@/lib/hours";
import { canFileForOthers, canReview, isSelfFiling } from "@/lib/aws/roles";
import { createPersonTx, normalisePerson, DuplicateEmailError,
         DuplicateEmployeeCodeError, NamesakeError, PersonInputError } from "@/lib/aws/people";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// ADMIN OR HR ENTERS A TIMESHEET — for themselves, for somebody on the roster,
// or for somebody who is not on it yet.
//
//   for:"self"      the caller's own hours
//   for:"existing"  a person already registered (the default, and what every
//                   pre-existing caller sends: employeeUserId with no `for`)
//   for:"new"       a person registered by THIS request, in THIS transaction
//
// Ordinary employees get 403 on all three; their own hours go through /api/data.
//
// TWO THINGS THAT ARE NOT UNIFORM ACROSS THE THREE MODES, both deliberate:
//
// 1. WHO THE ROW SAYS ENTERED IT. `fields.entry.origin` is what the payroll CSV
//    prints as "entered by admin" vs "employee" and what the console renders as
//    the "filed on the employee's behalf" chip. A self-filing is NOT on anyone's
//    behalf, so it is stamped origin:"self" and reads out as an ordinary
//    employee submission — which is exactly what it is.
//
// 2. WHAT STATUS THE ROW LANDS IN. See the `status` block below; the short
//    version is that nobody approves their own wages, and HR does not approve.
//
// ADMIN ENTERS A TIMESHEET ON BEHALF OF AN EMPLOYEE.
//
// This CANNOT go through /api/data. lib/aws/data.js forces the owner column to
// the authenticated user on every write (cleanValues: `out[cfg.owner] = user.id`),
// so an admin POSTing ts_employee_edits with someone else's user_id silently
// files the hours against THEMSELVES. That rule is what stands between an
// employee and another person's payroll record and must not be relaxed; the
// admin path goes around it here instead, in a server-only, admin-only route.
//
// What is preserved from the /api/data contract:
//   * hours are DERIVED SERVER-SIDE from `days` — totals are never accepted
//     from the client (same rule, same formula as data.js deriveTotals and
//     lib/engine.js rollup);
//   * jsonb columns are JSON.stringify'd before binding;
//   * ts_employee_edits stays append-only — this INSERTs a new row. The only
//     UPDATE it issues is the same status='superseded' bookkeeping the database
//     trigger ts_supersede_prior_submissions already performs.
//
// DOUBLE-COUNT SAFETY: before inserting, every non-superseded row for that
// (employee, year, month) is locked FOR UPDATE and superseded — and if one
// exists the caller must have explicitly asked for it (`supersede: true`), so
// an admin can never blind-overwrite an employee's own pending submission.
// The DB trigger only supersedes rows in status 'submitted'; this closes the
// approved/rejected gap the trigger deliberately leaves open. The payroll
// export (app/api/admin/export/route.js) additionally refuses to emit a CSV if
// any employee somehow ends up with two approved rows in one period.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (msg, status = 400) => NextResponse.json({ error: msg }, { status });

export async function POST(request) {
  // Admin OR HR, re-checked HERE on the server. currentUser() re-reads the role
  // from the database on every call, so hiding the button is not the control —
  // and a still-valid 7-day cookie belonging to someone demoted this morning
  // does not carry the old role past this line.
  const user = await currentUser();
  if (!user) return bad("not authenticated", 401);
  if (!canFileForOthers(user)) return bad("forbidden", 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return bad("invalid body");

  // Back-compatible: every caller that predates this change sends employeeUserId
  // and no `for`, and lands in "existing" — the path already verified end-to-end.
  const MODES = ["self", "existing", "new"];
  const mode = MODES.includes(body.for) ? body.for
             : (body.newPerson ? "new" : "existing");

  const year = parseInt(body.year, 10);
  const month = parseInt(body.month, 10);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const supersede = body.supersede === true;

  // The target is resolved from the MODE, never from whatever id the client also
  // happened to attach: `for:"self"` files against the session's own user id, so
  // a caller cannot send {for:"self", employeeUserId:<somebody else>} and have
  // the relaxed self-filing rules applied to another person's payroll record.
  const employeeUserId = mode === "self" ? user.id : String(body.employeeUserId || "");
  if (mode === "existing" && !UUID.test(employeeUserId)) return bad("pick an employee");

  // ...AND "IS THIS MY OWN TIMESHEET?" IS ANSWERED BY THE RESOLVED TARGET,
  // not by the mode. Everything downstream hangs off this flag — the status the
  // row lands in, the origin stamp, whether a note is demanded, whether an
  // on-behalf row is written to ts_admin_edits — and reading it off the mode
  // meant {for:"existing", employeeUserId:<the caller's own id>} took the
  // on-behalf branch: an admin's own hours filed straight to 'approved', with
  // reviewed_by set to themselves, in ONE request and with no review at all.
  // (mode "new" can never be self: that person did not exist a moment ago.)
  const forSelf = isSelfFiling(user, employeeUserId);
  if (!year || year < 2000 || year > 2100) return bad("year is out of range");
  if (!month || month < 1 || month > 12) return bad("month must be 1-12");
  // The note is the ONLY human record of why hours nobody self-reported exist.
  // It is therefore required when filing for SOMEONE ELSE, and not when filing
  // your own: an employee submitting their own month through /api/data explains
  // nothing either, and demanding a justification from an admin for their own
  // hours would only train people to type "." to get past it.
  if (!forSelf && note.length < 3) {
    return bad("a note is required — say why you are filing this on the employee's behalf");
  }
  if (!Array.isArray(body.days)) {
    return bad("'days' is required — totals are derived server-side, not accepted from the client");
  }
  const days = body.days;
  if (days.length > 40) return bad("too many day entries for one month");

  let totals;
  try {
    totals = deriveTotalsStrict(days);
  } catch (e) {
    if (e instanceof HoursRangeError) return bad(e.problems.join(" "));
    throw e;
  }
  if (totals.total <= 0) {
    return bad("this timesheet has no hours on any day — nothing to file");
  }

  // Shape-check the new person BEFORE opening a transaction, so a typo'd email
  // is a plain 400 rather than a rolled-back write. The value is carried through
  // rather than re-read later: normalisePerson is idempotent (it emits the same
  // keys it accepts), so the create below re-validates exactly this object.
  let newPerson = null;
  if (mode === "new") {
    try {
      newPerson = normalisePerson(body.newPerson);
    } catch (e) {
      if (e instanceof PersonInputError) return bad(e.message, 400);
      throw e;
    }
    // The document would have to have been uploaded under a user id that did not
    // exist when the upload happened. Say so, instead of failing the ownership
    // check further down with "not stored under that employee".
    if (body.file && typeof body.file === "object" && body.file.path) {
      return bad("attach the document after the person is registered — it can't be filed under an id that didn't exist yet");
    }
  }

  const client = await pool().connect();
  let result;
  let createdPerson = null;
  // Declared out here because the log line and the audit entry after the
  // transaction both name the person the hours were filed against.
  let targetUserId = employeeUserId;
  try {
    await client.query("begin");

    // ---- register the person, IN THIS TRANSACTION -------------------------
    // This is what makes "add Jane and file her October" one act. If any
    // statement below throws — a bad day grid, a supersede conflict, a dropped
    // connection — the rollback takes Jane with it. There is no orphaned
    // half-person for the next admin to find, wonder about, and add again.
    if (mode === "new") {
      createdPerson = await createPersonTx(client, newPerson);
      targetUserId = createdPerson.id;
    }

    // ---- the employee must exist, be an employee record, and be active ----
    const prof = (await client.query(
      `select p.id, p.email, p.full_name, p.role, p.client, p.employee_code,
              coalesce(p.active, true) as active
         from public.ts_profiles p
        where p.id = $1
        for update`,
      [targetUserId]
    )).rows[0];
    if (!prof) {
      await client.query("rollback");
      // Same 404 either way, but not the same sentence: "that employee no longer
      // exists" about YOUR OWN account sends an admin looking for a deleted
      // colleague instead of at the real fault, which is a login with no
      // ts_profiles row — the exact split-account state signup's transaction
      // exists to prevent, and which payroll reporting is keyed on.
      return bad(
        forSelf
          ? "your own staff profile is missing, so there is nothing to file hours against — an administrator needs to repair your account"
          : "that employee no longer exists",
        404
      );
    }
    if (prof.active === false) {
      await client.query("rollback");
      return bad(
        forSelf
          ? "your account is deactivated — you can't file hours for yourself"
          : "that employee is deactivated — reactivate them before filing hours",
        409
      );
    }

    // The filer's own display name. When filing for yourself this is the same
    // row as `prof`, so it is only looked up separately in the on-behalf case.
    const adminProf = forSelf ? prof : (await client.query(
      `select full_name from public.ts_profiles where id = $1`, [user.id]
    )).rows[0];
    const adminName = adminProf?.full_name || user.email;

    // ---- at most ONE current row per employee+period ----------------------
    // Locked FOR UPDATE so a concurrent employee submission cannot slip a
    // second current row in between this check and the insert.
    const existing = (await client.query(
      `select id, status, created_at
         from public.ts_employee_edits
        where user_id = $1 and year = $2 and month = $3 and status <> 'superseded'
        for update`,
      [targetUserId, year, month]
    )).rows;
    if (existing.length > 0 && !supersede) {
      await client.query("rollback");
      return NextResponse.json(
        {
          error: "This employee already has a timesheet for that month.",
          needsSupersede: true,
          existing: existing.map((e) => ({ id: e.id, status: e.status, created_at: e.created_at })),
        },
        { status: 409 }
      );
    }
    if (existing.length > 0) {
      await client.query(
        `update public.ts_employee_edits set status = 'superseded'
          where id = any($1::uuid[])`,
        [existing.map((e) => e.id)]
      );
    }

    // ---- optional source document -----------------------------------------
    // The S3 object lives under the EMPLOYEE's prefix (/api/storage/upload
    // already lets an admin write there), so the employee can still read their
    // own document and per-employee retention stays coherent.
    let fileId = null;
    const f = body.file;
    if (f && typeof f === "object" && f.path) {
      const path = String(f.path);
      if (path.includes("..") || !path.startsWith(`${targetUserId}/`)) {
        await client.query("rollback");
        return bad("the attached document is not stored under that employee");
      }
      fileId = (await client.query(
        `insert into public.ts_files
           (user_id, month, year, file_name, storage_path, mime_type, size_bytes, status)
         values ($1,$2,$3,$4,$5,$6,$7,'processed')
         returning id`,
        [targetUserId, month, year, String(f.name || "document"), path,
         f.mime ? String(f.mime) : null, Number(f.size) || null]
      )).rows[0]?.id || null;
    }

    // ---- baseline timesheet: THE HOURS MUST FOLLOW THE FILING OF RECORD ----
    // ts_timesheets is unique on (user_id, year, month) — it is the ONE row for
    // this employee-month, and its `days` / monthly_* are hours. lib/aws/data.js
    // treats it as a MONEY_TABLE and re-derives those columns from `days` on
    // every write for exactly that reason.
    //
    // This used to refresh only the identity columns on conflict, on the theory
    // that the row was "the employee's own baseline" and must never be
    // clobbered. That left the row asserting the hours of a filing that this
    // very transaction has just SUPERSEDED: a re-filing correcting 180h down to
    // 40h wrote 40h into ts_employee_edits (what payroll pays) and left 180h
    // over a 22-day grid sitting here. Nothing pays this table, but the
    // employee's dashboard resumes an unfinished timesheet FROM row.days
    // (components/DashboardClient.js resumeDraft), so the stale grid came back
    // as a live resume card offering 180h for a month already approved at 40h —
    // and submitting it filed a competing row against an approved period.
    //
    // So the hours columns now follow the filing: derived, in this request, from
    // the same `days` written to ts_employee_edits below. Provenance is NOT lost
    // — every previous version survives in the append-only ts_employee_edits and
    // ts_admin_edits rows, which is where an auditor reads history from.
    //   * identity columns still only FILL IN blanks — an admin filing hours
    //     must not rename an employee or move them to another client;
    //   * file_id: the document attached to THIS filing wins if one was given,
    //     otherwise the existing one is kept, so the row never points at the
    //     superseded filing's document while carrying the new filing's hours;
    //   * ai_status/ai_confidence: these hours were typed by an admin, not read
    //     from a document, so an extraction confidence left over from a
    //     different day grid would be a lie about the numbers now in the row;
    //   * draft: the period is filed. Leaving a draft blob here re-offers the
    //     employee a resume card whose hours are now these hours — and lets them
    //     submit against an approved period. The mandatory note on this filing is
    //     the record of why their in-progress version was replaced.
    const bodyFields = (body.fields && typeof body.fields === "object") ? body.fields : {};
    const tsId = (await client.query(
      `insert into public.ts_timesheets as t
         (user_id, file_id, month, year, employee_name, employee_id, client,
          days, questionnaire, validation,
          monthly_regular, monthly_overtime, monthly_total, days_worked, ai_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,'manual')
       on conflict (user_id, year, month) do update
          set employee_name    = coalesce(t.employee_name, excluded.employee_name),
              employee_id      = coalesce(t.employee_id,   excluded.employee_id),
              client           = coalesce(t.client,        excluded.client),
              file_id          = coalesce(excluded.file_id, t.file_id),
              days             = excluded.days,
              monthly_regular  = excluded.monthly_regular,
              monthly_overtime = excluded.monthly_overtime,
              monthly_total    = excluded.monthly_total,
              days_worked      = excluded.days_worked,
              ai_status        = excluded.ai_status,
              ai_confidence    = null,
              draft            = null
       returning id`,
      [targetUserId, fileId, month, year,
       prof.full_name || bodyFields.employee_name || null,
       prof.employee_code || bodyFields.employee_id || null,
       bodyFields.client || prof.client || null,
       JSON.stringify(days),
       JSON.stringify(body.questionnaire && typeof body.questionnaire === "object" ? body.questionnaire : {}),
       totals.regular, totals.overtime, totals.total, totals.daysWorked]
    )).rows[0].id;

    // ---- the record of record ---------------------------------------------
    // ts_employee_edits, NOT ts_admin_edits: the export, the tiles, the buckets
    // and the employee's own dashboard all read this table. Filing the row
    // anywhere else would mean a dedupe rule between two tables, and that rule
    // is exactly where a double-payment bug would live.
    //
    // WHAT STATUS THIS LANDS IN — the one decision on this route that moves
    // money, so it is spelled out rather than left as a literal in the SQL.
    //
    //   admin, on someone else's behalf -> 'approved'   (UNCHANGED)
    //       There is no second party to review it: the admin authored it and is
    //       the approver. The controls that make that acceptable are the
    //       mandatory note, the provenance stamp, and the audit entry.
    //
    //   ANYONE filing for THEMSELVES  -> 'submitted'
    //       An admin's own wages are still somebody's wages. Auto-approving them
    //       would mean the only timesheet in the system nobody ever reviews is
    //       the one belonging to the person who can approve timesheets. It goes
    //       into the same review queue as every employee's own submission,
    //       because that is precisely what it is.
    //
    //   hr, on someone else's behalf  -> 'submitted'
    //       HR may enter hours; HR may not approve them (lib/aws/roles.js). If an
    //       HR filing landed 'approved' it would be HR signing off payroll
    //       through the side door — the approval power they were not granted,
    //       obtained by writing the word into a row instead of by calling
    //       /api/admin/review. Maker and checker stay two different people.
    const approved = !forSelf && canReview(user);
    const status = approved ? "approved" : "submitted";

    // WHAT THE ROW SAYS ABOUT WHO ENTERED IT.
    // origin is read by the payroll CSV (app/api/admin/export/route.js prints
    // "entered by admin" for "admin" and "employee" for anything else) and by the
    // console's "filed on the employee's behalf" chip. So a self-filing must NOT
    // say "admin": it was not filed on anyone's behalf, and labelling it that way
    // would put a name in the CSV's "Entered by" column for a timesheet whose
    // subject and author are one person — an on-behalf entry that never happened.
    // `by_role` records which privileged role actually did it, so an HR filing is
    // distinguishable from an admin one without changing what `origin` means to
    // the existing readers.
    const fields = {
      ...bodyFields,
      employee_name: prof.full_name || bodyFields.employee_name || null,
      employee_id: prof.employee_code || bodyFields.employee_id || null,
      client: bodyFields.client || prof.client || null,
      totals,                 // server-derived; the client's numbers are ignored
      review_status: null,    // no AI ran — this is not an extraction
      flow: null,
      agent_trace: null,
      entry: {
        origin: forSelf ? "self" : "admin",
        by_id: user.id,
        by_email: user.email,
        by_name: adminName,
        by_role: user.role,
        at: new Date().toISOString(),
        note,
        ...(createdPerson ? { created_person: true } : {}),
      },
    };
    // reviewed_by/reviewed_at are the record of a REVIEW HAVING HAPPENED. They
    // are stamped only on the 'approved' branch; a 'submitted' row carrying a
    // reviewer would claim an approval that no one has given yet, and
    // /api/admin/review would later overwrite it with the real one.
    const edit = (await client.query(
      `insert into public.ts_employee_edits
         (timesheet_id, user_id, month, year, fields, days, questionnaire, validation,
          submitted, status, reviewed_by, reviewed_at, review_note,
          final_regular, final_overtime, final_total)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,
               true,$9,$10,$11,$12,null,null,null)
       returning id, status, created_at`,
      [tsId, targetUserId, month, year,
       JSON.stringify(fields), JSON.stringify(days),
       JSON.stringify(body.questionnaire && typeof body.questionnaire === "object" ? body.questionnaire : {}),
       JSON.stringify({ errors: [], warnings: [], source: forSelf ? "self_entry" : "admin_entry" }),
       status,
       approved ? user.id : null,
       approved ? new Date().toISOString() : null,
       approved ? note : null]
    )).rows[0];

    // ---- append-only human trail ------------------------------------------
    // ts_admin_edits carries BOTH identities (employee_user_id + admin_user_id)
    // and is rendered unchanged by the console's "Admin revisions" tab.
    //
    // SELF-FILINGS ARE NOT WRITTEN HERE, and that is not an omission. Every row
    // in this table means "this privileged user touched THAT person's record";
    // the tab renders each one as "filed on the employee's behalf". A row whose
    // two identity columns are the same uuid would render as an admin acting on
    // an employee who is themselves — inventing an on-behalf event that never
    // happened and padding the oversight trail with entries nobody needs to
    // review. The self-filing is still fully recorded: the ts_employee_edits row
    // with its origin:"self" stamp, the console log below, and the ts_audit_log
    // entry — the same trail an ordinary employee's submission leaves.
    if (!forSelf) {
      await client.query(
        `insert into public.ts_admin_edits
           (timesheet_id, employee_user_id, admin_user_id, month, year,
            fields, days, questionnaire, validation, note)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
        [tsId, targetUserId, user.id, month, year,
         JSON.stringify(fields), JSON.stringify(days),
         JSON.stringify(body.questionnaire && typeof body.questionnaire === "object" ? body.questionnaire : {}),
         JSON.stringify({ errors: [], warnings: [], source: "admin_entry" }),
         (createdPerson ? `Registered this person and filed on their behalf — ${note}`
                        : `Filed on behalf of the employee — ${note}`)]
      );
    }

    await client.query("commit");
    result = { editId: edit.id, timesheetId: tsId, fileId, totals,
               superseded: existing.length, status: edit.status, mode };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    // The rollback above is what un-creates a person registered earlier in this
    // same transaction, so these two are honest: nothing at all was written.
    if (e instanceof DuplicateEmailError) {
      console.warn(`[admin/timesheet] ${user.email} tried to register an existing email:`, e.email);
      return NextResponse.json(
        { error: e.message, duplicateEmail: e.email,
          hint: "That person is already registered — pick them from the list instead of adding them again." },
        { status: 409 }
      );
    }
    // Same 409 shape, same reason as the email clash: employee_code is what a
    // payroll import matches people on, so a second record carrying an existing
    // one is a second payslip against that code. The rollback above means the
    // timesheet did not land either — nothing at all was written.
    if (e instanceof DuplicateEmployeeCodeError) {
      console.warn(`[admin/timesheet] ${user.email} tried to reuse employee code:`, e.code);
      return NextResponse.json(
        { error: e.message, duplicateEmployeeCode: e.code,
          hint: "If that is the same person, pick them from the list instead. If it is somebody else, give them their own code." },
        { status: 409 }
      );
    }
    // NOT a refusal — the question described on NamesakeError. The whole filing
    // is rolled back and the admin re-sends it with the answer; nothing has been
    // half-written while they decide.
    if (e instanceof NamesakeError) {
      console.warn(`[admin/timesheet] ${user.email} is adding a second “${e.personName}” — asking first`);
      return NextResponse.json(
        { error: e.message, needsDistinctConfirmation: true,
          sameName: e.matches.map((m) => ({ id: m.id, full_name: m.full_name, email: m.email,
                                            employee_code: m.employee_code, active: m.active })) },
        { status: 409 }
      );
    }
    if (e instanceof PersonInputError) return bad(e.message, 400);
    console.error("[admin/timesheet] failed, nothing was written:", e?.message || e);
    return bad(e?.message || "couldn't file this timesheet", 500);
  } finally {
    client.release();
  }

  console.info(
    `[admin/timesheet] ${user.email} (${user.role}) filed ${year}-${month} ` +
    `${forSelf ? "for THEMSELVES" : `for ${targetUserId}`} ` +
    `(${result.totals.total}h, status ${result.status}, superseded ${result.superseded})` +
    (createdPerson ? ` — registered ${createdPerson.email} as part of this filing` : "")
  );

  // Registering a person is a privileged act in its own right and gets its own
  // audit row, not a footnote on the timesheet one. It is emitted AFTER the
  // commit: audit() writes on a separate pooled connection, so logging it any
  // earlier could record a person that a later rollback then removed.
  if (createdPerson) {
    await audit({
      actor: user, action: "person.create", subjectId: createdPerson.id,
      detail: { email: createdPerson.email, full_name: createdPerson.full_name,
                employee_code: createdPerson.employee_code || null,
                role: createdPerson.role, by_role: user.role,
                login_enabled: false, via: "timesheet.create_for",
                // "Somebody of this name already exists" was raised and this
                // admin overruled it. Two real John Smiths must both be payable,
                // so the system cannot decide this — but it can make sure the
                // person who did decide it is named, timestamped and findable.
                confirmed_distinct_from_namesake: createdPerson.confirmed_distinct === true },
      ip: clientIp(request),
    });
  }
  await audit({
    actor: user,
    action: forSelf ? "timesheet.create_self" : "timesheet.create_for",
    subjectId: targetUserId,
    detail: {
      year, month, editId: result.editId, fileId: result.fileId,
      total: result.totals.total, regular: result.totals.regular,
      overtime: result.totals.overtime,
      origin: forSelf ? "self" : "admin", by_role: user.role,
      status: result.status, mode,
      createdPerson: createdPerson ? createdPerson.id : null,
      supersededRows: result.superseded, note,
    },
    ip: clientIp(request),
  });

  // `person` comes back so the UI can show WHO was actually created — the id
  // the hours went against and the normalised email — rather than echoing the
  // form the admin typed and hoping the two agree.
  return NextResponse.json({ ok: true, ...result, person: createdPerson });
}
