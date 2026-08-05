#!/usr/bin/env node
// "Who is this timesheet for?" — the rule, and the wiring around it.
//
// WHY THIS EXISTS: this is the only screen in the app that can write hours onto
// a payroll record that is NOT the caller's own, and it can now also bring a
// brand-new person into existence. Two things can go wrong silently:
//
//   1. THE RULE. resolveTarget() decides whose id ends up in the POST body. If
//      it returns a target while the form is still incomplete, the submit button
//      goes live too early; if it returns the wrong `kind`, the modal says one
//      name and posts another. Neither shows up in a build.
//
//   2. THE WIRING. React silently DROPS props a component never destructures and
//      silently applies defaults for the ones the caller forgot — so a picker
//      wired to a different contract than its caller renders perfectly and does
//      nothing. That exact failure shipped here once already; see the header of
//      test/questionnaire-contract.test.mjs.
//
// Part 1 EXECUTES the rule (lib/roster.js is deliberately JSX-free so it can be
// imported directly). Part 2 reads the AST, because prop mismatches are not
// observable at runtime without a DOM.
//
// Needs no database, no network and no build.
//
// Run:  node test/target-picker.test.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_PICK, optionLabel, findPerson, emailProblem, resolveTarget, targetKey,
  mailboxKey, codeKey, nameKey, codeProblem, namesakes,
} from "../lib/roster.js";
// The SAME module the routes gate on. Imported here rather than restated so a
// divergence between what the console shows and what the server allows fails a
// test instead of becoming a scattered 403 the user reads as a data bug.
import { canFileForOthers, canReview } from "../lib/aws/roles.js";

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
// PART 1 — the rule, executed
// ===========================================================================
console.log("— resolveTarget: whose record the hours land on");

const ADMIN = { id: "u-admin", full_name: "Dana Ops", email: "dana@ajace.com", role: "admin", client: "HQ" };
const PRIYA = { id: "u-1", full_name: "Priya Raman", email: "priya@ajace.com", role: "employee", client: "Acme" };
const SAM   = { id: "u-2", full_name: "Sam Vale", email: "sam@ajace.com", role: "employee" };
const LEAVER = { id: "u-3", full_name: "Old Leaver", email: "leaver@ajace.com", role: "employee", active: false };
const ROSTER = [PRIYA, SAM];
const PEOPLE = [ADMIN, PRIYA, SAM, LEAVER];
const opts = { roster: ROSTER, people: PEOPLE, self: ADMIN };
const R = (v) => resolveTarget(v, opts);

// --- nothing chosen must never resolve --------------------------------------
ok("the default (nothing typed) resolves to NO target, so the form cannot submit",
   R(EMPTY_PICK) === null);
ok("a name that matches nobody resolves to NO target",
   R({ ...EMPTY_PICK, pick: "Nobody At All" }) === null);
ok("whitespace is not a person",
   R({ ...EMPTY_PICK, pick: "   " }) === null);

// --- MYSELF -----------------------------------------------------------------
const selfT = R({ ...EMPTY_PICK, mode: "self" });
ok("MYSELF resolves to the caller's OWN id, not a roster row",
   selfT?.kind === "self" && selfT.id === ADMIN.id, JSON.stringify(selfT));
ok("MYSELF shows the caller's own name in the UI copy",
   selfT?.name === "Dana Ops");
ok("MYSELF with no signed-in profile resolves to nothing (never a blank id)",
   resolveTarget({ ...EMPTY_PICK, mode: "self" }, { ...opts, self: null }) === null);

// --- EXISTING ---------------------------------------------------------------
const byLabel = R({ ...EMPTY_PICK, pick: optionLabel(PRIYA) });
ok("picking a roster option resolves to that person's id",
   byLabel?.kind === "existing" && byLabel.id === PRIYA.id, JSON.stringify(byLabel));
ok("the datalist option text is what the matcher matches (else nothing is ever selectable)",
   findPerson(ROSTER, optionLabel(SAM))?.id === SAM.id);
ok("typing just the email selects the person",
   R({ ...EMPTY_PICK, pick: "priya@ajace.com" })?.id === PRIYA.id);
