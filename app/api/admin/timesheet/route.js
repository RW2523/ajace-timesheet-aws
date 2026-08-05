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

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
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
  // Admin-only, re-checked HERE on the server. currentUser() re-reads the role
  // from the database on every call, so hiding the button is not the control.
  const user = await currentUser();
  if (!user) return bad("not authenticated", 401);
  if (user.role !== "admin") return bad("forbidden", 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return bad("invalid body");

  const employeeUserId = String(body.employeeUserId || "");
  const year = parseInt(body.year, 10);
  const month = parseInt(body.month, 10);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const supersede = body.supersede === true;

  if (!UUID.test(employeeUserId)) return bad("pick an employee");
  if (!year || year < 2000 || year > 2100) return bad("year is out of range");
  if (!month || month < 1 || month > 12) return bad("month must be 1-12");
  // The note is the ONLY human record of why hours nobody self-reported exist.
  if (note.length < 3) {
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

  const client = await pool().connect();
  let result;
  try {
    await client.query("begin");

    // ---- the employee must exist, be an employee record, and be active ----
    const prof = (await client.query(
      `select p.id, p.email, p.full_name, p.role, p.client, p.employee_code,
              coalesce(p.active, true) as active
         from public.ts_profiles p
        where p.id = $1
        for update`,
      [employeeUserId]
    )).rows[0];
    if (!prof) { await client.query("rollback"); return bad("that employee no longer exists", 404); }
    if (prof.active === false) {
      await client.query("rollback");
      return bad("that employee is deactivated — reactivate them before filing hours", 409);
    }

    const adminProf = (await client.query(
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
      [employeeUserId, year, month]
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
      if (path.includes("..") || !path.startsWith(`${employeeUserId}/`)) {
        await client.query("rollback");
        return bad("the attached document is not stored under that employee");
      }
      fileId = (await client.query(
        `insert into public.ts_files
           (user_id, month, year, file_name, storage_path, mime_type, size_bytes, status)
         values ($1,$2,$3,$4,$5,$6,$7,'processed')
         returning id`,
        [employeeUserId, month, year, String(f.name || "document"), path,
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
      [employeeUserId, fileId, month, year,
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
    // Created 'approved': there is no second party to review it — the admin
    // authored it and is the approver. The controls that make that safe are the
    // mandatory note, the fields.entry provenance stamp (surfaced as an
    // "entered by admin" chip and as Origin/Entered by columns in the payroll
    // CSV), and the audit entry below.
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
        origin: "admin",
        by_id: user.id,
        by_email: user.email,
        by_name: adminName,
        at: new Date().toISOString(),
        note,
      },
    };
    const edit = (await client.query(
      `insert into public.ts_employee_edits
         (timesheet_id, user_id, month, year, fields, days, questionnaire, validation,
          submitted, status, reviewed_by, reviewed_at, review_note,
          final_regular, final_overtime, final_total)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,
               true,'approved',$9,now(),$10,null,null,null)
       returning id, status, created_at`,
      [tsId, employeeUserId, month, year,
       JSON.stringify(fields), JSON.stringify(days),
       JSON.stringify(body.questionnaire && typeof body.questionnaire === "object" ? body.questionnaire : {}),
       JSON.stringify({ errors: [], warnings: [], source: "admin_entry" }),
       user.id, note]
    )).rows[0];

    // ---- append-only human trail ------------------------------------------
    // ts_admin_edits carries BOTH identities (employee_user_id + admin_user_id)
    // and is rendered unchanged by the console's "Admin revisions" tab.
    await client.query(
      `insert into public.ts_admin_edits
         (timesheet_id, employee_user_id, admin_user_id, month, year,
          fields, days, questionnaire, validation, note)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
      [tsId, employeeUserId, user.id, month, year,
       JSON.stringify(fields), JSON.stringify(days),
       JSON.stringify(body.questionnaire && typeof body.questionnaire === "object" ? body.questionnaire : {}),
       JSON.stringify({ errors: [], warnings: [], source: "admin_entry" }),
       `Filed on behalf of the employee — ${note}`]
    );

    await client.query("commit");
    result = { editId: edit.id, timesheetId: tsId, fileId, totals, superseded: existing.length };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("[admin/timesheet] failed:", e?.message || e);
    return bad(e?.message || "couldn't file this timesheet", 500);
  } finally {
    client.release();
  }

  console.info(
    `[admin/timesheet] ${user.email} filed ${year}-${month} for ${employeeUserId} ` +
    `(${result.totals.total}h, superseded ${result.superseded})`
  );
  await audit({
    actor: user, action: "timesheet.create_for", subjectId: employeeUserId,
    detail: {
      year, month, editId: result.editId, fileId: result.fileId,
      total: result.totals.total, regular: result.totals.regular,
      overtime: result.totals.overtime, origin: "admin",
      supersededRows: result.superseded, note,
    },
    ip: clientIp(request),
  });

  return NextResponse.json({ ok: true, ...result });
}
