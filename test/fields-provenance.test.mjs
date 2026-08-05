// PROVENANCE INSIDE `fields` — against a REAL Postgres.
//
// lib/aws/data.js used to overwrite only fields.totals and merge the rest of the
// client's `fields` jsonb verbatim. Two of its keys are read as things the
// SERVER vouched for:
//
//   * fields.entry     — "an admin filed this on the employee's behalf".
//     /api/admin/timesheet names it as one of the three controls that make
//     admin-entered hours safe; /api/admin/export prints it as Origin and
//     "Entered by"; AdminClient renders "Filed by <name> on the employee's
//     behalf". An employee could put it on their OWN inflated submission and
//     the payroll CSV credited the hours to an admin who never saw them.
//   * fields.review_status / .flow / .agent_trace — the AI's verdict, which the
//     admin queue uses to decide what to look at first. Computed on the server
//     but carried by the browser, so it was equally forgeable: a hand-typed
//     timesheet could wear "AI found no problems".
//
// Both are now server-owned: `entry` is dropped from every client write, and the
// verdict is taken from the signed receipt /api/process issues (lib/aws/jwt.js).
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";
import { signAiVerdict } from "../lib/aws/jwt.js";

const EMP = "77777777-7777-7777-7777-777777777777";
const EMP2 = "88888888-8888-8888-8888-888888888888";
const employee = { id: EMP, email: "prov@x.com", role: "employee" };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

for (const [id, em] of [[EMP, "prov@x.com"], [EMP2, "prov2@x.com"]]) {
  await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x','employee')
               on conflict (id) do nothing`, [id, em]);
  await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,$3,'employee')
               on conflict (id) do nothing`, [id, em, em]);
}

const DAYS = [{ date: "2029-01-02", regular: 8 }, { date: "2029-01-03", regular: 8 }];
let month = 0;
const submit = async (fields) => {
  month += 1;
  const { data, error } = await execute(employee, {
    table: "ts_employee_edits", op: "insert", single: true,
    values: { user_id: EMP, month, year: 2029, submitted: true, days: DAYS, fields },
  });
  return { row: data, error };
};

// ---------------------------------------------------------------------------
console.log("── fields.entry: the admin provenance stamp ──");

const FORGED_ENTRY = {
  origin: "admin", by_id: EMP2, by_email: "admin@ajace.com",
  by_name: "Ada Admin", note: "filed by admin",
};
{
  const { row, error } = await submit({ employee_name: "Prov", entry: FORGED_ENTRY });
  ok("a forged entry stamp is not stored", !error && !row.fields.entry,
     JSON.stringify(row?.fields?.entry ?? error));
  ok("the rest of fields still round-trips", row?.fields?.employee_name === "Prov");
  ok("the hours are still derived from days", Number(row?.fields?.totals?.total) === 16);

  // The export reads it as coalesce(fields->'entry'->>'origin','employee').
  const csv = await query(
    `select coalesce(e.fields->'entry'->>'origin','employee') as origin
       from ts_employee_edits e where e.id = $1`, [row.id]);
  ok("the payroll CSV reads this row as Origin=employee", csv[0].origin === "employee",
     csv[0].origin);
}

// ---------------------------------------------------------------------------
console.log("── fields.review_status: the AI verdict ──");
{
  const { row } = await submit({ review_status: "auto_accepted", flow: "premium_plus",
                                 agent_trace: { handled_by: "forged" } });
  ok("no receipt -> no AI verdict", row.fields.review_status === null, row.fields.review_status);
  ok("no receipt -> no flow", row.fields.flow === null);
  ok("no receipt -> no agent trace", row.fields.agent_trace === null);
}
{
  const stamp = await signAiVerdict({ userId: EMP, reviewStatus: "needs_review",
                                      flow: "direct_serverless" });
  const { row } = await submit({ review_status: "auto_accepted", ai_stamp: stamp });
  ok("the receipt's verdict wins over the claim beside it",
     row.fields.review_status === "needs_review", row.fields.review_status);
  ok("the flow comes from the receipt too", row.fields.flow === "direct_serverless");
  ok("the receipt itself is not stored on the payroll record", !("ai_stamp" in row.fields));
}
{
  // A receipt is proof the AI ran for ONE person, not a bearer token.
  const stamp = await signAiVerdict({ userId: EMP2, reviewStatus: "auto_accepted",
                                      flow: "direct_serverless" });
  const { row } = await submit({ review_status: "auto_accepted", ai_stamp: stamp });
  ok("another user's receipt is refused", row.fields.review_status === null,
     row.fields.review_status);
}
{
  const stamp = await signAiVerdict({ userId: EMP, reviewStatus: "auto_accepted", flow: null });
  const bad = stamp.slice(0, -4) + (stamp.endsWith("AAAA") ? "BBBB" : "AAAA");
  const { row } = await submit({ review_status: "auto_accepted", ai_stamp: bad });
  ok("a tampered receipt is refused", row.fields.review_status === null,
     row.fields.review_status);
}

// ---------------------------------------------------------------------------
console.log("── the receipt is not a session, and a session is not a receipt ──");
{
  const { signSession, verifySession, readAiVerdict } = await import("../lib/aws/jwt.js");
  const session = await signSession({ id: EMP, email: "prov@x.com", role: "employee",
                                      session_version: 1 });
  ok("a session cookie cannot stand in for a receipt",
     (await readAiVerdict(session, EMP)) === null);
  const stamp = await signAiVerdict({ userId: EMP, reviewStatus: "auto_accepted", flow: null });
  ok("a receipt cannot stand in for a session cookie",
     (await verifySession(stamp)) === null);
  ok("a real session still verifies", (await verifySession(session))?.id === EMP);
}

await query(`delete from ts_employee_edits where user_id = $1`, [EMP]);
console.log(fail === 0 ? `\n✅ ALL PASS  —  ${pass} passed, 0 failed`
                       : `\n❌ ${fail} FAILED  (${pass} passed)`);
await pool().end();
process.exit(fail === 0 ? 0 : 1);