ok("email matching is case- and space-insensitive",
   R({ ...EMPTY_PICK, pick: "  PRIYA@AJACE.COM " })?.id === PRIYA.id);
ok("an existing person carries their client through to the timesheet",
   byLabel?.client === "Acme");
// A roster row with no email must not be matched by an empty typed string.
ok("a person with no email is not matched by an empty-ish input",
   findPerson([{ id: "x", full_name: "No Mail" }], " ") === null);

// --- NEW PERSON -------------------------------------------------------------
const newOK = R({ mode: "new", pick: "", newName: "Priya R Junior", newEmail: "priya.jr@ajace.com" });
ok("a complete new person resolves to kind 'new' with NO id",
   newOK?.kind === "new" && newOK.id === null, JSON.stringify(newOK));
ok("a new person's name and email are trimmed before they are posted",
   R({ mode: "new", pick: "", newName: "  Ann Lee  ", newEmail: " ann@ajace.com " })?.name === "Ann Lee");
ok("a new person with NO email does not resolve (email is the payroll identity)",
   R({ mode: "new", pick: "", newName: "Ann Lee", newEmail: "" }) === null);
ok("a new person with a malformed email does not resolve",
   R({ mode: "new", pick: "", newName: "Ann Lee", newEmail: "ann@" }) === null);
ok("a new person with no name does not resolve",
   R({ mode: "new", pick: "", newName: "", newEmail: "ann@ajace.com" }) === null);
ok("a new person whose email is already taken does not resolve",
   R({ mode: "new", pick: "", newName: "Priya Two", newEmail: "priya@ajace.com" }) === null);
ok("...including a DEACTIVATED leaver's email, which the roster hides",
   R({ mode: "new", pick: "", newName: "Someone", newEmail: "leaver@ajace.com" }) === null);
ok("...and an ADMIN's email, which the roster also hides",
   R({ mode: "new", pick: "", newName: "Someone", newEmail: "dana@ajace.com" }) === null);
ok("...case-insensitively, so PRIYA@ vs priya@ cannot become two payroll records",
   R({ mode: "new", pick: "", newName: "Priya Two", newEmail: "PRIYA@AJACE.COM" }) === null);

// THE one that must never regress: no client input can name a role.
const forced = R({ mode: "new", pick: "", newName: "Sneaky", newEmail: "s@x.com", role: "admin" });
ok("a target NEVER carries a role — the client cannot ask for an admin account",
   forced !== null && !("role" in forced), JSON.stringify(forced));

// --- ONE HUMAN, ONE PAYROLL RECORD -------------------------------------------
// The bug this section exists for: three records were created for one person —
// all named "Nora New", all employee_code "EC-NORA", at nora.new@,
// nora.new+payroll@ and nora.nеw@ (Cyrillic е) — and the payroll export emitted
// all three as payable, 32 hours, HTTP 200. Nothing in the stack compared the
// PEOPLE; every check compared a user_id or a byte string and each was correct.
console.log("— one human, one payroll record");

const NORA = { id: "u-9", full_name: "Nora New", email: "nora.new@ajace.com",
               employee_code: "EC-NORA", role: "employee" };
const P2 = [...PEOPLE, NORA];
const N = (v) => resolveTarget({ mode: "new", pick: "", ...v }, { ...opts, people: P2 });

// the keys themselves
ok("a +tag is the same mailbox, so it is the same human",
   mailboxKey("nora.new+payroll@ajace.com") === mailboxKey("NORA.NEW@ajace.com"));
ok("...but a DOT is not folded — a.b@ and ab@ are two different people almost everywhere",
   mailboxKey("a.b@x.com") !== mailboxKey("ab@x.com"));
ok("an employee code is case- and space-insensitive",
   codeKey("  EC-NORA ") === codeKey("ec-nora"));
ok("a name is folded the same way for comparison",
   nameKey("nora  NEW") === nameKey("Nora New"));

// the browser refusals
ok("a +tag spelling of a registered address is refused, naming who has it",
   /Nora New/.test(String(emailProblem("nora.new+payroll@ajace.com", P2))));
