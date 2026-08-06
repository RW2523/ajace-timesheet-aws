// AN ADMIN FILES A TIMESHEET FOR SOMEBODY ELSE — the properties that must hold,
// EXECUTED against the real route handlers and a real Postgres.
//
// The two filing flows were merged into one screen: the employee dashboard now
// files for the signed-in person AND, for an admin or HR user, for anyone else,
// with the same document upload and AI extraction either way. That merge moved a
// lot of decisions into one component, so the properties that keep it honest are
// asserted HERE, on the server, where they are actually enforced.
//
// Nothing is stubbed. test/route-loader.mjs teaches bare Node the "@/..." alias
// and Next's package exports so app/api/**/route.js imports unmodified — delete a
// guard from a route and this file goes red, which is the only reason it is worth
// having.
//
//   1. THE ROW IS OWNED BY THE TARGET, NOT THE FILER. The whole point. /api/data
//      would have force-overwritten the owner to the admin, silently, with 200.
//   2. THE DOCUMENT IS READABLE BY THE TARGET. It is stored under their prefix,
//      the route REFUSES a path that is not, and /api/storage/get (owner-or-
//      admin) then lets them read it. Store it under the admin's prefix instead
//      and the employee gets a hard 403 on their own source document.
//   3. AN ORDINARY EMPLOYEE CANNOT FILE FOR ANYONE BUT THEMSELVES. Through the
//      admin route (403) and through /api/data (owner forced back to them).
//   4. AN ADMIN FILING FOR THEMSELVES STILL GOES TO THE QUEUE, unapproved.
//   5. HR MAY FILE, HR MAY NOT APPROVE. Maker and checker stay two people.
//   6. THE AI VERDICT COMES FROM A RECEIPT BOUND TO THE CALLER, and an unsigned
//      review_status beside it is ignored.
//   7. AT MOST ONE CURRENT ROW per employee+month, and replacing one is an
//      explicit act.
import { query, pool } from "../lib/aws/db.js";
import { execute } from "../lib/aws/data.js";
import { signSession, signAiVerdict, SESSION_COOKIE } from "../lib/aws/jwt.js";
import { importRoute, jsonRequest, withRequestScope } from "./route-loader.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

// ---------------------------------------------------------------------------
const ADMIN = "eeee0000-0000-4000-8000-00000000000a";
const HR     = "eeee0000-0000-4000-8000-00000000000b";
const EMP    = "eeee0000-0000-4000-8000-00000000000c";   // the TARGET
const OTHER  = "eeee0000-0000-4000-8000-00000000000d";   // an ordinary employee

// employee_code is UNIQUE on a folded form (ts_profiles_employee_code_lower_uniq)
// — it is the column a payroll import matches people on, so two records sharing
// one is one code paid twice. One per person here, for the same reason.
for (const [id, email, role, name, code] of [
  [ADMIN, "ob.admin@ajace.com", "admin",    "Ob Admin",    "OB-ADM1"],
  [HR,    "ob.hr@ajace.com",    "hr",       "Ob HR",       "OB-HR1"],
  [EMP,   "ob.emp@ajace.com",   "employee", "Ob Employee", "OB-EMP1"],
  [OTHER, "ob.other@ajace.com", "employee", "Ob Other",    "OB-OTH1"],
]) {
  await query(`insert into public.auth_users(id,email,password_hash,role) values($1,$2,'x',$3)
               on conflict (id) do update set role = excluded.role`, [id, email, role]);
  await query(`insert into public.ts_profiles(id,email,full_name,role,active,employee_code,client)
               values($1,$2,$3,$4,true,$5,'Acme')
               on conflict (id) do update set role = excluded.role`,
              [id, email, name, role, code]);
}
const cookieFor = async (id, email, role) => ({
  [SESSION_COOKIE]: await signSession({ id, email, role, session_version: 1 }),
});
const ADMIN_COOKIE = await cookieFor(ADMIN, "ob.admin@ajace.com", "admin");
const HR_COOKIE    = await cookieFor(HR, "ob.hr@ajace.com", "hr");
const EMP_COOKIE   = await cookieFor(EMP, "ob.emp@ajace.com", "employee");
const OTHER_COOKIE = await cookieFor(OTHER, "ob.other@ajace.com", "employee");

