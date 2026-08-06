#!/usr/bin/env node
// ONE FILING SCREEN, TWO ENDPOINTS — the rule, executed, and the wiring around
// it, read from the AST.
//
// WHY THIS EXISTS. The admin console's "+ Add a timesheet" modal and the
// employee dashboard used to be two separate filing flows, and the one used for
// the people who cannot file for themselves was the worse one: no document
// upload, no AI extraction, day-by-day clicking. They are now one screen, which
// means ONE screen decides whether a set of hours goes to /api/data (owner
// forced to the caller) or to /api/admin/timesheet (owner = the chosen target).
//
// Mis-routing is asymmetric, and that asymmetry is the whole reason this file
// is executable rather than a code review:
//   * a SELF filing sent to the admin route still lands 'submitted' — redundant,
//     loud, harmless;
//   * an ON-BEHALF filing sent to /api/data returns HTTP 200 and files the
//     employee's hours against the ADMIN's own payroll record, with origin
//     "employee", into an append-only table the client cannot repair.
//
// Part 1 EXECUTES lib/filing.js. Part 2 executes lib/validate.js's `onBehalf`
// contract — the one gate deliberately relaxed on the on-behalf path, so a
// drift here is the difference between "we relaxed one question on purpose" and
// "we relaxed the money gate by accident". Part 3 reads the AST, because the
// wiring is not observable at runtime without a browser.
//
// Needs no database, no network and no build.
//
// Run:  node test/filing-route.test.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseFilingRoute, isSelfFilingTarget, storageKeyFor, sameStoredFile,
  DATA_ROUTE, ADMIN_ROUTE,
} from "../lib/filing.js";
import { validateTimesheet } from "../lib/validate.js";