ok("a look-alike Cyrillic е in an address is refused before anything is created",
   typeof emailProblem("nora.nеw@ajace.com", P2) === "string");
ok("an employee code somebody else holds is refused, naming them",
   /Nora New/.test(String(codeProblem("  ec-nora ", P2))));
ok("a free employee code is fine, and no code at all is fine",
   codeProblem("EC-0002", P2) === null && codeProblem("", P2) === null);

// the rule
ok("a new person on a +tag of an existing address does NOT resolve",
   N({ newName: "Nora Twin", newEmail: "nora.new+payroll@ajace.com" }) === null);
ok("a new person carrying somebody else's employee code does NOT resolve",
   N({ newName: "Nora Twin", newEmail: "totally.new@ajace.com", newCode: "ec-nora" }) === null);
ok("a new person with a name already on the books does NOT resolve until it is answered",
   N({ newName: "Nora New", newEmail: "nora.new2@ajace.com" }) === null);
const confirmed = N({ newName: "Nora New", newEmail: "nora.new2@ajace.com", confirmDistinct: true });
ok("...and DOES once the admin confirms it is a different human (two real John Smiths must both be payable)",
   confirmed?.kind === "new" && confirmed.confirmDistinct === true, JSON.stringify(confirmed));
ok("the confirmation travels on the target, so the server can record WHO said it",
   "confirmDistinct" in (confirmed || {}));
ok("namesakes() finds the existing person by folded name, not exact string",
   namesakes("  nora   new ", P2).length === 1);

// the screen that used to invite the duplicate
ok("typing an existing person's bare NAME selects them instead of offering to add a second one",
   findPerson([NORA, PRIYA], "Nora New")?.id === NORA.id);
ok("...but an AMBIGUOUS name selects nobody, because guessing which one gets paid is unforgivable",
   findPerson([NORA, { ...NORA, id: "u-10", email: "nora2@ajace.com" }], "Nora New") === null);

// --- the duplicate-email message is actionable -------------------------------
const clashMsg = emailProblem("PRIYA@ajace.com", PEOPLE);
ok("a clashing email names WHO already has it, so the admin can pick them instead",
   typeof clashMsg === "string" && clashMsg.includes("Priya Raman"), String(clashMsg));
ok("a free email produces no complaint", emailProblem("brand.new@ajace.com", PEOPLE) === null);

// --- targetKey: the supersede prompt must not survive a change of person -----
ok("switching person changes the target key (a stale 'replace it' prompt is dropped)",
   targetKey(byLabel) !== targetKey(R({ ...EMPTY_PICK, pick: optionLabel(SAM) })));
ok("MYSELF and an existing person never share a key",
   targetKey(selfT) !== targetKey(byLabel));
ok("no target has an empty key, so `undefined === undefined` can't look like a match",
   targetKey(null) === "");

// --- who may do any of this --------------------------------------------------
ok("admin may file for others", canFileForOthers({ role: "admin" }) === true);
ok("hr may file for others", canFileForOthers({ role: "hr" }) === true);
ok("an ordinary employee may NOT", canFileForOthers({ role: "employee" }) === false);
ok("an unknown/absent role may NOT (fail closed)",
   canFileForOthers(undefined) === false && canFileForOthers({}) === false
   && canFileForOthers({ role: "Admin" }) === false);

// --- the footer must not promise an approval that will not happen ------------
// Mirrors the route's `const approved = !forSelf && canReview(user)`. Getting
// this wrong tells an HR user their filing is payable when it is queued.
const willBeApproved = (self, kind) => kind !== "self" && canReview(self);
ok("admin filing for someone else -> approved and payable",
   willBeApproved({ role: "admin" }, "existing") === true);
ok("admin adding a new person -> approved and payable",
   willBeApproved({ role: "admin" }, "new") === true);
ok("HR filing for someone else -> NOT approved; the footer must say 'sent for review'",
   willBeApproved({ role: "hr" }, "existing") === false);
ok("an ADMIN filing for THEMSELVES -> NOT approved (nobody approves their own wages)",
   willBeApproved({ role: "admin" }, "self") === false);
ok("HR cannot review, so HR can never be shown the 'payable' copy",
   canReview({ role: "hr" }) === false);