const timesheet = await importRoute("app/api/admin/timesheet/route.js");
const review    = await importRoute("app/api/admin/review/route.js");
const storage   = await importRoute("app/api/storage/get/route.js");

async function file(cookies, payload) {
  const { result } = await withRequestScope(cookies, () =>
    timesheet.POST(jsonRequest("http://t/api/admin/timesheet", payload, { ip: "203.0.113.20" })));
  return { status: result.status, body: await result.json() };
}
async function readFile(cookies, path) {
  const { result } = await withRequestScope(cookies, () =>
    storage.GET(new Request(`http://t/api/storage/get?path=${encodeURIComponent(path)}`, {
      headers: { "x-forwarded-for": "203.0.113.21" },
    })));
  return result.status;
}

// 24 paid hours over three days — 22 regular + 2 overtime. Deliberately NOT a
// round 8/8/8: a derivation that folded overtime into regular, or dropped it,
// would still total 24, so the split is what makes a wrong sum visible.
const DAYS = [
  { date: "2027-04-05", regular: 8, total: 8, filled: true },
  { date: "2027-04-06", regular: 8, total: 8, filled: true },
  { date: "2027-04-07", regular: 6, overtime: 2, total: 8, filled: true },
];
const rowsFor = (uid, y, m) => query(
  `select id, user_id, status, reviewed_by, fields, questionnaire
     from public.ts_employee_edits where user_id=$1 and year=$2 and month=$3`, [uid, y, m]);

// ===========================================================================
console.log("\n── 1. THE ROW IS OWNED BY THE TARGET, NOT THE FILER ──");
// A signed AI receipt for the ADMIN — the person who actually ran /api/process.
const STAMP = await signAiVerdict({
  userId: ADMIN, reviewStatus: "needs_review", flow: "consensus", confidence: 0.64,
});
const DOC = `${EMP}/2027-04/1700000000001.pdf`;

