// The paid number must keep the day grid it was summed from.
//
// /api/admin/review derives final_regular/final_overtime/final_total from the
// `days` in the request body — correctly — but it used to throw that grid away.
// The row then said "pay 20 hours" while the only grid it stored, the
// employee's original, summed to 4. Two things went wrong with that:
//
//   1. the paid figure had no evidence anywhere in the record of record;
//   2. the admin console reloads the row's grid every time the submission is
//      opened, so the NEXT correction was computed from the PRE-correction
//      hours. Correcting 4h -> 20h and then adding a 2h call-out paid 6h, not
//      22h, with no error and nothing on screen to show it had happened.
//
// The grid now lives in final_days, written in the same statement as the totals
// it produced. This file guards the three properties that keep it honest.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";
import { readFileSync } from "node:fs";

const EMP = "cccccccc-0000-0000-0000-000000000001";
const ADM = "dddddddd-0000-0000-0000-000000000002";
const employee = { id: EMP, email: "grid-emp@x.com", role: "employee" };
const admin = { id: ADM, email: "grid-adm@x.com", role: "admin" };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

for (const [id, em, role] of [[EMP, employee.email, "employee"], [ADM, admin.email, "admin"]]) {
  await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x',$3) on conflict (id) do nothing`, [id, em, role]);
  await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,$3,$4) on conflict (id) do nothing`, [id, em, em, role]);
}

console.log("\n── the column exists and starts empty ──");
const col = await query(
  `select data_type from information_schema.columns
    where table_name='ts_employee_edits' and column_name='final_days'`);
ok("ts_employee_edits.final_days is jsonb", col[0]?.data_type === "jsonb", JSON.stringify(col));

let r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 9, year: 2026,
            days: [{ date: "2026-09-01", regular: 4, overtime: 0, other: 0 }],
            fields: {}, questionnaire: {}, validation: {}, submitted: true },
});
const id = r.data?.id;
ok("submission created", !r.error && !!id, r.error || "");
ok("no corrected grid until an admin corrects it", r.data?.final_days === null, JSON.stringify(r.data?.final_days));

console.log("\n── final_days is READ-ONLY to the browser, like every other final_* ──");
// The day entry is DATED. It used to be a bare `{ regular: 1 }`, which lib/hours.js
// now refuses outright: hours that name no calendar day cannot be checked against
// the 24-hour daily ceiling, and "forty undated entries of 18 hours" is exactly
// how that ceiling was defeated. The dateless case gets its own assertion below;
// this one is about final_* being read-only and needs a grid that is otherwise valid.
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 10, year: 2026, days: [{ date: "2026-10-01", regular: 1 }],
            final_days: [{ regular: 999 }], final_total: 999,
            fields: {}, questionnaire: {}, validation: {}, submitted: true },
});
ok("a client-supplied final_days is ignored, not stored", r.data?.final_days === null, JSON.stringify(r.data?.final_days));
ok("a client-supplied final_total is ignored too", r.data?.final_total === null, String(r.data?.final_total));

console.log("\n── and the grid it is corrected FROM must be one row per real day ──");
// Same 24h ceiling, defeated by repeating a date: two entries of 24h on
// 2026-11-02 derived to 48 payable hours on one calendar day, approved and
// exported. The bound is now per calendar date, so this is refused at the
// derivation, before anything is stored.
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 11, year: 2026,
            days: [{ date: "2026-11-02", regular: 24 }, { date: "2026-11-02", regular: 24 }],
            fields: {}, questionnaire: {}, validation: {}, submitted: true },
});
ok("48h split across two entries on ONE date is refused", !!r.error && !r.data, JSON.stringify(r.data || r.error));
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 11, year: 2026, days: [{ regular: 18 }, { regular: 18 }],
            fields: {}, questionnaire: {}, validation: {}, submitted: true },
});
ok("hours on an entry with no date are refused too", !!r.error && !r.data, JSON.stringify(r.data || r.error));
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 12, year: 2026,
            days: [{ date: "2026-12-01", regular: 8 }, { date: "2026-12-02", regular: 8 }],
            fields: {}, questionnaire: {}, validation: {}, submitted: true },
});
ok("one row per day is still accepted and derives 16h",
   !r.error && Number(r.data?.fields?.totals?.total ?? 16) === 16 && !!r.data,
   r.error || JSON.stringify(r.data?.days));

console.log("\n── the console can READ it (it is the grid of record once set) ──");
await query(`update ts_employee_edits
                set status='approved', reviewed_by=$1, reviewed_at=now(),
                    final_regular=20, final_overtime=0, final_total=20,
                    final_days=$2::jsonb
              where id=$3`,
  [ADM, JSON.stringify([{ date: "2026-09-01", regular: 10 }, { date: "2026-09-02", regular: 10 }]), id]);
r = await execute(admin, {
  table: "ts_employee_edits", op: "select", single: true,
  columns: "days,final_days,final_total", filters: [{ col: "id", val: id }],
});
ok("final_days is selectable", !r.error, r.error || "");
const grid = Array.isArray(r.data?.final_days) ? r.data.final_days : r.data?.days;
const sum = grid.reduce((a, d) => a + (Number(d.regular) || 0) + (Number(d.overtime) || 0) + (Number(d.other) || 0), 0);
ok("the grid the console would render sums to what payroll pays",
   sum === Number(r.data?.final_total), `grid=${sum} paid=${r.data?.final_total}`);
ok("the employee's own submission is still there, untouched",
   Array.isArray(r.data?.days) && r.data.days.length === 1 && Number(r.data.days[0].regular) === 4,
   JSON.stringify(r.data?.days));

console.log("\n── nothing pays a figure whose stored grid disagrees with it ──");
const bad = await query(
  `select id, final_total,
          (select coalesce(sum((d->>'regular')::numeric
                             + coalesce((d->>'overtime')::numeric,0)
                             + coalesce((d->>'other')::numeric,0)),0)
             from jsonb_array_elements(final_days) d) as grid_sum
     from ts_employee_edits
    where final_total is not null and final_days is not null`);
const drift = bad.filter((x) => Number(x.final_total) !== Number(x.grid_sum));
ok("every corrected row's final_total equals its own final_days", drift.length === 0, JSON.stringify(drift));

console.log("\n── source contract: the two must be written together ──");
// A future edit that adds a correction path writing final_total without
// final_days would reopen exactly this bug, and no behavioural test on the DB
// can see it: the row simply keeps a stale grid.
const route = readFileSync(new URL("../app/api/admin/review/route.js", import.meta.url), "utf8");
ok("the review route writes final_days", /final_days\s*=\s*case when/.test(route));
ok("it writes it on the same condition as final_total",
   (route.match(/final_total\s*=\s*case when \$(\d+)::boolean/)?.[1]) ===
   (route.match(/final_days\s*=\s*case when \$(\d+)::boolean/)?.[1]));
const client = readFileSync(new URL("../components/AdminClient.js", import.meta.url), "utf8");
ok("the console prefers final_days over the employee's days",
   /final_days\s*\)\s*\?\s*e\.final_days\s*:\s*e\?\.days/.test(client) || /Array\.isArray\(e\?\.final_days\)/.test(client));

await query(`delete from ts_employee_edits where user_id=$1`, [EMP]);
await pool().end();
console.log(`\n${fail ? "❌" : "✅"} ${fail ? "FAILURES" : "ALL PASS"}  —  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