// ===========================================================================
// PART 2 — the wiring, from the AST
// ===========================================================================
console.log("\n— the picker's prop contract and the admin-only gate");

function ast(rel) {
  return parse(readFileSync(join(ROOT, rel), "utf8"), {
    sourceType: "unambiguous", plugins: ["jsx"], errorRecovery: false,
  });
}
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, visit); }
    else if (v && typeof v.type === "string") walk(v, visit);
  }
}
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
function findFunction(tree, name) {
  let found = null;
  walk(tree, (n) => {
    if (found) return;
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression") && n.id?.name === name) found = n;
  });
  return found;
}
function usagesOf(tree, name) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === "JSXOpeningElement" && n.name?.type === "JSXIdentifier" && n.name.name === name) out.push(n);
  });
  return out;
}
function propsOf(el) {
  const names = []; let spread = false;
  for (const a of el?.attributes || []) {
    if (a.type === "JSXSpreadAttribute") { spread = true; continue; }
    if (a.type === "JSXAttribute" && a.name?.type === "JSXIdentifier") names.push(a.name.name);
  }
  return { names: [...new Set(names)].sort(), spread };
}

const adminTree = ast("components/AdminClient.js");
const pickerTree = ast("components/TimesheetTargetPicker.js");

// ---- <TimesheetTargetPicker> : caller vs callee -----------------------------
const picker = findFunction(pickerTree, "TimesheetTargetPicker");
ok("TimesheetTargetPicker.js exports a TimesheetTargetPicker function", !!picker);
const declared = picker ? objectParamNames(picker) : null;
ok("the picker destructures a single props object", !!declared);
ok("the picker uses no rest element (contract stays explicit)", declared ? declared.rest === false : false);

const pickerUses = usagesOf(adminTree, "TimesheetTargetPicker");
ok("AdminClient renders <TimesheetTargetPicker> exactly once", pickerUses.length === 1, `found ${pickerUses.length}`);
const pickerPassed = propsOf(pickerUses[0]);
ok("the picker call site uses no {...spread}", pickerPassed.spread === false);

const dNames = declared?.names || [];
const ignored = pickerPassed.names.filter((p) => !dNames.includes(p));
const unwired = dNames.filter((d) => !pickerPassed.names.includes(d));
ok("no picker prop is PASSED but never destructured (React drops it in silence)",
   ignored.length === 0, ignored.join(", "));
ok("no picker prop is DECLARED but never passed (its default would silently win)",
   unwired.length === 0, unwired.join(", "));

// The two that carry payroll consequences if they go missing.
ok("`people` is wired to the picker (else a duplicate email is only caught by the server, as an error the admin can't act on)",
   pickerPassed.names.includes("people") && dNames.includes("people"));
ok("`self` is wired to the picker (else the MYSELF option has nobody to be)",
   pickerPassed.names.includes("self") && dNames.includes("self"));

// ---- <AddTimesheetModal> : caller vs callee ---------------------------------
const modal = findFunction(adminTree, "AddTimesheetModal");
ok("AdminClient has an AddTimesheetModal function", !!modal);
const modalDeclared = modal ? objectParamNames(modal) : null;
const modalUses = usagesOf(adminTree, "AddTimesheetModal");
ok("AdminClient renders <AddTimesheetModal> exactly once", modalUses.length === 1, `found ${modalUses.length}`);
const modalPassed = propsOf(modalUses[0]);
const mNames = modalDeclared?.names || [];
ok("no AddTimesheetModal prop is passed-but-unread or declared-but-unpassed",
   modalPassed.names.join(",") === mNames.join(","),
   `passed [${modalPassed.names}] vs declared [${mNames}]`);