let r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 4,
  note: "paper timesheet handed in at the desk on 8 April",
  days: DAYS,
  file: { path: DOC, name: "april.pdf", mime: "application/pdf", size: 1234 },
  fields: {
    client: "Acme",
    ai_stamp: STAMP,
    // UNSIGNED claims sitting beside the receipt. They must be ignored.
    review_status: "auto_accepted", flow: "made-up-flow",
    agent_trace: { handled_by: "DirectReader" },
    // And a forged provenance stamp, which the server owns.
    entry: { origin: "self", by_id: EMP, by_name: "Ob Employee" },
    // A claimed total, which the server derives instead.
    totals: { regular: 999, overtime: 999, total: 999 },
  },
  questionnaire: { managerApproval: "acknowledged_absent", managerApprovalAck: true,
                   holidayWork: {} },
});
ok("an admin can file for an existing employee", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

const filed = await rowsFor(EMP, 2027, 4);
ok("the payroll row is owned by the EMPLOYEE", filed.length === 1 && filed[0].user_id === EMP,
   JSON.stringify(filed.map((f) => f.user_id)));
ok("...and NOTHING was filed against the admin's own record for that month",
   (await rowsFor(ADMIN, 2027, 4)).length === 0);
ok("an admin's on-behalf filing lands approved and payable", filed[0]?.status === "approved",
   String(filed[0]?.status));
ok("the totals are DERIVED from days (22 regular + 2 overtime = 24), not the 999s claimed",
   Number(filed[0]?.fields?.totals?.total) === 24 &&
   Number(filed[0]?.fields?.totals?.regular) === 22 &&
   Number(filed[0]?.fields?.totals?.overtime) === 2,
   JSON.stringify(filed[0]?.fields?.totals));
ok("the provenance stamp is the SERVER's, not the forged one in the payload",
   filed[0]?.fields?.entry?.origin === "admin" && filed[0]?.fields?.entry?.by_id === ADMIN,
   JSON.stringify(filed[0]?.fields?.entry));
ok("the mandatory note is recorded on the row", /8 April/.test(filed[0]?.fields?.entry?.note || ""));
ok("the employee's identity on the row comes from THEIR profile, not the filer's",
   filed[0]?.fields?.employee_name === "Ob Employee", String(filed[0]?.fields?.employee_name));
ok("the receipt itself is never stored", !("ai_stamp" in (filed[0]?.fields || {})),
   JSON.stringify(Object.keys(filed[0]?.fields || {})));

console.log("\n── 6. the AI verdict comes from the RECEIPT, not the payload ──");
ok("review_status is the receipt's 'needs_review', not the payload's 'auto_accepted'",
   filed[0]?.fields?.review_status === "needs_review", String(filed[0]?.fields?.review_status));
ok("flow is the receipt's, not the payload's made-up one",
   filed[0]?.fields?.flow === "consensus", String(filed[0]?.fields?.flow));
const ts = await query(
  `select user_id, ai_status, ai_confidence, draft, monthly_total, days_worked
     from public.ts_timesheets where user_id=$1 and year=2027 and month=4`, [EMP]);
ok("the ts_timesheets row is the EMPLOYEE's", ts.length === 1 && ts[0].user_id === EMP);
ok("ai_status is 'ok' — an AI-assisted on-behalf filing is no longer recorded as hand-typed",
   ts[0]?.ai_status === "ok", String(ts[0]?.ai_status));
ok("ai_confidence comes from the SIGNED receipt", Number(ts[0]?.ai_confidence) === 0.64,
   String(ts[0]?.ai_confidence));
ok("the employee's draft for that month is cleared, so they are not re-offered stale hours",
   ts[0]?.draft === null, JSON.stringify(ts[0]?.draft));
ok("ts_timesheets totals are derived the same way", Number(ts[0]?.monthly_total) === 24,
   String(ts[0]?.monthly_total));
ok("the questionnaire carries the REAL answers now, not a dead {enteredByAdmin}",
   filed[0]?.questionnaire?.managerApprovalAck === true &&
   !("enteredByAdmin" in (filed[0]?.questionnaire || {})),
   JSON.stringify(filed[0]?.questionnaire));

// A receipt signed for the TARGET, presented by the admin, must NOT verify.
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 5,
  note: "second month, with somebody else's receipt attached", days: DAYS, supersede: true,
  fields: { ai_stamp: await signAiVerdict({ userId: EMP, reviewStatus: "auto_accepted", confidence: 0.99 }),
            review_status: "auto_accepted" },
});
ok("a filing carrying a receipt signed for the EMPLOYEE is still accepted", r.status === 200,
   `${r.status} ${JSON.stringify(r.body)}`);
const mayRow = (await rowsFor(EMP, 2027, 5))[0];
const mayTs = (await query(`select ai_status, ai_confidence from public.ts_timesheets
                            where user_id=$1 and year=2027 and month=5`, [EMP]))[0];
ok("...but that receipt does not verify against the caller, so review_status is null",
   mayRow?.fields?.review_status === null, String(mayRow?.fields?.review_status));
ok("...and it is recorded as hand-entered, with no confidence",
   mayTs?.ai_status === "manual" && mayTs?.ai_confidence === null,
   `${mayTs?.ai_status} / ${mayTs?.ai_confidence}`);

// ===========================================================================
console.log("\n── the audit trail ──");
const adminEdits = await query(
  `select employee_user_id, admin_user_id, note from public.ts_admin_edits
    where employee_user_id=$1 and year=2027 and month=4`, [EMP]);
ok("ts_admin_edits carries BOTH identities — who was filed for, and by whom",
   adminEdits.length === 1 && adminEdits[0].employee_user_id === EMP &&
   adminEdits[0].admin_user_id === ADMIN, JSON.stringify(adminEdits));
ok("...and the note the console renders",
   /Filed on behalf of the employee/.test(adminEdits[0]?.note || ""), adminEdits[0]?.note);
