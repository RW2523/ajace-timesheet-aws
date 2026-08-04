import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { pool } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";

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

// THE hours formula, byte-for-byte the same summation as lib/engine.js rollup()
// and lib/aws/data.js deriveTotals(). `other` (sick/vacation/holiday) is paid
// time: it counts toward the total but must NOT inflate billable regular.
function deriveTotals(days) {
  let regular = 0, overtime = 0, other = 0, daysWorked = 0;
  for (const d of Array.isArray(days) ? days : []) {
    const reg = Number(d?.regular) || 0;
    const ot = Number(d?.overtime) || 0;
    const oth = Number(d?.other) || 0;
    regular += reg; overtime += ot; other += oth;
    if (reg + ot + oth > 0) daysWorked += 1;
  }
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  return {
    regular: r2(regular), overtime: r2(overtime), other: r2(other),
    total: r2(regular + overtime + other), daysWorked,
  };
}

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

  const totals = deriveTotals(days);
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

    // ---- baseline timesheet: FILL IN WHAT IS MISSING, never clobber --------
    // ts_timesheets is the employee's own baseline (file_id, ai_* metadata,
    // their extracted day grid). Overwriting it from here would destroy the
    // provenance of a document the employee uploaded themselves.
    const bodyFields = (body.fields && typeof body.fields === "object") ? body.fields : {};
    const tsId = (await client.query(
      `insert into public.ts_timesheets as t
         (user_id, file_id, month, year, employee_name, employee_id, client,
          days, questionnaire, validation,
          monthly_regular, monthly_overtime, monthly_total, days_worked, ai_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,'manual')
       on conflict (user_id, year, month) do update
          set employee_name = coalesce(t.employee_name, excluded.employee_name),
              employee_id   = coalesce(t.employee_id,   excluded.employee_id),
              client        = coalesce(t.client,        excluded.client),
              file_id       = coalesce(t.file_id,       excluded.file_id)
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
