// Data-layer + authorization tests against a REAL Postgres.
// These exercise lib/aws/data.js — the code that replaces PostgREST *and* RLS —
// so a regression in ownership scoping shows up here rather than in production.
//
//   bash test/run.sh          # starts a throwaway Postgres, applies the schema, runs this
//
// Every assertion below corresponds to a bug that was actually shipped once.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";

const EMP = "11111111-1111-1111-1111-111111111111";
const EMP2 = "22222222-2222-2222-2222-222222222222";
const ADM = "33333333-3333-3333-3333-333333333333";
const employee = { id: EMP, email: "emp@x.com", role: "employee" };
const employee2 = { id: EMP2, email: "emp2@x.com", role: "employee" };
const admin = { id: ADM, email: "adm@x.com", role: "admin" };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

for (const [id, em] of [[EMP, "emp@x.com"], [EMP2, "emp2@x.com"], [ADM, "adm@x.com"]]) {
  const role = id === ADM ? "admin" : "employee";
  await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x',$3)
               on conflict (id) do nothing`, [id, em, role]);
  await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,$3,$4)
               on conflict (id) do nothing`, [id, em, em, role]);
}

const CAL = [
  { date: "2026-05-01", regular: 8, overtime: 0, note: "worked" },
  { date: "2026-05-02", regular: 7.5, overtime: 1.5, note: "ot" },
];

// ---------------------------------------------------------------------------
// jsonb. node-pg encodes a top-level JS Array as a Postgres ARRAY literal, so
// binding `days` raw makes Postgres reject it: "invalid input syntax for type
// json". That bug meant NO timesheet could ever be saved. `projects` is text[],
// so it must still bind as a raw array — the two must not be conflated.
console.log("\n── jsonb columns (days/questionnaire/validation) ──");
let r = await execute(employee, {
  table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month", single: true,
  values: {
    user_id: EMP, month: 5, year: 2026, employee_name: "Emp One",
    projects: ["Alpha", "Beta"],
    days: CAL, questionnaire: { a: 1 }, validation: { errors: [] },
    monthly_regular: 15.5, monthly_total: 17, days_worked: 2, ai_status: "ok",
  },
});
ok("timesheet upsert succeeds", !r.error, r.error || "");
const tsId = r.data?.id;

const back = await query(
  `select jsonb_typeof(days) dt, jsonb_array_length(days) dl,
          jsonb_typeof(questionnaire) qt, projects
     from ts_timesheets where user_id=$1 and year=2026 and month=5`, [EMP]);
ok("days stored as a jsonb ARRAY", back[0]?.dt === "array", `got ${back[0]?.dt}`);
ok("days keeps both entries", Number(back[0]?.dl) === 2, `got ${back[0]?.dl}`);
ok("questionnaire stored as jsonb object", back[0]?.qt === "object", `got ${back[0]?.qt}`);
ok("projects still a real text[]", Array.isArray(back[0]?.projects) && back[0].projects[0] === "Alpha",
   JSON.stringify(back[0]?.projects));

const rd = await execute(employee, { table: "ts_timesheets", op: "select", columns: "*", filters: [], single: true });
ok("days reads back as a JS array", Array.isArray(rd.data?.days), typeof rd.data?.days);
ok("day object survives the round-trip", rd.data?.days?.[1]?.overtime === 1.5, JSON.stringify(rd.data?.days?.[1]));

console.log("\n── empty array must not become {} ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month", single: true,
  values: { user_id: EMP, month: 6, year: 2026, days: [], questionnaire: {}, validation: {} },
});
const e2 = await query(`select jsonb_typeof(days) dt from ts_timesheets where user_id=$1 and month=6`, [EMP]);
ok("empty days is a jsonb array", !r.error && e2[0]?.dt === "array", `${r.error || e2[0]?.dt}`);

console.log("\n── submit path (ts_employee_edits) ──");
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: { timesheet_id: tsId, user_id: EMP, month: 5, year: 2026,
            fields: { employee_name: "Emp One" }, days: CAL,
            questionnaire: { q: 1 }, validation: { errors: [] }, submitted: true },
});
ok("submission insert succeeds", !r.error, r.error || "");

// 'manual' is written by the "Enter manually instead" flow; it must be allowed
// by the ts_timesheets CHECK constraint.
console.log("\n── manual-entry flow ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month", single: true,
  values: { user_id: EMP, month: 7, year: 2026, days: [], ai_status: "manual" },
});
ok("ai_status='manual' accepted", !r.error, r.error || "");

console.log("\n── admin AI-flow picker (ts_app_settings) ──");
r = await execute(admin, {
  table: "ts_app_settings", op: "upsert", onConflict: "key", single: true,
  values: { key: "ai_flow", value: "consensus" },
});
ok("admin can change ai_flow", !r.error && r.data?.value === "consensus", r.error || JSON.stringify(r.data));
const t1 = await query(`select updated_at > now() - interval '1 minute' fresh from ts_app_settings where key='ai_flow'`);
ok("updated_at refreshed on conflict", t1[0]?.fresh === true, String(t1[0]?.fresh));

// ---------------------------------------------------------------------------
// Authorization. This layer replaces Postgres RLS, so these are the tests that
// keep one employee's hours private from another.
console.log("\n── authorization (the RLS replacement) ──");
r = await execute(employee, { table: "ts_app_settings", op: "upsert", onConflict: "key",
                              values: { key: "ai_flow", value: "hacked" } });
ok("employee cannot write settings", !!r.error, JSON.stringify(r.data));

r = await execute(employee, { table: "ts_app_settings", op: "delete", filters: [] });
ok("employee cannot delete settings", !!r.error, JSON.stringify(r.data));
const stillThere = await query(`select count(*)::int n from ts_app_settings`);
ok("settings row survived", stillThere[0].n > 0, `n=${stillThere[0].n}`);

await execute(employee, { table: "ts_profiles", op: "update", filters: [], values: { role: "admin" } });
const esc = await query(`select role from ts_profiles where id=$1`, [EMP]);
ok("employee cannot self-escalate to admin", esc[0].role === "employee", esc[0].role);

r = await execute(employee2, { table: "ts_timesheets", op: "select", columns: "*", filters: [] });
ok("employee sees none of another's timesheets", (r.data || []).length === 0, `saw ${(r.data || []).length}`);

r = await execute(admin, { table: "ts_timesheets", op: "select", columns: "*", filters: [] });
ok("admin sees all timesheets", (r.data || []).length >= 3, `saw ${(r.data || []).length}`);

r = await execute(employee2, { table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month",
                               single: true, values: { user_id: EMP, month: 9, year: 2026, days: [] } });
ok("ownership is forced server-side (cannot write as another user)",
   !r.error && r.data?.user_id === EMP2, `${r.error || r.data?.user_id}`);

r = await execute(employee, { table: "auth_users", op: "select", columns: "*", filters: [] });
ok("auth_users is not reachable through the data API", !!r.error, JSON.stringify(r.data));

r = await execute(employee, { table: "ts_timesheets", op: "select", columns: "id; drop table ts_files;--", filters: [] });
ok("column injection rejected", !!r.error, JSON.stringify(r.data));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end();
process.exit(fail ? 1 : 0);