// Scoped to the APRIL filing by its editId: two filings were made for this
// employee above (April with a valid receipt, May with one signed for somebody
// else), and "the most recent" would silently test the wrong one.
const auditRow = (await query(
  `select action, subject_id, detail from public.ts_audit_log
    where action='timesheet.create_for' and subject_id=$1
      and detail->>'editId' = $2`, [EMP, filed[0].id]))[0];
ok("the audit log records the filing against the EMPLOYEE as subject", !!auditRow);
ok("...and how the hours were produced (AI-assisted vs typed)",
   auditRow?.detail?.ai_status === "ok", JSON.stringify(auditRow?.detail?.ai_status));

// ===========================================================================
console.log("\n── 2. THE DOCUMENT IS READABLE BY THE TARGET ──");
const fileRow = (await query(
  `select user_id, storage_path from public.ts_files where user_id=$1 and year=2027 and month=4`,
  [EMP]))[0];
ok("the ts_files row is owned by the EMPLOYEE (the console finds it by their user_id)",
   fileRow?.user_id === EMP, JSON.stringify(fileRow));
ok("...and its storage_path sits under the EMPLOYEE's prefix",
   String(fileRow?.storage_path || "").startsWith(`${EMP}/`), String(fileRow?.storage_path));
// /api/storage/get is owner-or-admin. A 403 would mean the employee cannot read
// their own source document; anything else means the ownership check passed
// (the object is not actually in S3 here, so a 404 is the expected outcome).
ok("the EMPLOYEE is not refused their own document", (await readFile(EMP_COOKIE, DOC)) !== 403);
ok("the admin can read it too (they are the reviewer)", (await readFile(ADMIN_COOKIE, DOC)) !== 403);
ok("an unrelated employee is refused it", (await readFile(OTHER_COOKIE, DOC)) === 403);
// ...and the failure mode this prevents: had the document been stored under the
// ADMIN's prefix, the employee would get a hard 403 on their own timesheet's
// source document — failing closed and silently.
ok("a document under the ADMIN's prefix WOULD be a 403 for the employee",
   (await readFile(EMP_COOKIE, `${ADMIN}/2027-04/x.pdf`)) === 403);

console.log("\n── ...and the route REFUSES a document not stored under the target ──");
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 6,
  note: "a document stored under my own prefix", days: DAYS,
  file: { path: `${ADMIN}/2027-06/sneaky.pdf`, name: "sneaky.pdf" },
});
ok("a path outside the employee's prefix is refused", r.status === 400,
   `${r.status} ${JSON.stringify(r.body)}`);
ok("...with a message naming the actual problem",
   /not stored under that employee/.test(r.body?.error || ""), r.body?.error);
