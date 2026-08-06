#!/usr/bin/env node
// "Who is this timesheet for?" — the rule, and the wiring around it.
//
// WHY THIS EXISTS: this is the only control in the app that can write hours onto
// a payroll record that is NOT the caller's own, and it can now also bring a
// brand-new person into existence. It used to live in the admin console's
// "+ Add a timesheet" modal; that modal is gone and the control moved to the
// one filing screen (components/DashboardClient.js), so an admin filing for
// somebody gets the same document upload, AI extraction and review grid an
// employee gets. The RULE below is unchanged by that move, which is the point
// of keeping it in a JSX-free module. Two things can go wrong silently:
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
// imported directly). The WIRING checks moved with the control, into
// test/filing-route.test.mjs — which asserts the prop contract in its new home
// AND the thing that only exists now that both flows share one screen: which
// endpoint a given set of hours is sent to.
//
// Needs no database, no network and no build.
//
// Run:  node test/target-picker.test.mjs

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
// PART 2 — where this control now LIVES
// ===========================================================================
// The console's "+ Add a timesheet" modal is gone. There is one filing screen,
// components/DashboardClient.js, and it hosts this picker — so the wiring
// assertions that used to point at AdminClient point there instead. They were
// not deleted: they are the checks that keep the merge safe in its new home,
// and they now live in test/filing-route.test.mjs, which additionally asserts
// the thing that only matters now that both flows share a screen — WHICH
// ENDPOINT a set of hours is sent to.
//
// What stays here is this file's own subject: the RULE, executed above, and the
// two facts about its host that belong beside the rule rather than beside the
// plumbing.
console.log("\n— the rule's host");

const dashSrc = readFileSync(join(ROOT, "components/DashboardClient.js"), "utf8");
const adminSrc = readFileSync(join(ROOT, "components/AdminClient.js"), "utf8");
const routeSrc = readFileSync(join(ROOT, "app/api/admin/timesheet/route.js"), "utf8");

ok("the filing screen imports resolveTarget — the rule executed above IS the one it uses",
   /import \{ EMPTY_PICK, resolveTarget, nameKey \} from "@\/lib\/roster"/.test(dashSrc));
ok("...and seeds the picker at MYSELF, without mutating EMPTY_PICK's own contract",
   /useState\(\{ \.\.\.EMPTY_PICK, mode: "self" \}\)/.test(dashSrc));
ok("the gate is the shared predicate, not a hand-rolled role comparison",
   /const canFile = canFileForOthers\(profile\);/.test(dashSrc));
ok("the console no longer contains a second filing flow", !/AddTimesheetModal/.test(adminSrc));
ok("the footer's approved/queued copy is derived from canReview, like the route's status",
   /const willBeApproved = !!target && !forSelf && canReview\(profile\)/.test(dashSrc)
   && /const approved = !forSelf && canReview\(user\)/.test(routeSrc));

// ------------------------------------------------------------------- summary
console.log("");
if (failures.length) {
  console.error(`❌ target-picker — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ALL PASS  —  ${passed} passed, 0 failed`);