const require = createRequire(import.meta.url);
const { parse } = require("next/dist/compiled/babel/parser");
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`); }
}

// ===========================================================================
// PART 1 — the endpoint rule, executed
// ===========================================================================
console.log("— which endpoint a set of hours goes to");

const ME = "3f1b2c44-0000-4000-8000-00000000aaaa";
const THEM = "3f1b2c44-0000-4000-8000-00000000bbbb";

ok("my own id -> /api/data (the owner-forcing path, which is correct for me)",
   chooseFilingRoute(ME, ME) === DATA_ROUTE);
ok("...case-folded, because a uuid is hex and both cases are the same id",
   chooseFilingRoute(ME.toUpperCase(), ME) === DATA_ROUTE);
ok("somebody else's id -> /api/admin/timesheet",
   chooseFilingRoute(THEM, ME) === ADMIN_ROUTE);
ok("a person who does not exist yet (kind 'new', id null) -> the admin route",
   chooseFilingRoute(null, ME) === ADMIN_ROUTE);
ok("no target chosen at all -> the admin route, never /api/data",
   chooseFilingRoute(undefined, ME) === ADMIN_ROUTE &&
   chooseFilingRoute("", ME) === ADMIN_ROUTE);
ok("no signed-in id -> the admin route (fail towards the route that re-checks)",
   chooseFilingRoute(THEM, null) === ADMIN_ROUTE);
// The decision reads the ID. A mode string is a UI label and can disagree with
// the id beside it; app/api/admin/timesheet/route.js learned this the hard way
// ({for:"existing", employeeUserId:<my own id>} took the on-behalf branch and
// auto-approved the caller's own wages).
ok("isSelfFilingTarget agrees with chooseFilingRoute, so there is one answer",
   isSelfFilingTarget(ME, ME) === true && isSelfFilingTarget(THEM, ME) === false);

// ---- the storage key ------------------------------------------------------
console.log("— whose folder the source document lands in");
const PER = { month: 3, year: 2026 };
const key = storageKeyFor(THEM, PER, "pdf", 1700000000000);
ok("the key's first segment is the TARGET's id, not the uploader's",
   key === `${THEM}/2026-03/1700000000000.pdf`, key);
ok("the month is zero-padded, so the console's per-month lookup matches",
   storageKeyFor(THEM, { month: 12, year: 2026 }, "pdf", 1).startsWith(`${THEM}/2026-12/`));
ok("a self filing produces exactly what it always did — {myId}/{YYYY-MM}/…",
   storageKeyFor(ME, PER, "xlsx", 7) === `${ME}/2026-03/7.xlsx`);
ok("an extension is sanitised, so a key can never carry a path separator",
   storageKeyFor(ME, PER, "../../etc/passwd", 7) === `${ME}/2026-03/7.etcpasswd`,
   storageKeyFor(ME, PER, "../../etc/passwd", 7));
let threw = false;
try { storageKeyFor(null, PER, "pdf"); } catch { threw = true; }
ok("NO id -> it throws instead of composing `undefined/…` (which 400s after the upload)", threw);
threw = false;
try { storageKeyFor(THEM, {}, "pdf"); } catch { threw = true; }
ok("no period -> it throws too", threw);

// ---- the memo -------------------------------------------------------------
// THE A->B BUG: pick employee A, attach may.pdf, switch to employee B, file.
// Without targetId in the memo the browser hands back A's path and
// /api/admin/timesheet rejects the filing AFTER the bytes are in the bucket,
// with a message about a document the admin thought they had just attached.
const memo = { fileName: "may.pdf", month: 3, year: 2026, targetId: THEM, path: key };
ok("the same file, month and person is a hit (no needless re-upload)",
   sameStoredFile(memo, { fileName: "may.pdf", per: PER, targetId: THEM }) === true);
ok("a DIFFERENT PERSON is a miss — the A→B same-file bug",
   sameStoredFile(memo, { fileName: "may.pdf", per: PER, targetId: ME }) === false);
ok("a different month is a miss (the key embeds the period)",
   sameStoredFile(memo, { fileName: "may.pdf", per: { month: 4, year: 2026 }, targetId: THEM }) === false);
ok("a different file is a miss",
   sameStoredFile(memo, { fileName: "june.pdf", per: PER, targetId: THEM }) === false);
ok("no memo at all is a miss", sameStoredFile(null, { fileName: "x", per: PER, targetId: THEM }) === false);

// ===========================================================================
// PART 2 — the ONE gate deliberately relaxed, and its exact edge
// ===========================================================================
console.log("\n— validateTimesheet({ onBehalf }): what is dropped, and what is not");

const CAL = [
  { date: "2026-03-02", regular: 8, total: 8, filled: true },
  { date: "2026-03-03", regular: 8, total: 8, filled: true },
];
const FIELDS = { employee_name: "Priya Raman", client: "Acme" };
const base = (over = {}) => validateTimesheet({
  fields: FIELDS, calendar: CAL, questionnaire: {}, holidayWork: {}, holidays: {},
  ...over,
});

const selfV = base();
const behalfV = base({ onBehalf: true });
const SELF_ONLY = [
  "Enter the total regular hours you worked this month.",
  "Enter your total overtime hours (enter 0 if none).",
  "Answer whether you worked any weekends.",
];
for (const msg of SELF_ONLY) {
  ok(`self path still demands: "${msg}"`, selfV.errors.includes(msg));
  ok(`on-behalf drops it`, !behalfV.errors.includes(msg));
}
// The mismatch pair is dropped with them — it cannot fire without an answer,
// but assert the dropped set EXACTLY rather than trusting that.
const mismatch = base({ questionnaire: { regularHours: "999", overtimeHours: "999",
                                         workedWeekends: "no" } });
ok("self path blocks a stated total that disagrees with the calendar",
   mismatch.errors.some((e) => /stated regular hours/.test(e)) &&
   mismatch.errors.some((e) => /stated overtime hours/.test(e)));
const mismatchBehalf = base({ onBehalf: true,
  questionnaire: { regularHours: "999", overtimeHours: "999", workedWeekends: "no" } });
ok("on-behalf does not, because nobody asked the admin to state them",
   !mismatchBehalf.errors.some((e) => /stated (regular|overtime) hours/.test(e)));

// EXACTLY four messages differ, and they are those four. A fifth appearing here
// is a gate that got relaxed without anybody deciding to.
const dropped = selfV.errors.filter((e) => !behalfV.errors.includes(e));
ok("on-behalf drops exactly the self-attestation errors and nothing else",
   dropped.length === SELF_ONLY.length && SELF_ONLY.every((m) => dropped.includes(m)),
   JSON.stringify(dropped));
ok("...and adds nothing of its own",
   behalfV.errors.every((e) => selfV.errors.includes(e)), JSON.stringify(behalfV.errors));

// ---- and everything that must NOT move ------------------------------------
const noName = base({ onBehalf: true, fields: { client: "Acme" } });
ok("KEPT on-behalf: employee name is required",
   noName.errors.includes("Employee name is required."));
const noHours = base({ onBehalf: true, calendar: [] });
ok("KEPT on-behalf: a month with no hours is refused",
   noHours.errors.includes("No hours are entered for this month."));
const tooMany = base({ onBehalf: true,
  calendar: [{ date: "2026-03-02", regular: 30, total: 30, filled: true }] });
ok("KEPT on-behalf: more than 24h in a day is refused",
   tooMany.errors.some((e) => /more than a day/.test(e)), JSON.stringify(tooMany.errors));
const negative = base({ onBehalf: true,
  calendar: [{ date: "2026-03-02", regular: -5, total: -5, filled: true }] });
ok("KEPT on-behalf: negative hours are refused",
   negative.errors.some((e) => /negative hours/.test(e)), JSON.stringify(negative.errors));
ok("KEPT on-behalf: hoursProblems() — the SAME bounds the server refuses to store",
   tooMany.errors.length > 0 && negative.errors.length > 0);
ok("KEPT on-behalf: the manager-approval question still blocks",
   behalfV.errors.some((e) => /manager-approval/.test(e)), JSON.stringify(behalfV.errors));
const approved = base({ onBehalf: true,
  questionnaire: { managerApproval: "acknowledged_absent", managerApprovalAck: true } });
ok("...and is answerable from the document, so on-behalf CAN reach ok:true",
   approved.ok === true, JSON.stringify(approved.errors));
const holidayBad = base({ onBehalf: true,
  questionnaire: { managerApproval: "acknowledged_absent", managerApprovalAck: true },
  holidays: { "2026-03-05": "Test Day" }, holidayWork: { "2026-03-05": true },
  calendar: [...CAL, { date: "2026-03-05", regular: 0, total: 0, isHoliday: true }] });
ok("KEPT on-behalf: a holiday marked worked with no hours is refused",
   holidayBad.errors.some((e) => /marked "worked"/.test(e)), JSON.stringify(holidayBad.errors));

// ===========================================================================
// PART 3 — the wiring, from the AST
// ===========================================================================
console.log("\n— the filing screen's wiring");

function ast(rel) {
  return parse(readFileSync(join(ROOT, rel), "utf8"), {
    sourceType: "unambiguous", plugins: ["jsx"], errorRecovery: false,
  });
}
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "leadingComments" || k === "trailingComments") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, visit); }
    else if (v && typeof v.type === "string") walk(v, visit);
  }
}
/** The source of the function called `name`, or "" — so a check can be scoped
 *  to the ONE function that is allowed to contain the thing it looks for. */
function fnSource(src, tree, name) {
  let found = null;
  walk(tree, (n) => {
    if (found) return;
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression") && n.id?.name === name) found = n;
  });
  return found ? src.slice(found.start, found.end) : "";
}

const dashSrc = readFileSync(join(ROOT, "components/DashboardClient.js"), "utf8");
const dashTree = ast("components/DashboardClient.js");
const routeSrc = readFileSync(join(ROOT, "app/api/admin/timesheet/route.js"), "utf8");

// ---- ONE ts_employee_edits insert, and it is unreachable when !forSelf -----
// This is the assertion that matters most. lib/aws/data.js force-overwrites the
// owner column on every write, so ANY reachable ts_employee_edits insert on the
// on-behalf path files the employee's hours against the admin — silently, with
// HTTP 200, into an append-only table.
const editInserts = (dashSrc.match(/from\("ts_employee_edits"\)\s*\.insert/g) || []).length;
ok("DashboardClient contains exactly ONE ts_employee_edits insert", editInserts === 1,
   `found ${editInserts}`);
const selfFn = fnSource(dashSrc, dashTree, "submitAsSelf");
ok("...and it lives inside submitAsSelf()", /from\("ts_employee_edits"\)\s*\.insert/.test(selfFn));
const behalfFn = fnSource(dashSrc, dashTree, "submitOnBehalf");
ok("submitOnBehalf() contains NO /api/data write of any kind",
   behalfFn.length > 0 && !/api\.from\(/.test(behalfFn), behalfFn.slice(0, 120));
ok("submitOnBehalf() does not call saveBaseline or ensureTimesheet either",
   !/saveBaseline\(|ensureTimesheet\(/.test(behalfFn));
const submitFn = fnSource(dashSrc, dashTree, "submit");
ok("submit() picks between them on `forSelf` — the id-derived flag, not a mode",
   /if \(forSelf\) await submitAsSelf\(\);\s*\n?\s*else await submitOnBehalf\(/.test(submitFn),
   submitFn.slice(-400));
ok("`forSelf` is derived from the RESOLVED ID via lib/filing.js, never from who.mode",
   /const forSelf = isSelfFilingTarget\(target\?\.id, uid\)/.test(dashSrc));

// ---- the two /api/data writes at extraction time are guarded ---------------
const processFn = fnSource(dashSrc, dashTree, "processAI");
ok("processAI() persists the baseline only when the hours are the caller's own",
   /const persist = forSelf;/.test(processFn) && /if \(persist\) \{/.test(processFn));
const manualFn = fnSource(dashSrc, dashTree, "startManual");
ok("startManual() guards its saveBaseline on forSelf too",
   /if \(forSelf\) \{\s*\n\s*await saveBaseline\(/.test(manualFn), manualFn.slice(0, 200));
const writeDraftFn = fnSource(dashSrc, dashTree, "writeDraft");
ok("writeDraft() refuses outright when the target is not self",
   /if \(!forSelf\) return;/.test(writeDraftFn));

// ---- the draft guard is INSIDE the autosave effect's condition -------------
// Not a `draftOff` latch: that effect re-arms draftOff.current = false on every
// dependency change, so a latch set elsewhere would be undone by the next
// keystroke — and a cross-user update returns zero rows with error:null, so the
// screen would report "Draft saved" over an hour of unsaved payroll entry.
// The effect itself, from its own `useEffect(` back-scan to the debounce line —
// so the ORDER of the guards inside it is what is asserted, not their presence
// somewhere in a 1700-line file.
const autosave = (() => {
  const end = dashSrc.indexOf("const t = setTimeout(() => { writeDraftRef.current(); }, 1200)");
  const start = dashSrc.lastIndexOf("useEffect(() => {", end);
  if (end < 0 || start < 0) return "";
  // Comments stripped: the effect's own comment NAMES `draftOff.current = false`
  // while explaining why the guard sits above it, and an order check that
  // matched the prose would pass no matter where the guard actually was.
  return dashSrc.slice(start, end).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
})();
ok("the autosave effect returns early on !forSelf, before it re-arms draftOff",
   /if \(!forSelf\) return;/.test(autosave) &&
   autosave.indexOf("if (!forSelf) return;") < autosave.indexOf("draftOff.current = false"),
   autosave.slice(-300));
ok("the 'you can close this page' promise is conditional on forSelf",
   /!forSelf\s*\n?\s*\?\s*<span[^]*?not<\/b> saved automatically/.test(dashSrc) &&
   /you can close this page and come back/.test(dashSrc));

// ---- the resume read and the submissions prop are owner-scoped -------------
ok("the draft resume select carries .eq(\"user_id\", uid)",
   /\.select\("id,month,year,days,draft"\)\s*\n\s*\.eq\("user_id", uid\)/.test(dashSrc));
const pageSrc = readFileSync(join(ROOT, "app/dashboard/page.js"), "utf8");
ok("app/dashboard/page.js selects user_id and filters on it",
   /select\("id,user_id,/.test(pageSrc) && /\.eq\("user_id", user\.id\)/.test(pageSrc));

// ---- the POST body matches the route contract, field for field -------------
const bodyLiteral = (() => {
  const i = dashSrc.indexOf("const res = await fetch(ADMIN_ROUTE");
  if (i < 0) return "";
  const open = dashSrc.indexOf("JSON.stringify({", i);
  if (open < 0) return "";
  const from = dashSrc.indexOf("{", open + "JSON.stringify(".length);
  let depth = 0;
  for (let j = from; j < dashSrc.length; j++) {
    if (dashSrc[j] === "{") depth++;
    else if (dashSrc[j] === "}" && --depth === 0) return dashSrc.slice(from, j + 1);
  }
  return "";
})();
ok("the on-behalf POST body was found", bodyLiteral.length > 0);
ok("it goes to /api/admin/timesheet, the route that re-checks the caller's role",
   ADMIN_ROUTE === "/api/admin/timesheet" && /fetch\(ADMIN_ROUTE/.test(dashSrc));
ok("the client's three modes are exactly the route's three modes",
   ["self", "existing", "new"].every((m) => bodyLiteral.includes(`"${m}"`) || dashSrc.includes(`"${m}"`))
   && /const MODES = \["self", "existing", "new"\]/.test(routeSrc));
ok("a NEW person is sent as `newPerson` — the key the route actually reads",
   /newPerson:\s*kind === "new"/.test(bodyLiteral) && /body\.newPerson/.test(routeSrc));
ok("that person is created in the SAME transaction as the filing (no orphan on failure)",
   /createPersonTx\(client, newPerson\)/.test(routeSrc));
ok("employeeUserId is sent ONLY for an existing person",
   /employeeUserId:\s*kind === "existing" \? target\.id : null/.test(bodyLiteral));
const newPersonLiteral = (() => {
  const i = bodyLiteral.indexOf("newPerson:");
  if (i < 0) return "";
  const open = bodyLiteral.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < bodyLiteral.length; j++) {
    if (bodyLiteral[j] === "{") depth++;
    else if (bodyLiteral[j] === "}" && --depth === 0) return bodyLiteral.slice(i, j + 1);
  }
  return "";
})();
ok("newPerson carries NO role key anywhere — the client cannot ask for an admin account",
   newPersonLiteral.length > 0 && !/\brole\b/.test(newPersonLiteral) && !/\brole\s*:/.test(bodyLiteral),
   newPersonLiteral);
ok("NO totals are posted — the server derives them from `days`",
   !/\b(regular|overtime|total|daysWorked):/.test(bodyLiteral), bodyLiteral);
ok("`days` is posted, because the route refuses a filing without it",
   /days: calendar,/.test(bodyLiteral) && /'days' is required/.test(routeSrc));
ok("the note is sent, and required exactly when the route requires it",
   /note: note\.trim\(\)/.test(bodyLiteral) &&
   /const noteRequired = !forSelf;/.test(dashSrc) &&
   /if \(!forSelf && note\.length < 3\)/.test(routeSrc));
ok("supersede:true is only ever sent by the 409 prompt's second attempt",
   /supersede: !!supersede/.test(bodyLiteral) &&
   /onClick=\{\(\) => submit\(true\)\}/.test(dashSrc) &&
   /j\.needsSupersede/.test(dashSrc) && /needsSupersede: true/.test(routeSrc));
ok("the submit button passes supersede EXPLICITLY false (a bare handler would pass the click event)",
   /onClick=\{\(\) => submit\(false\)\}/.test(dashSrc));
ok("the ai_stamp receipt travels with the filing, and the route verifies it against the CALLER",
   /ai_stamp: aiMeta\?\.aiStamp \|\| null/.test(dashSrc) &&
   /readAiVerdict\(bodyFields\.ai_stamp, user\.id\)/.test(routeSrc));
ok("the duplicate-email 409 is detected by the route's own marker",
   /j\.duplicateEmail/.test(dashSrc) && /duplicateEmail: e\.email/.test(routeSrc));
ok("the duplicate employee CODE goes to the code field, not a banner",
   /j\.duplicateEmployeeCode/.test(dashSrc) && /setCodeErr\(/.test(dashSrc) &&
   /serverCodeError=\{codeErr\}/.test(dashSrc));
ok("the footer's approved/queued copy is derived from canReview, like the route's status",
   /const willBeApproved = !!target && !forSelf && canReview\(profile\)/.test(dashSrc) &&
   /const approved = !forSelf && canReview\(user\)/.test(routeSrc));

// ---- route:252 containment is intact --------------------------------------
// This assertion exists to break loudly if somebody "fixes" a path bug by
// loosening the check. It is the ONE line binding a storage prefix to a payroll
// subject; /api/storage/upload is a permission gate and knows nothing about who
// a filing is for.
ok("the route still refuses a document not stored under the target's prefix",
   /!path\.startsWith\(`\$\{targetUserId\}\/`\)/.test(routeSrc));
ok("...and rolls the whole filing back when it does",
   /!path\.startsWith\(`\$\{targetUserId\}\/`\)\) \{\s*\n\s*await client\.query\("rollback"\);/.test(routeSrc));
ok("the ts_files row is written with the TARGET's user_id, by the route",
   /insert into public\.ts_files[^]*?\[targetUserId, month, year,/.test(routeSrc));

// ---- the gate is the shared predicate, twice -------------------------------
ok("canFile is the shared predicate, not a hand-rolled role comparison",
   /const canFile = canFileForOthers\(profile\);/.test(dashSrc));
ok("DashboardClient contains no bare role === \"admin\" test guarding the filing feature",
   !/canFile\s*=\s*[^;]*role\s*===\s*"admin"/.test(dashSrc));
ok("the picker card is behind canFile",
   /\{canFile && \(mode === "upload"/.test(dashSrc));
// A 409 must be ANSWERED, not merely reported. The prompts render above a
// 1700-line review form, so an off-screen one looks exactly like the button
// doing nothing — and switching steps to reach them would strand the grid.
ok("a server 409 scrolls its own answer into view rather than switching steps",
   /scrollTo\("ts-conflict"\)/.test(dashSrc) && /scrollTo\("ts-target-card"\)/.test(dashSrc) &&
   !/setMode\("upload"\);\s*\n\s*setTimeout/.test(dashSrc));
ok("...and the target card comes back live while a new-person verdict is pending",
   /mode === "upload" \|\| emailErr \|\| codeErr \|\| sameNameFromServer/.test(dashSrc));
ok("...AND the resolved target is CLAMPED, so a stale `who` cannot outlive a demotion",
   /const target = canFile \? resolvedTarget : selfTarget;/.test(dashSrc));
ok("the roster is fetched only for someone who may use it",
   /if \(!canFile\) return;[^]*?fetch\("\/api\/admin\/people"\)/.test(dashSrc));
ok("the roster hides admins and deactivated leavers, exactly as the console's did",
   /people\.filter\(\(p\) => p\.role !== "admin" && p\.active !== false\)/.test(dashSrc));

// ---- the picker's prop contract, in its NEW home ---------------------------
function objectParamNames(fnNode) {
  const p = fnNode?.params?.[0];
  if (!p || p.type !== "ObjectPattern") return null;
  const names = []; let rest = false;
  for (const prop of p.properties) {
    if (prop.type === "RestElement") { rest = true; continue; }
    if (prop.key?.type === "Identifier") names.push(prop.key.name);
  }
  return { names: [...new Set(names)].sort(), rest };
}
const pickerTree = ast("components/TimesheetTargetPicker.js");
let pickerFn = null;
walk(pickerTree, (n) => {
  if (pickerFn) return;
  if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression") &&
      n.id?.name === "TimesheetTargetPicker") pickerFn = n;
});
const declared = objectParamNames(pickerFn);
ok("the picker still destructures one explicit props object, no rest element",
   !!declared && declared.rest === false);
const uses = [];
walk(dashTree, (n) => {
  if (n.type === "JSXOpeningElement" && n.name?.name === "TimesheetTargetPicker") uses.push(n);
});
ok("DashboardClient renders <TimesheetTargetPicker> exactly once", uses.length === 1, `found ${uses.length}`);
const passedProps = (() => {
  const names = []; let spread = false;
  for (const a of uses[0]?.attributes || []) {
    if (a.type === "JSXSpreadAttribute") { spread = true; continue; }
    if (a.type === "JSXAttribute") names.push(a.name.name);
  }
  return { names: [...new Set(names)].sort(), spread };
})();
ok("the picker call site uses no {...spread}", passedProps.spread === false);
const dNames = declared?.names || [];
ok("no picker prop is PASSED but never destructured (React drops it in silence)",
   passedProps.names.every((p) => dNames.includes(p)),
   passedProps.names.filter((p) => !dNames.includes(p)).join(", "));
ok("no picker prop is DECLARED but never passed (its default would silently win)",
   dNames.every((d) => passedProps.names.includes(d)),
   dNames.filter((d) => !passedProps.names.includes(d)).join(", "));
ok("`people` is wired (else a duplicate email is only caught by the server)",
   passedProps.names.includes("people"));
ok("`self` is wired (else the MYSELF option has nobody to be)",
   passedProps.names.includes("self"));

// ---- and the console no longer files anything ------------------------------
const adminSrc = readFileSync(join(ROOT, "components/AdminClient.js"), "utf8");
ok("AdminClient has no AddTimesheetModal", !/AddTimesheetModal/.test(adminSrc));
ok("AdminClient has no `adding` state and no '+ Add a timesheet' trigger",
   !/setAdding|\+ Add a timesheet/.test(adminSrc));
ok("AdminClient no longer POSTs to /api/admin/timesheet at all",
   !/fetch\("\/api\/admin\/timesheet"/.test(adminSrc));
ok("...but the door is not deleted: a signpost points at the timesheet tab",
   /href="\/dashboard\?for=other"/.test(adminSrc));
ok("the audit trail this console renders SURVIVES — enteredByAdmin and its readers",
   /const enteredByAdmin = \(e\) => e\.fields\?\.entry\?\.origin === "admin"/.test(adminSrc) &&
   (adminSrc.match(/enteredByAdmin/g) || []).length >= 3);
ok("...and the Admin-revisions note column survives",
   /tab === "revisions"/.test(adminSrc) && /a\.note \|\| "—"/.test(adminSrc));

// ------------------------------------------------------------------- summary
console.log("");
if (failures.length) {
  console.error(`❌ filing-route — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ALL PASS  —  ${passed} passed, 0 failed`);
