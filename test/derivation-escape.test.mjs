// The derivation used to be gated on Array.isArray(obj.days), so a payload that
// simply OMITTED days skipped it and stored client-supplied totals — and
// fields.totals is what the payroll CSV pays. These probes are the escape.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";

const EMP = "eeee0000-0000-0000-0000-000000000001";
const employee = { id: EMP, email: "esc@x.com", role: "employee" };
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

await query(`insert into auth_users(id,email,password_hash,role) values($1,'esc@x.com','x','employee') on conflict (id) do nothing`, [EMP]);
await query(`insert into ts_profiles(id,email,full_name,role) values($1,'esc@x.com','Esc','employee') on conflict (id) do nothing`, [EMP]);

console.log("\n── escape (a): submission with NO days but claimed totals ──");
let r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { user_id: EMP, month: 3, year: 2026, submitted: true,
            fields: { employee_name: "Esc", totals: { regular: 999, overtime: 999, total: 999 } } },
});
ok("refused instead of storing 999", !!r.error, JSON.stringify(r.data?.fields?.totals));
const stored = await query(`select fields->'totals'->>'total' t from ts_employee_edits where user_id=$1`, [EMP]);
ok("nothing with 999 reached the DB", !stored.some((x) => x.t === "999"), JSON.stringify(stored));

console.log("\n── escape (b): ts_timesheets totals patched with no days ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month", single: true,
  values: { user_id: EMP, month: 3, year: 2026, days: [{ date: "2026-03-02", regular: 8 }],
            questionnaire: {}, validation: {} },
});
ok("baseline saved (8h)", !r.error && Number(r.data.monthly_total) === 8, r.error || String(r.data?.monthly_total));
const id = r.data?.id;
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: id }],
  values: { monthly_regular: 999, monthly_overtime: 999, monthly_total: 999, days_worked: 99 },
});
ok("totals-only update refused", !!r.error, JSON.stringify(r.data));
const after = await query(`select monthly_total from ts_timesheets where id=$1`, [id]);
ok("stored total still 8, not 999", Number(after[0].monthly_total) === 8, String(after[0]?.monthly_total));

console.log("\n── still works the legitimate way (days present) ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: id }],
  values: { days: [{ date: "2026-03-02", regular: 8 }, { date: "2026-03-03", regular: 7, overtime: 1 }],
            questionnaire: {}, validation: {} },
});
ok("update with days succeeds and derives 16", !r.error && Number(r.data[0].monthly_total) === 16,
   r.error || String(r.data?.[0]?.monthly_total));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end(); process.exit(fail ? 1 : 0);