ok("...and the whole filing rolled back — no row, no file record",
   (await rowsFor(EMP, 2027, 6)).length === 0 &&
   (await query(`select 1 from public.ts_files where storage_path=$1`, [`${ADMIN}/2027-06/sneaky.pdf`])).length === 0);
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 6,
  note: "traversal attempt", days: DAYS,
  file: { path: `${EMP}/../${ADMIN}/2027-06/sneaky.pdf`, name: "sneaky.pdf" },
});
ok("a traversal path is refused too", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

// ===========================================================================
console.log("\n── 3. AN ORDINARY EMPLOYEE CANNOT FILE FOR ANYONE BUT THEMSELVES ──");
for (const mode of ["self", "existing", "new"]) {
  const res = await file(OTHER_COOKIE, {
    for: mode, employeeUserId: EMP, year: 2027, month: 7,
    note: "an employee should not be able to do this", days: DAYS,
    newPerson: { email: "ob.smuggle@ajace.com", fullName: "Ob Smuggle" },
  });
  ok(`the admin route refuses an ordinary employee for:"${mode}"`, res.status === 403,
     `${res.status} ${JSON.stringify(res.body)}`);
}
ok("...and no row landed on the target from any of them",
   (await rowsFor(EMP, 2027, 7)).length === 0);
// The other door. /api/data is reachable by every authenticated user, and this
// is the rule the whole on-behalf path exists to avoid fighting: the owner
// column is FORCED to the caller, so posting somebody else's user_id files the
// hours against yourself. It is not an error — it is a silent 200 — which is
// exactly why an on-behalf filing must never be sent here.
const viaData = await execute(
  { id: OTHER, email: "ob.other@ajace.com", role: "employee" },
  { table: "ts_employee_edits", op: "insert", single: true,
    values: { user_id: EMP, month: 8, year: 2027, submitted: true,
              fields: { employee_name: "Ob Employee" }, days: DAYS,
              questionnaire: {}, validation: {} } });
ok("/api/data force-overwrites the owner to the caller (no error, just the wrong owner)",
   !viaData.error && viaData.data?.user_id === OTHER, `${viaData.error} ${viaData.data?.user_id}`);
ok("...so nothing landed on the target's record", (await rowsFor(EMP, 2027, 8)).length === 0);
// The same rule holds for an ADMIN, which is why the merged screen must route by
// the resolved id and not by a UI flag.
const adminViaData = await execute(
  { id: ADMIN, email: "ob.admin@ajace.com", role: "admin" },
  { table: "ts_employee_edits", op: "insert", single: true,
    values: { user_id: EMP, month: 9, year: 2027, submitted: true,
              fields: { employee_name: "Ob Employee" }, days: DAYS,
              questionnaire: {}, validation: {} } });
ok("an ADMIN posting to /api/data for an employee also files it against THEMSELVES",
   !adminViaData.error && adminViaData.data?.user_id === ADMIN, String(adminViaData.data?.user_id));
ok("...confirming the merged screen must not send an on-behalf filing there",
   (await rowsFor(EMP, 2027, 9)).length === 0);

// ===========================================================================
console.log("\n── 4. AN ADMIN FILING FOR THEMSELVES STILL GOES TO THE QUEUE ──");
r = await file(ADMIN_COOKIE, { for: "self", year: 2027, month: 10, days: DAYS });
ok("no note is demanded for your own hours", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
const own = (await rowsFor(ADMIN, 2027, 10))[0];
ok("an admin's own hours land on their OWN id", own?.user_id === ADMIN);
ok("...and wait for review — nobody approves their own wages", own?.status === "submitted",
   String(own?.status));
ok("...with no reviewer stamped on them", own?.reviewed_by === null, String(own?.reviewed_by));
ok("...and origin 'self', so the payroll CSV does not print an on-behalf entry that never happened",
   own?.fields?.entry?.origin === "self", String(own?.fields?.entry?.origin));
ok("...and NO ts_admin_edits row, which would claim an admin acted on somebody else",
   (await query(`select 1 from public.ts_admin_edits where employee_user_id=$1 and year=2027 and month=10`,
                [ADMIN])).length === 0);
// The mode is not the question — the ID is. {for:"existing", employeeUserId:me}
// must take the SELF branch, or an admin auto-approves their own wages.
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: ADMIN, year: 2027, month: 11, days: DAYS,
  note: "asking for the on-behalf branch on my own record",
});
const disguised = (await rowsFor(ADMIN, 2027, 11))[0];
ok("for:\"existing\" pointed at MY OWN id still lands 'submitted', never 'approved'",
   r.status === 200 && disguised?.status === "submitted",
   `${r.status} ${disguised?.status}`);

