import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { pool } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";
// THE hours formula and its bounds (lib/hours.js), imported rather than re-typed.
// `deriveTotals` is the TOLERANT sum, used only to READ what is already stored —
// a row written before the bounds existed must stay openable so an admin can
// correct it. `deriveTotalsStrict` is what a CORRECTION goes through, because a
// final_total is the number that gets paid.
import {
  deriveTotals, deriveTotalsStrict, checkSummaryTotals, HoursRangeError, round2,
} from "@/lib/hours";

export const runtime = "nodejs";

// The ONLY way a submission's review state changes.
//
// Submissions stay append-only through /api/data (an employee can never rewrite
// a payroll record). Review is a separate, admin-only action that touches only
// review columns, so the employee's original submission is preserved verbatim
// alongside the decision and any corrected totals.
//
// CORRECTED HOURS ARE DERIVED HERE, SERVER-SIDE, FROM `days`.
// final_regular/final_overtime/final_total are what the payroll CSV actually
// pays (export/route.js coalesces them over the submitted totals). They used to
// be taken verbatim from the request body, which bypassed the invariant that
// lib/aws/data.js enforces for every other money-bearing write: a hand-crafted
// POST from any admin session could set the paid number to anything, with no
// `days` to justify it. Now the only accepted correction inputs are:
//   * `days` — the day grid; totals are summed from it (the normal path);
//   * `summaryTotals` — regular + overtime only, and ONLY for a submission that
//     genuinely has no per-day breakdown (a document that stated weekly or
//     monthly summary figures). `total` is still computed, never accepted.
//
// AND THE GRID IT WAS DERIVED FROM IS KEPT, in final_days. It used to be summed
// and thrown away: the row that says "pay 20 hours" still held the employee's
// original grid summing to 4, so the paid number had no evidence behind it. That
// is not only an audit hole. The console reloads the row's grid every time the
// submission is opened, so the NEXT correction started from the employee's
// pre-correction hours and silently reverted the first one — a correction from
// 4h to 20h, then a +2h touch-up, paid 6h instead of 22h, with no error shown.
// `days` still holds the employee's submission verbatim (it is their record, and
// it is append-only); final_days is the admin's replacement for it, exactly as
// final_total is the admin's replacement for the submitted total.
const ALLOWED = new Set(["submitted", "approved", "rejected"]);

// Legal transitions. Previously any status could flip to any other with no
// guard at all. 'submitted' is the reopen path.
const NEXT = {
  submitted: new Set(["approved", "rejected"]),
  approved: new Set(["rejected", "submitted"]),
  rejected: new Set(["approved", "submitted"]),
  superseded: new Set(),
};

const bad = (msg, status = 400, extra = {}) =>
  NextResponse.json({ error: msg, ...extra }, { status });

