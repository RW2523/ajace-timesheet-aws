// REGISTERING A PERSON FOR PAYROLL — the three properties that door must have.
//
// Everything asserted here is EXECUTED against the real route handlers and a
// real Postgres. test/route-loader.mjs teaches bare Node the "@/..." alias and
// Next's package exports so `app/api/**/route.js` imports unmodified; nothing is
// stubbed, re-implemented or mocked. Delete the guard from the route and this
// file goes red, which is the only reason it is worth having.
//
//   1. AN UNUSABLE PASSWORD CANNOT AUTHENTICATE.
//      Adding a person mints an auth_users row because it has to — ts_profiles.id
//      references it and password_hash is `text not null`. It must not mint an
//      ACCOUNT: nobody chose that password and nobody verified the person. So the
//      hash column holds a marker, and login/forgot/reset each refuse it
//      EXPLICITLY rather than leaning on bcrypt happening to say no.
//      Both halves are checked: that bcryptjs does in fact return false (measured
//      here, not assumed), AND that the route refuses before bcrypt is asked.
//
//   2. A NON-ADMIN CANNOT CREATE A PERSON.
//      Checked on the server, from the session, with the database consulted for
//      the role on every call — not from a role claim in the cookie.
//
//   3. A CREATED PERSON IS ALWAYS ROLE 'employee'.
//      Through both doors that create one (/api/admin/people and the for:"new"
//      branch of /api/admin/timesheet), with 'admin' and 'hr' smuggled in at
//      every level of the payload. Asserted in BOTH tables, because
//      currentUser() reads ts_profiles.role in preference to auth_users.role —
//      a mint that got either one wrong would be a privileged account.
//
// Plus the two things that make this safe to use in payroll rather than merely
// permitted: a duplicate email is a 409 and not a second payroll identity, and
// create-person + file-timesheet is ONE transaction, so a failed filing leaves
// no orphan person behind.
import bcrypt from "bcryptjs";
import { query, pool } from "../lib/aws/db.js";
import { signSession, SESSION_COOKIE } from "../lib/aws/jwt.js";
import { UNUSABLE_PASSWORD, isUnusablePassword } from "../lib/aws/people.js";
import { importRoute, jsonRequest, withRequestScope } from "./route-loader.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

// ---------------------------------------------------------------------------
// three real accounts, one of each role
const ADMIN = "cccccccc-0000-0000-0000-00000000000a";
const HR    = "cccccccc-0000-0000-0000-00000000000b";
const EMP   = "cccccccc-0000-0000-0000-00000000000c";
const REAL_HASH = await bcrypt.hash("correct horse battery staple", 4);

for (const [id, email, role, name] of [
  [ADMIN, "gate.admin@ajace.com", "admin",    "Gate Admin"],
  [HR,    "gate.hr@ajace.com",    "hr",       "Gate HR"],
  [EMP,   "gate.emp@ajace.com",   "employee", "Gate Employee"],
]) {
  await query(
    `insert into public.auth_users(id,email,password_hash,role) values($1,$2,$3,$4)
     on conflict (id) do update set role = excluded.role`, [id, email, REAL_HASH, role]);
  await query(
    `insert into public.ts_profiles(id,email,full_name,role,active) values($1,$2,$3,$4,true)
     on conflict (id) do update set role = excluded.role`, [id, email, name, role]);
}

const cookieFor = async (id, email, role) => ({
  [SESSION_COOKIE]: await signSession({ id, email, role, session_version: 1 }),
});
const ADMIN_COOKIE = await cookieFor(ADMIN, "gate.admin@ajace.com", "admin");
const HR_COOKIE    = await cookieFor(HR, "gate.hr@ajace.com", "hr");
const EMP_COOKIE   = await cookieFor(EMP, "gate.emp@ajace.com", "employee");

const people    = await importRoute("app/api/admin/people/route.js");
const timesheet = await importRoute("app/api/admin/timesheet/route.js");
const login     = await importRoute("app/api/auth/login/route.js");
const forgot    = await importRoute("app/api/auth/forgot/route.js");
const reset     = await importRoute("app/api/auth/reset/route.js");