// ===========================================================================
console.log("\n── 5. HR MAY FILE, HR MAY NOT APPROVE ──");
r = await file(HR_COOKIE, {
  for: "existing", employeeUserId: OTHER, year: 2027, month: 4,
  note: "typed from the paper timesheet handed to HR", days: DAYS,
});
ok("HR can file on somebody's behalf", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
const hrFiled = (await rowsFor(OTHER, 2027, 4))[0];
ok("the hours are on the EMPLOYEE's id, not HR's", hrFiled?.user_id === OTHER);
ok("...and wait for an admin: HR enters hours, HR does not sign them off",
   hrFiled?.status === "submitted", String(hrFiled?.status));
async function decide(cookies, editId, status) {
  const { result } = await withRequestScope(cookies, () =>
    review.POST(jsonRequest("http://t/api/admin/review", { editId, status, note: "ok" },
                            { ip: "203.0.113.22" })));
  return { status: result.status, body: await result.json() };
}
let d = await decide(HR_COOKIE, hrFiled.id, "approved");
ok("HR is refused at /api/admin/review", d.status === 403, `${d.status} ${JSON.stringify(d.body)}`);
ok("...and the row is untouched",
   (await rowsFor(OTHER, 2027, 4))[0]?.status === "submitted");
d = await decide(ADMIN_COOKIE, hrFiled.id, "approved");
ok("an admin CAN approve it (else this is a lockout, not a control)", d.status === 200,
   `${d.status} ${JSON.stringify(d.body)}`);
// ...and the same admin cannot approve their own.
d = await decide(ADMIN_COOKIE, own.id, "approved");
ok("an admin cannot approve their OWN submission", d.status === 403,
   `${d.status} ${JSON.stringify(d.body)}`);

// ===========================================================================
console.log("\n── 7. AT MOST ONE CURRENT ROW PER EMPLOYEE+MONTH ──");
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 4,
  note: "a correction to April", days: DAYS,
});
ok("filing over an existing row is refused until it is asked for", r.status === 409,
   `${r.status} ${JSON.stringify(r.body)}`);
ok("...and the refusal names the rows, so nothing is retired unseen",
   r.body?.needsSupersede === true && Array.isArray(r.body?.existing) && r.body.existing.length === 1,
   JSON.stringify(r.body));
ok("...and nothing was written", (await rowsFor(EMP, 2027, 4)).length === 1);
r = await file(ADMIN_COOKIE, {
  for: "existing", employeeUserId: EMP, year: 2027, month: 4,
  note: "a correction to April", days: DAYS, supersede: true,
});
ok("supersede:true replaces it", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
const april = await rowsFor(EMP, 2027, 4);
ok("both rows survive — history is append-only", april.length === 2, String(april.length));
ok("...and exactly ONE of them is current",
   april.filter((a) => a.status !== "superseded").length === 1,
   JSON.stringify(april.map((a) => a.status)));

// ===========================================================================
console.log("\n── the two unscoped reads the dashboard had to close ──");
// These prove the client-side `.eq("user_id", …)` added to DashboardClient and
// app/dashboard/page.js is LOAD-BEARING and not decoration: the data layer
// grants an admin an unscoped view of both tables, so without the filter an
// admin's own dashboard would offer a stranger's draft and banner.
await execute({ id: EMP, email: "ob.emp@ajace.com", role: "employee" }, {
  table: "ts_timesheets", op: "update",
  filters: [{ col: "year", val: 2027 }, { col: "month", val: 4 }],
  values: { draft: { v: 1, savedAt: "2027-05-01T00:00:00.000Z", fields: {} } },
});
const unscoped = await execute({ id: ADMIN, email: "ob.admin@ajace.com", role: "admin" }, {
  table: "ts_timesheets", op: "select", columns: "id,user_id,draft",
  filters: [{ col: "year", val: 2027 }, { col: "month", val: 4 }],
});
ok("an admin's UNSCOPED ts_timesheets select really does return other users' rows",
   (unscoped.data || []).some((row) => row.user_id === EMP), JSON.stringify(unscoped.data?.length));
const scoped = await execute({ id: ADMIN, email: "ob.admin@ajace.com", role: "admin" }, {
  table: "ts_timesheets", op: "select", columns: "id,user_id,draft",
  filters: [{ col: "user_id", val: ADMIN }, { col: "year", val: 2027 }, { col: "month", val: 4 }],
});
ok("...and the added user_id filter is what removes them",
   (scoped.data || []).every((row) => row.user_id === ADMIN), JSON.stringify(scoped.data));
const editsUnscoped = await execute({ id: HR, email: "ob.hr@ajace.com", role: "hr" }, {
  table: "ts_employee_edits", op: "select", columns: "id,user_id", filters: [{ col: "year", val: 2027 }],
});
ok("the same is true of ts_employee_edits, for HR as well as admin (staffRead)",
   (editsUnscoped.data || []).some((row) => row.user_id === EMP), String(editsUnscoped.data?.length));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end();
process.exit(fail === 0 ? 0 : 1);
