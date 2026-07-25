// Tier 1: review workflow, supersede-on-resubmit, and payroll numbers of record.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";

const EMP = "aaaaaaaa-0000-0000-0000-000000000001";
const ADM = "bbbbbbbb-0000-0000-0000-000000000002";
const employee = { id: EMP, email: "e@x.com", role: "employee" };
const admin = { id: ADM, email: "a@x.com", role: "admin" };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

for (const [id, em, role] of [[EMP, "e@x.com", "employee"], [ADM, "a@x.com", "admin"]]) {
  await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x',$3) on conflict (id) do nothing`, [id, em, role]);
  await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,$3,$4) on conflict (id) do nothing`, [id, em, em, role]);
}
const submit = (total) => execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 5, year: 2026, days: [],
            fields: { totals: { regular: total, overtime: 0, total } },
            questionnaire: {}, validation: {}, submitted: true },
});

console.log("\n── new columns exist and default correctly ──");
let r = await submit(160);
ok("submission created", !r.error, r.error || "");
const first = r.data?.id;
ok("defaults to 'submitted'", r.data?.status === "submitted", r.data?.status);
ok("no corrected totals yet", r.data?.final_total === null, String(r.data?.final_total));

console.log("\n── resubmitting supersedes the earlier one (no double-count) ──");
r = await submit(168);
const second = r.data?.id;
const rows = await query(`select id,status from ts_employee_edits where user_id=$1 and year=2026 and month=5 order by created_at`, [EMP]);
ok("earlier submission marked superseded", rows.find((x) => x.id === first)?.status === "superseded",
   JSON.stringify(rows.map((x) => x.status)));
ok("newest stays 'submitted'", rows.find((x) => x.id === second)?.status === "submitted");
const live = rows.filter((x) => x.status !== "superseded");
ok("exactly ONE current submission for the period", live.length === 1, `got ${live.length}`);

console.log("\n── review is admin-only and append-only through the data API ──");
r = await execute(employee, { table: "ts_employee_edits", op: "update", filters: [], values: { submitted: false } });
ok("employee cannot update a submission", !!r.error, JSON.stringify(r.data));
r = await execute(employee, { table: "ts_employee_edits", op: "delete", filters: [] });
ok("employee cannot delete a submission", !!r.error, JSON.stringify(r.data));

console.log("\n── admin correction becomes the number of record ──");
await query(`update ts_employee_edits set final_regular=150, final_overtime=8, final_total=158,
             reviewed_by=$1, reviewed_at=now(), status='approved', review_note='fixed Apr 14'
             where id=$2`, [ADM, second]);
const payroll = await query(
  `select coalesce(final_total,(fields->'totals'->>'total')::numeric) as total, status
     from ts_employee_edits where id=$1`, [second]);
ok("payroll total uses the admin correction, not the employee's 168", Number(payroll[0].total) === 158, String(payroll[0].total));
ok("status is approved", payroll[0].status === "approved", payroll[0].status);

console.log("\n── the export query returns exactly the payable rows ──");
const exported = await query(
  `select p.full_name, coalesce(e.final_total,(e.fields->'totals'->>'total')::numeric) total, e.status
     from ts_employee_edits e join ts_profiles p on p.id=e.user_id
    where e.year=2026 and e.month=5 and e.status <> 'superseded' and e.status='approved'`);
ok("one payable row", exported.length === 1, `got ${exported.length}`);
ok("payable total is the corrected 158", Number(exported[0]?.total) === 158, String(exported[0]?.total));

console.log("\n── employee can read back their own submission (dashboard status) ──");
r = await execute(employee, {
  table: "ts_employee_edits", op: "select",
  columns: "id,month,year,status,created_at,fields,review_note,final_total", filters: [],
});
ok("read-back returns rows", (r.data || []).length >= 2, r.error || `${(r.data || []).length}`);
ok("read-back exposes status", !!r.data?.[0]?.status, JSON.stringify(r.data?.[0] || {}).slice(0, 80));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end();
process.exit(fail ? 1 : 0);