export async function POST(request) {
  const user = await currentUser();
  if (!user) return bad("not authenticated", 401);
  if (user.role !== "admin") return bad("forbidden", 403);

  const body = await request.json().catch(() => ({}));
  const { editId, status, note, days, summaryTotals, confirmZero } = body || {};
  if (!editId) return bad("editId required");
  if (status && !ALLOWED.has(status)) {
    return bad(`status must be one of ${[...ALLOWED].join(", ")}`);
  }

  const client = await pool().connect();
  let row, target, corrected = false, supersededCount = 0;
  try {
    await client.query("begin");

    target = (await client.query(
      `select id, user_id, year, month, status, fields, days
         from public.ts_employee_edits where id = $1 for update`,
      [editId]
    )).rows[0];
    if (!target) { await client.query("rollback"); return bad("submission not found", 404); }

    // A superseded submission is history — reviewing it would be meaningless.
    if (target.status === "superseded") {
      await client.query("rollback");
      return bad("This submission was replaced by a newer one; review that instead.", 409);
    }
    if (status && status !== target.status && !NEXT[target.status]?.has(status)) {
      await client.query("rollback");
      return bad(`cannot move a ${target.status} submission to ${status}`, 409);
    }

    // ---- corrected hours, derived here and nowhere else --------------------
    // A submission whose day grid is empty but whose stored totals are non-zero
    // came from a document that only stated SUMMARY figures. Summing its
    // (empty) days would pay the employee 0 hours, so that case gets its own
    // explicit, audited input instead of being forced through the summation.
    const storedTotal = Number(target.fields?.totals?.total) || 0;
    const storedDaysTotal = deriveTotals(target.days).total;
    const summaryOnly = storedDaysTotal === 0 && storedTotal > 0;

    let finals = null;
    if (Array.isArray(days)) {
      let t;
      try {
        // A corrected day grid is held to the same bounds as a submitted one:
        // final_* IS the paid number, so this is the last place an impossible
        // figure could enter payroll.
        t = deriveTotalsStrict(days);
      } catch (e) {
        if (!(e instanceof HoursRangeError)) throw e;
        await client.query("rollback");
        return bad(e.problems.join(" "), 400);
      }
      if (t.total === 0 && summaryOnly && confirmZero !== true) {
        await client.query("rollback");
        return bad(
          "This document has no per-day breakdown, so correcting it from an empty " +
          "day grid would pay 0 hours. Enter the corrected summary totals instead.",
          409, { summaryOnly: true }
        );
      }
      // The grid is kept with the totals it produced, so the row can always show
      // its own arithmetic and the next correction starts from these hours.
      finals = { regular: t.regular, overtime: t.overtime, total: t.total, days };
    } else if (summaryTotals && typeof summaryTotals === "object") {
      if (!summaryOnly) {
        await client.query("rollback");
        return bad("this submission has a day breakdown — correct the days, not a summary total", 409);
      }
      const reg = Number(summaryTotals.regular);
      const ot = Number(summaryTotals.overtime);
      // Non-negative was already checked here; the UPPER bound was not, so a
      // summary correction could still pay a million hours.
      const problems = checkSummaryTotals(summaryTotals);
      if (problems.length) {
        await client.query("rollback");
        return bad(problems.join(" "));
      }
      // `total` is computed, never taken from the client. `days: null` is
      // deliberate and is WRITTEN, not skipped: this document genuinely has no
      // day breakdown, and a grid left behind by an earlier correction would
      // leave the row claiming evidence that no longer adds up to what it pays.
      finals = { regular: round2(reg), overtime: round2(ot), total: round2(reg + ot), days: null };
    }
    corrected = finals !== null;

    // ---- the note ----------------------------------------------------------
    // `coalesce(note, review_note)` used to carry an old REJECTION reason
    // forward onto a later approval — and the note is a column in the payroll
    // CSV. An explicit note (including an explicit null) now replaces it, and a
    // status change always clears a stale one.
    const noteProvided = Object.prototype.hasOwnProperty.call(body || {}, "note");
    const statusChanges = !!status && status !== target.status;
    const overwriteNote = noteProvided || statusChanges;

    row = (await client.query(
      // Every parameter is cast explicitly: an untyped NULL bind inside a CASE
      // has no column to infer a type from, and Postgres rejects it outright
      // ("could not determine data type of parameter").
      `update public.ts_employee_edits
          set status         = coalesce($2::text, status),
              review_note    = case when $3::boolean then $4::text else review_note end,
              final_regular  = case when $5::boolean then $6::numeric else final_regular  end,
              final_overtime = case when $5::boolean then $7::numeric else final_overtime end,
              final_total    = case when $5::boolean then $8::numeric else final_total    end,
              -- Written in the SAME case as the totals above, off the SAME
              -- derived object, so the paid number and the grid it was summed
              -- from can never drift apart: a correction sets all four, or it
              -- touches none of them.
              final_days     = case when $5::boolean then $10::jsonb   else final_days   end,
              reviewed_by    = $9::uuid,
              reviewed_at    = now()
        where id = $1
        returning id, user_id, year, month, status, review_note,
                  final_regular, final_overtime, final_total, reviewed_at`,
      [editId, status || null, overwriteNote, note ?? null,
       corrected, finals?.regular ?? null, finals?.overtime ?? null, finals?.total ?? null,
       user.id,
       // node-pg encodes a top-level JS array as a Postgres array literal, which
       // jsonb rejects — the grid must be stringified (same rule as data.js).
       finals?.days ? JSON.stringify(finals.days) : null]
    )).rows[0];

    // ---- at most ONE approved row per employee+period -----------------------
    // The database trigger only supersedes rows still in status 'submitted', so
    // approving a second row for the same person+month used to leave TWO
    // approved rows and the payroll export paid both. Approving now retires
    // every other current row for that period.
    if (row.status === "approved") {
      const sup = await client.query(
        `update public.ts_employee_edits set status = 'superseded'
          where user_id = $1 and year = $2 and month = $3
            and id <> $4 and status <> 'superseded'
          returning id`,
        [row.user_id, row.year, row.month, row.id]
      );
      supersededCount = sup.rowCount || 0;
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("[review] failed:", e?.message || e);
    return bad(e?.message || "couldn't update the review status", 500);
  } finally {
    client.release();
  }

  console.info(
    `[review] ${user.email} set ${editId} -> ${row.status}` +
    `${corrected ? " (totals corrected)" : ""}` +
    `${supersededCount ? ` (+${supersededCount} superseded)` : ""}`
  );
  await audit({
    actor: user, action: "review", subjectId: row.user_id ?? null,
    detail: {
      editId, status: row.status, corrected,
      finalTotal: row.final_total, supersededRows: supersededCount, note: note ?? null,
    },
    ip: clientIp(request),
  });
  return NextResponse.json({ ok: true, submission: row, superseded: supersededCount });
}