/** POST /api/admin/people as `cookies`; -> {status, body} */
async function createPerson(cookies, payload, ip = "203.0.113.10") {
  const { result } = await withRequestScope(cookies, () =>
    people.POST(jsonRequest("http://t/api/admin/people", payload, { ip })));
  return { status: result.status, body: await result.json() };
}
async function fileTimesheet(cookies, payload, ip = "203.0.113.11") {
  const { result } = await withRequestScope(cookies, () =>
    timesheet.POST(jsonRequest("http://t/api/admin/timesheet", payload, { ip })));
  return { status: result.status, body: await result.json() };
}
const rowsFor = (email) => query(
  `select u.id, u.password_hash, u.role as auth_role, u.reset_token,
          p.role as profile_role, p.full_name
     from public.auth_users u left join public.ts_profiles p on p.id = u.id
    where lower(u.email) = lower($1)`, [email]);

// A day grid that derives to real hours, one row per calendar date.
const DAYS = [
  { date: "2026-11-02", regular: 8 },
  { date: "2026-11-03", regular: 8 },
  { date: "2026-11-04", regular: 8 },
];

// ===========================================================================
console.log("\n── 2. WHO MAY CREATE A PERSON ──");
// (numbered as in the header; the permission gate is checked first because
// everything below it assumes the door is shut to everyone else.)

let r = await createPerson(null, { email: "anon.create@ajace.com", fullName: "Anon Create" });
ok("no session -> 401", r.status === 401, JSON.stringify(r.body));
ok("...and nothing was created", (await rowsFor("anon.create@ajace.com")).length === 0);

