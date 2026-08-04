#!/usr/bin/env node
// The <Questionnaire> prop contract, asserted from the AST.
//
// WHY THIS EXISTS: React silently DROPS props a component doesn't destructure
// and silently applies defaults for ones the caller forgot. So a caller wired to
// a different contract than the callee compiles, builds, renders, and passes
// every other test in this suite — while doing nothing.
//
// That is not hypothetical. It shipped:
//   * DashboardClient passed 7 props Questionnaire never destructured
//     (showErrors, onClearDayHours, onRestoreAiHours, onSetDayHours, onEditDay,
//     hoursOnDate, aiHoursOnDate).
//   * Questionnaire declared 2 the caller never passed (approval, setCalendar),
//     so their `= null` defaults always won.
//   * Effect 1 (ITEM 8): `canEditDays` was permanently false, so "Not worked"
//     set the label and LEFT THE HOURS IN `days` — the day read "not worked"
//     and was still paid.
//   * Effect 2 (ITEM 5): the seeding effect returned early on approval == null,
//     so every employee was pushed to the "I confirm this timesheet has NOT been
//     approved" checkbox, on signed documents included — a false attestation
//     written into append-only ts_employee_edits.
//
// Neither the syntax gate nor any behavioural test can see this: both files were
// individually valid and individually correct. Only comparing them catches it.
//
// Needs no database, no network and no build.
//
// Run:  node test/questionnaire-contract.test.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("next/dist/compiled/babel/parser");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CALLER = "components/DashboardClient.js";
const CALLEE = "components/Questionnaire.js";

let passed = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`); }
}

function ast(rel) {
  return parse(readFileSync(join(ROOT, rel), "utf8"), {
    sourceType: "unambiguous", plugins: ["jsx"], errorRecovery: false,
  });
}

// Minimal recursive walker — no @babel/traverse dependency needed.
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

// The names bound by a single destructured object parameter, e.g. ({ a, b = 1 }).
function objectParamNames(fnNode) {
  const p = fnNode?.params?.[0];
  if (!p || p.type !== "ObjectPattern") return null;
  const names = [];
  let rest = false;
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

// ---------------------------------------------------------------- callee side
const calleeTree = ast(CALLEE);
const questionnaire = findFunction(calleeTree, "Questionnaire");
ok(`${CALLEE} exports a Questionnaire function`, !!questionnaire);

const declared = questionnaire ? objectParamNames(questionnaire) : null;
ok("Questionnaire destructures a single props object", !!declared);
ok("Questionnaire does not use a rest element (contract stays explicit)",
   declared ? declared.rest === false : false);

// ---------------------------------------------------------------- caller side
const callerTree = ast(CALLER);
const usages = [];
walk(callerTree, (n) => {
  if (n.type === "JSXOpeningElement" && n.name?.type === "JSXIdentifier" && n.name.name === "Questionnaire") {
    usages.push(n);
  }
});
ok(`${CALLER} renders <Questionnaire> exactly once`, usages.length === 1,
   `found ${usages.length}`);

const el = usages[0];
const attrs = [];
let spread = false;
for (const a of el?.attributes || []) {
  if (a.type === "JSXSpreadAttribute") { spread = true; continue; }
  if (a.type === "JSXAttribute" && a.name?.type === "JSXIdentifier") {
    let ident = null;
    if (a.value?.type === "JSXExpressionContainer" && a.value.expression?.type === "Identifier") {
      ident = a.value.expression.name;
    }
    attrs.push({ prop: a.name.name, ident });
  }
}
ok("the call site uses no {...spread} (props stay auditable)", spread === false);

const passedNames = [...new Set(attrs.map((a) => a.prop))].sort();

// ------------------------------------------------------- the contract itself
const declaredNames = declared?.names || [];
const ignored = passedNames.filter((p) => !declaredNames.includes(p));
const unwired = declaredNames.filter((d) => !passedNames.includes(d));

ok("no prop is PASSED but never destructured (React would drop it silently)",
   ignored.length === 0, ignored.join(", "));
ok("no prop is DECLARED but never passed (its default would silently win)",
   unwired.length === 0, unwired.join(", "));

// ------------------------------------------- the values actually exist (scope)
// Catches the other half of the same failure: a prop spelled correctly on both
// sides but whose VALUE is a free variable in the enclosing component, which
// throws ReferenceError at render — invisible to a syntax gate.
const reviewStep = findFunction(callerTree, "ReviewStep");
ok(`${CALLER} has a ReviewStep function`, !!reviewStep);

const inScope = new Set(objectParamNames(reviewStep)?.names || []);
// module-level declarations are legitimate sources too
walk(callerTree, (n) => {
  if (n.type === "FunctionDeclaration" && n.id?.name) inScope.add(n.id.name);
});
for (const d of callerTree.program.body) {
  if (d.type === "VariableDeclaration") {
    for (const decl of d.declarations) if (decl.id?.type === "Identifier") inScope.add(decl.id.name);
  }
  if (d.type === "ImportDeclaration") {
    for (const s of d.specifiers) if (s.local?.name) inScope.add(s.local.name);
  }
}
// Locals declared inside ReviewStep itself.
if (reviewStep) {
  walk(reviewStep.body, (n) => {
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier") inScope.add(n.id.name);
    if (n.type === "FunctionDeclaration" && n.id?.name) inScope.add(n.id.name);
  });
}

const unbound = attrs.filter((a) => a.ident && !inScope.has(a.ident)).map((a) => `${a.prop}={${a.ident}}`);
ok("every prop value is a real binding in ReviewStep (no ReferenceError at render)",
   unbound.length === 0, unbound.join(", "));

// ------------------------------------------------- the two load-bearing props
// Named explicitly: these are the ones whose absence silently disabled ITEM 8
// and ITEM 5. A future refactor may rename them, but it must do so on BOTH
// sides, and the generic checks above already enforce that. This assertion is
// here so the failure message names the payroll consequence.
const holidayToggleProps = ["onClearDayHours", "onSetDayHours"];
ok("the holiday Worked/Not-worked toggles are wired (else 'Not worked' leaves hours in `days` and the day is still paid)",
   holidayToggleProps.every((p) => passedNames.includes(p) && declaredNames.includes(p)),
   holidayToggleProps.filter((p) => !(passedNames.includes(p) && declaredNames.includes(p))).join(", "));
ok("`approval` is wired (else every employee is asked to attest 'not approved', signed documents included)",
   passedNames.includes("approval") && declaredNames.includes("approval"));

// ------------------------------------------------------------------- summary
console.log("");
if (failures.length) {
  console.error(`❌ questionnaire-contract — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ALL PASS  —  ${passed} passed, 0 failed`);