// ---- the admin/hr gate on the trigger ---------------------------------------
// Both the button and the modal must sit behind the SAME predicate. A gate on
// only one of them is a modal an employee can still reach.
const src = readFileSync(join(ROOT, "components/AdminClient.js"), "utf8");
ok("the trigger button is rendered behind the canFile gate",
   /\{canFile && \(\s*\n\s*<button/.test(src));
ok("the modal itself is ALSO behind the gate, not just the button that opens it",
   /\{adding && canFile && \(/.test(src));
ok("the gate is the shared predicate, not a hand-rolled role comparison",
   /canFile = canFileForOthers\(/.test(src));
ok("AdminClient contains no bare role === \"admin\" test guarding the filing feature",
   !/canFile\s*=\s*[^;]*role\s*===\s*"admin"/.test(src));

// ---- the POST body matches the route contract, field for field --------------
// These are read off app/api/admin/timesheet/route.js. A client that posts
// `newEmployee` to a route reading `newPerson` gets mode "existing" with a null
// employeeUserId — a 400, or worse a filing against the wrong person.
const routeSrc = readFileSync(join(ROOT, "app/api/admin/timesheet/route.js"), "utf8");
const body = src.slice(src.indexOf('fetch("/api/admin/timesheet"'),
                       src.indexOf('fetch("/api/admin/timesheet"') + 1400);

ok("the modal posts to /api/admin/timesheet (not /api/data, which forces the owner to the caller)",
   /fetch\("\/api\/admin\/timesheet"/.test(src));
ok("the route reads a `for` mode and the client sends one",
   /body\.for/.test(routeSrc) && /\bfor:\s*target\.kind === "self"/.test(body));
ok("the client's three modes are exactly the route's three modes",
   ["self", "existing", "new"].every((m) => body.includes(`"${m}"`))
   && /const MODES = \["self", "existing", "new"\]/.test(routeSrc));
ok("a NEW person is sent as `newPerson` — the key the route actually reads",
   /newPerson:\s*target\.kind === "new"/.test(body) && /body\.newPerson/.test(routeSrc));
ok("that person is created in the SAME transaction as the filing (no orphan on failure)",
   /createPersonTx\(client, newPerson\)/.test(routeSrc));
ok("employeeUserId is sent ONLY for an existing person",
   /employeeUserId:\s*target\.kind === "existing" \? target\.id : null/.test(body));
// The whole `newPerson:` value, brace-matched rather than "the next 160
// characters". The window version passed only while the literal stayed short:
// adding one commented field to it (employee_code) pushed the closing brace out
// of range and the assertion failed on a payload that was still perfectly
// correct. A security check that breaks when a comment is added gets deleted by
// the next person who hits it. This reads the actual value and is STRICTER than
// what it replaces — it covers the entire literal however long it grows, and it
// additionally asserts no role key anywhere else in the POST body.
const newPersonLiteral = (() => {
  const i = body.indexOf("newPerson:");
  if (i < 0) return "";
  const open = body.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < body.length; j++) {
    if (body[j] === "{") depth++;
    else if (body[j] === "}" && --depth === 0) return body.slice(i, j + 1);
  }
  return "";
})();
ok("newPerson carries NO role key — the client cannot ask for an admin account",
   newPersonLiteral.length > 0 && !/\brole\b/.test(newPersonLiteral)
   && !/\brole\s*:/.test(body), newPersonLiteral);
ok("no totals are posted — the server derives them from `days`",
   !/\b(regular|overtime|total):/.test(body));
ok("the duplicate-email 409 is detected by the route's own `duplicateEmail` marker",
   /j\.duplicateEmail/.test(src) && /duplicateEmail: e\.email/.test(routeSrc));
ok("the file input is disabled while adding a person (the route 400s on a file with no owner id)",
   /disabled=\{creatingPerson\}/.test(src)
   && /attach the document after the person is registered/.test(routeSrc));
ok("the note is required exactly when the route requires it (on someone else's behalf, not your own)",
   /noteRequired = !!target && target\.kind !== "self"/.test(src)
   && /if \(!forSelf && note\.length < 3\)/.test(routeSrc));
ok("the footer's approved/queued copy is derived from canReview, like the route's status",
   /willBeApproved = .*target\.kind !== "self" && canReview\(adminProfile\)/.test(src)
   && /const approved = !forSelf && canReview\(user\)/.test(routeSrc));

// ------------------------------------------------------------------- summary
console.log("");
if (failures.length) {
  console.error(`❌ target-picker — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ALL PASS  —  ${passed} passed, 0 failed`);