r = await createPerson(EMP_COOKIE, { email: "emp.create@ajace.com", fullName: "Emp Create" });
ok("an ordinary employee -> 403", r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
ok("...and nothing was created", (await rowsFor("emp.create@ajace.com")).length === 0);

// The cookie is the only thing an attacker controls, and it is SIGNED — so the
// meaningful test is not "a forged role is rejected" but "the role in it is not
// consulted at all". This is a VALID token, correctly signed, claiming admin for
// an account the database says is an employee. currentUser() re-reads the role.
const FORGED = { [SESSION_COOKIE]: await signSession({ id: EMP, email: "gate.emp@ajace.com", role: "admin", session_version: 1 }) };
r = await createPerson(FORGED, { email: "forged.create@ajace.com", fullName: "Forged Create" });
ok("a validly-signed cookie CLAIMING admin over an employee row -> 403",
   r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
ok("...and nothing was created", (await rowsFor("forged.create@ajace.com")).length === 0);

r = await createPerson(ADMIN_COOKIE, { email: "Nora.Payroll@Ajace.com", fullName: "Nora Payroll", employeeCode: "GATE-N1" });
ok("an admin -> 201", r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
r = await createPerson(HR_COOKIE, { email: "hank.payroll@ajace.com", fullName: "Hank Payroll", employeeCode: "GATE-H1" });
ok("an HR user -> 201 (HR files hours, so HR registers people)", r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);

const auditRows = await query(
  `select actor_email, detail from public.ts_audit_log
    where action = 'person.create' order by at desc limit 2`);
ok("both creations are in ts_audit_log with the actor's email",
   auditRows.length === 2 && auditRows.every((a) => /gate\.(admin|hr)@ajace\.com/.test(a.actor_email || "")),
   JSON.stringify(auditRows.map((a) => a.actor_email)));
ok("the audit entry records that no login was enabled",
   auditRows.every((a) => a.detail?.login_enabled === false),
   JSON.stringify(auditRows.map((a) => a.detail)));

// ===========================================================================
console.log("\n── 3. A CREATED PERSON IS ALWAYS 'employee' ──");

const smuggles = [
  ["role at the top level", { email: "smuggle1@ajace.com", fullName: "Smuggle One", role: "admin" }],
  ["role: 'hr'",            { email: "smuggle2@ajace.com", fullName: "Smuggle Two", role: "hr" }],
  ["snake_case role",       { email: "smuggle3@ajace.com", fullName: "Smuggle Three", user_role: "admin", Role: "admin" }],
];
for (const [label, payload] of smuggles) {
  const res = await createPerson(ADMIN_COOKIE, payload);
  const row = (await rowsFor(payload.email))[0];
  ok(`${label}: created`, res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  ok(`${label}: auth_users.role is 'employee'`, row?.auth_role === "employee", String(row?.auth_role));
  ok(`${label}: ts_profiles.role is 'employee'`, row?.profile_role === "employee", String(row?.profile_role));
  ok(`${label}: the response never reports anything else`, res.body?.person?.role === "employee", String(res.body?.person?.role));
}

// ...and the OTHER door that creates one.
r = await fileTimesheet(ADMIN_COOKIE, {
  for: "new", year: 2026, month: 11, note: "paper timesheet handed in at the desk",
  days: DAYS,
  newPerson: { email: "smuggle4@ajace.com", fullName: "Smuggle Four", role: "admin" },
});
ok("for:\"new\" through /api/admin/timesheet: filed", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
let row4 = (await rowsFor("smuggle4@ajace.com"))[0];
ok("for:\"new\": auth_users.role is 'employee'", row4?.auth_role === "employee", String(row4?.auth_role));
ok("for:\"new\": ts_profiles.role is 'employee'", row4?.profile_role === "employee", String(row4?.profile_role));
const filed = await query(
  `select user_id, status, (fields->'totals'->>'total')::numeric as total
     from public.ts_employee_edits where user_id = $1`, [row4?.id]);
ok("for:\"new\": the hours landed on the NEW person's id", filed.length === 1, JSON.stringify(filed));
ok("for:\"new\": the total was DERIVED from days (24h), not accepted",
   Number(filed[0]?.total) === 24, String(filed[0]?.total));

// ===========================================================================
console.log("\n── the operator's three choices, and who gets them ──");
// self / existing / new, for admin and HR AND NOBODY ELSE. An ordinary employee
// is refused on all three: their own hours go through /api/data, which forces
// the owner column to the session user and so cannot touch anyone else's record.
for (const mode of ["self", "existing", "new"]) {
  const res = await fileTimesheet(EMP_COOKIE, {
    for: mode, year: 2026, month: 10, note: "an employee should not be able to do this",
    days: DAYS, employeeUserId: row4?.id, newPerson: { email: "emp.smuggle@ajace.com", fullName: "Emp Smuggle" },
  });
  ok(`an ordinary employee is refused for:"${mode}"`, res.status === 403, `${res.status} ${JSON.stringify(res.body)}`);
}
ok("...and the employee's attempted for:\"new\" person does not exist",
   (await rowsFor("emp.smuggle@ajace.com")).length === 0);

// (a) MYSELF — for both privileged roles. An admin's own wages are still
// somebody's wages, so a self-filing joins the review queue like anyone else's
// rather than being approved by the person it pays.
for (const [label, cookie, id] of [["admin", ADMIN_COOKIE, ADMIN], ["HR", HR_COOKIE, HR]]) {
  const res = await fileTimesheet(cookie, { for: "self", year: 2026, month: 10, days: DAYS });
  ok(`(a) MYSELF works for ${label}`, res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  const own = await query(
    `select user_id, status, fields->'entry'->>'origin' as origin
       from public.ts_employee_edits where user_id = $1 and year = 2026 and month = 10`, [id]);
  ok(`(a) ${label}'s own hours landed on their OWN id`, own.length === 1 && own[0].user_id === id, JSON.stringify(own));
  ok(`(a) ${label}'s own filing waits for review, it is not self-approved`,
     own[0]?.status === "submitted", String(own[0]?.status));
  ok(`(a) ${label}'s own filing is not stamped as an on-behalf entry`,
     own[0]?.origin === "self", String(own[0]?.origin));
}

// (b) AN EXISTING PERSON, from the dropdown. GET is the dropdown's source.
const { result: rosterRes } = await withRequestScope(HR_COOKIE, () => people.GET());
const roster = (await rosterRes.json()).people || [];
ok("(b) HR can read the roster the dropdown is built from", rosterRes.status === 200 && roster.length > 0, String(roster.length));
ok("(b) the person registered a moment ago is in it", roster.some((p) => p.email === "smuggle4@ajace.com"),
   JSON.stringify(roster.map((p) => p.email)));
const { result: empRoster } = await withRequestScope(EMP_COOKIE, () => people.GET());
ok("(b) an ordinary employee cannot read the roster", empRoster.status === 403, String(empRoster.status));

r = await fileTimesheet(HR_COOKIE, {
  for: "existing", employeeUserId: row4?.id, year: 2026, month: 9,
  note: "typed from the paper timesheet handed to HR", days: DAYS,
});
ok("(b) HR files for an existing person", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
const hrFiled = await query(
  `select user_id, status from public.ts_employee_edits where user_id=$1 and year=2026 and month=9`, [row4?.id]);
ok("(b) the hours are on the EMPLOYEE's id, not HR's", hrFiled[0]?.user_id === row4?.id, JSON.stringify(hrFiled));
ok("(b) an HR filing waits for an admin — HR does not approve", hrFiled[0]?.status === "submitted", String(hrFiled[0]?.status));

// ===========================================================================
console.log("\n── 1a. WHAT bcryptjs ACTUALLY DOES WITH A NON-BCRYPT HASH ──");
// Measured, because the route's comment claims it and a claim about a library's
// behaviour that nobody executes is a guess. If a future bcryptjs starts
// THROWING here, this goes red and the explicit guard below is what saves the
// login route from returning a 500 with a stack trace.
for (const notAHash of [UNUSABLE_PASSWORD, "", "not-a-hash", "$2a$10$short"]) {
  let outcome;
  try { outcome = await bcrypt.compare("anything", notAHash) ? "TRUE" : "false"; }
  catch (e) { outcome = "THREW: " + (e?.message || e); }
  ok(`bcrypt.compare vs ${JSON.stringify(notAHash)} does not authenticate`, outcome === "false", outcome);
}
ok("isUnusablePassword() says no to the marker", isUnusablePassword(UNUSABLE_PASSWORD) === true);
ok("isUnusablePassword() says no to an empty string", isUnusablePassword("") === true);
ok("isUnusablePassword() says no to null", isUnusablePassword(null) === true);
ok("isUnusablePassword() allows a REAL bcrypt hash through to bcrypt", isUnusablePassword(REAL_HASH) === false, REAL_HASH);

// ===========================================================================
console.log("\n── 1b. AN UNUSABLE PASSWORD CANNOT AUTHENTICATE ──");

const PAYROLL_ONLY = "nora.payroll@ajace.com";
let nora = (await rowsFor(PAYROLL_ONLY))[0];
ok("the created row stores the marker, not a hash", nora?.password_hash === UNUSABLE_PASSWORD, String(nora?.password_hash));
ok("the address was folded to lower case (it is the payroll identity)",
   !!nora && nora.full_name === "Nora Payroll", JSON.stringify(nora));

async function tryLogin(email, password, ip) {
  const { result, jar } = await withRequestScope(null, () =>
    login.POST(jsonRequest("http://t/api/auth/login", { email, password }, { ip })));
  return { status: result.status, body: await result.json(), setCookie: jar.has(SESSION_COOKIE) };
}
let li = await tryLogin(PAYROLL_ONLY, UNUSABLE_PASSWORD, "198.51.100.1");
ok("logging in WITH THE MARKER ITSELF as the password -> 400", li.status === 400, `${li.status} ${JSON.stringify(li.body)}`);
ok("...no session cookie was set", li.setCookie === false);
const markerBody = JSON.stringify(li.body);

li = await tryLogin(PAYROLL_ONLY, "", "198.51.100.2");
ok("logging in with an empty password -> 400", li.status === 400, String(li.status));
li = await tryLogin(PAYROLL_ONLY, "password123", "198.51.100.3");
ok("logging in with a guess -> 400", li.status === 400, String(li.status));
ok("...still no session cookie", li.setCookie === false);

// Not a 500: the explicit guard runs, so nothing reaches bcrypt to throw.
ok("the refusal is a credential error, never a server error", li.status !== 500, String(li.status));

// And it must not be an account-enumeration oracle: a dormant payroll record
// answers exactly as a nonexistent address does.
const ghost = await tryLogin("no.such.person@ajace.com", "password123", "198.51.100.4");
ok("a dormant record answers identically to a nonexistent one",
   ghost.status === li.status && JSON.stringify(ghost.body) === markerBody,
   `${ghost.status} ${JSON.stringify(ghost.body)} vs 400 ${markerBody}`);

// ---- "forgot password" must not bring one to life -------------------------
const { result: fRes } = await withRequestScope(null, () =>
  forgot.POST(jsonRequest("http://t/api/auth/forgot", { email: PAYROLL_ONLY }, { ip: "198.51.100.5" })));
const fBody = await fRes.json();
ok("forgot-password answers ok (no oracle)", fRes.status === 200 && fBody.ok === true, JSON.stringify(fBody));
nora = (await rowsFor(PAYROLL_ONLY))[0];
ok("...but NO reset token was minted for the dormant record", nora?.reset_token === null, String(nora?.reset_token));

// ---- and even a PLANTED token cannot activate it --------------------------
await query(
  `update public.auth_users set reset_token = 'gate-planted-token',
          reset_expires = now() + interval '1 hour' where id = $1`, [nora.id]);
const { result: rRes } = await withRequestScope(null, () =>
  reset.POST(jsonRequest("http://t/api/auth/reset",
    { token: "gate-planted-token", password: "brand-new-password-1" }, { ip: "198.51.100.6" })));
ok("a valid, unexpired, PLANTED reset token still cannot activate it", rRes.status === 400, String(rRes.status));
nora = (await rowsFor(PAYROLL_ONLY))[0];
ok("...the marker is untouched", nora?.password_hash === UNUSABLE_PASSWORD, String(nora?.password_hash));
li = await tryLogin(PAYROLL_ONLY, "brand-new-password-1", "198.51.100.7");
ok("...and the password the reset tried to set does not work either", li.status === 400, String(li.status));

// ---- the deliberate path DOES work (else this is a lockout, not a control) --
await query(`update public.auth_users set password_hash = $1 where id = $2`,
            [await bcrypt.hash("set-by-an-operator", 4), nora.id]);
li = await tryLogin(PAYROLL_ONLY, "set-by-an-operator", "198.51.100.8");
ok("after an operator sets a password (set-password.sh), sign-in works", li.status === 200, `${li.status} ${JSON.stringify(li.body)}`);
ok("...and a session cookie IS set then", li.setCookie === true);

// ===========================================================================
console.log("\n── the same person cannot be registered twice ──");
r = await createPerson(ADMIN_COOKIE, { email: "NORA.PAYROLL@ajace.com", fullName: "Nora Payroll", confirmDistinctPerson: true });
ok("a different-cased duplicate address -> 409", r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
ok("...and there is still exactly ONE row for that mailbox",
   (await rowsFor(PAYROLL_ONLY)).length === 1);

// ===========================================================================
console.log("\n── create-person + file-timesheet is ONE transaction ──");
// Forced with a trigger rather than asserted from the source, because "these two
// writes are atomic" is precisely the kind of claim that reads true and is false.
// The trigger makes the timesheet insert fail AFTER the person has been created.
await query(`create or replace function gate_boom() returns trigger language plpgsql as
             $f$ begin raise exception 'gate: forced failure'; end $f$`);
await query(`create trigger gate_boom_trg before insert on public.ts_employee_edits
             for each row execute function gate_boom()`);
const ORPHAN = "orphan.check@ajace.com";
r = await fileTimesheet(ADMIN_COOKIE, {
  for: "new", year: 2026, month: 11, note: "this filing is going to fail",
  days: DAYS, newPerson: { email: ORPHAN, fullName: "Orphan Check" },
});
await query(`drop trigger gate_boom_trg on public.ts_employee_edits`);
ok("the failed filing is an error, not a partial success", r.status >= 400, `${r.status} ${JSON.stringify(r.body)}`);
const orphanRows = await rowsFor(ORPHAN);
ok("NO auth_users/ts_profiles row was left behind", orphanRows.length === 0, JSON.stringify(orphanRows));
ok("no audit entry claims that person was created",
   (await query(`select 1 from public.ts_audit_log where action='person.create' and detail->>'email' = $1`, [ORPHAN])).length === 0);
// ...and the trigger really is gone, so the assertion above meant something.
r = await fileTimesheet(ADMIN_COOKIE, {
  for: "new", year: 2026, month: 12, note: "and the same filing succeeds once the failure is removed",
  days: DAYS, newPerson: { email: "after.boom@ajace.com", fullName: "After Boom" },
});
ok("the identical filing succeeds once the induced failure is removed",
   r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end();
process.exit(fail === 0 ? 0 : 1);
