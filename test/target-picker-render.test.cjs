#!/usr/bin/env node
// Render <TimesheetTargetPicker> for real and assert WHAT AN ADMIN SEES.
//
// WHY THIS EXISTS, on top of the AST checks in target-picker.test.mjs:
//
//   * `npm run build` proves the file compiles. It does not execute the
//     component, so a free variable in a branch — the ReferenceError class of
//     bug that test/questionnaire-contract.test.mjs was written for — builds
//     green and throws the first time an admin opens that branch.
//
//   * Several sentences in this component are load-bearing rather than
//     decorative, and a silent edit to any of them is a support ticket or a
//     wrong wage:
//       - "this does not create a working login" + the set-password.sh path.
//         An admin who believes they just created a user account will send that
//         person to a login screen that can never accept them.
//       - the "Add “X” as a new employee" offer. Before this component, typing
//         a name that matched nobody did NOTHING AT ALL: no message, a dead
//         submit button, no way forward. Losing that offer restores the dead end.
//       - the MYSELF branch saying the hours go to REVIEW. They land
//         'submitted', not 'approved' (app/api/admin/timesheet/route.js) — copy
//         claiming otherwise tells an admin their own wages are already signed off.
//
// Kept as .cjs because it hand-rolls a CommonJS module loader: JSX is compiled
// with Next's own bundled babel and the "@/…" aliases are resolved the way
// jsconfig.json resolves them. No browser, no DOM library, no database.
//
// Run:  node test/target-picker-render.test.cjs
const fs = require("fs"), path = require("path"), Module = require("module");
const babel = require("next/dist/compiled/babel/core");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
// Anchored to the file, not the shell's cwd: test/run.sh invokes this by
// absolute path from wherever the operator happens to be standing.
const ROOT = path.join(__dirname, "..");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith("@/")) req = path.join(ROOT, req.slice(2));
  return origResolve.call(this, req, ...rest);
};

function load(rel) {
  const file = path.join(ROOT, rel);
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), {
    filename: file, babelrc: false, configFile: false,
    // automatic: the source files don't import React, exactly as Next compiles them
    presets: [[require("next/dist/compiled/babel/preset-react"), { runtime: "automatic" }]],
    plugins: [require("next/dist/compiled/babel/plugin-transform-modules-commonjs")],
  });
  const m = new Module(file, null);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}

const Picker = load("components/TimesheetTargetPicker.js").default;
const ADMIN = { id: "u-admin", full_name: "Dana Ops", email: "dana@ajace.com", role: "admin" };
const PRIYA = { id: "u-1", full_name: "Priya Raman", email: "priya@ajace.com" };
const html = (value, extra = {}) => renderToStaticMarkup(
  React.createElement(Picker, {
    value, onChange: () => {}, roster: [PRIYA], people: [ADMIN, PRIYA], self: ADMIN,
    serverEmailError: "", ...extra,
  })
);

let pass = 0; const fails = [];
const ok = (l, c, d = "") => c ? (pass++, console.log("  ✓ " + l))
  : (fails.push(l + (d ? " — " + d : "")), console.log("  ✗ " + l + (d ? " — " + d : "")));

// 1. the DEFAULT state — the value the modal actually opens with, not one
//    invented here. Asserted from EMPTY_PICK so "the default is X" is a claim
//    about the shipped default rather than about this test's own fixture.
const { EMPTY_PICK } = load("lib/roster.js");
ok("the modal opens on SOMEONE ELSE, not MYSELF", EMPTY_PICK.mode === "other", EMPTY_PICK.mode);
ok("...with nobody preselected, so nothing can be filed without an explicit choice",
   EMPTY_PICK.pick === "" && EMPTY_PICK.newName === "" && EMPTY_PICK.newEmail === "");

const d = html(EMPTY_PICK);
ok("renders at all without throwing", d.length > 200);
ok('asks "Who is this timesheet for?"', d.includes("Who is this timesheet for?"));
ok("offers both Myself and Someone else", d.includes("Myself") && d.includes("Someone else"));
// Exactly one radio is checked, and it is the second one (Someone else). Both
// halves matter: two checked radios would mean the group name is wrong, and
// zero would mean neither option reflects the value it was given.
const checkedCount = (d.match(/checked=""/g) || []).length;
ok("exactly one of the two options is selected", checkedCount === 1, `found ${checkedCount}`);
ok("and it is Someone else — the meaning this button already had is preserved",
   d.indexOf('checked=""') > d.indexOf("Myself") && d.indexOf('checked=""') < d.indexOf("Someone else"));
ok("names the signed-in admin on the Myself option", d.includes("Dana Ops"));
ok("lists the roster in the datalist, spelled exactly as the matcher expects",
   d.includes('<option value="Priya Raman — priya@ajace.com">'),
   d.slice(d.indexOf("<datalist"), d.indexOf("</datalist>") + 11));
ok("no add-person panel until it is asked for", !d.includes("Add a new person to payroll"));

// 2. THE BUG THIS FEATURE FIXES: a name matching nobody
const nm = html({ mode: "other", pick: "Nobody Here", newName: "", newEmail: "" });
ok("an unmatched name does NOT fail silently — it says so",
   nm.includes("Nobody registered matches"));
ok("...and offers to add exactly that person by name",
   nm.includes("Add “Nobody Here” as a new employee"), "offer missing");

// 3. the add-person panel
const np = html({ mode: "new", pick: "Priya R Jr", newName: "Priya R Jr", newEmail: "" });
ok("the panel appears with Full name and Email", np.includes("Full name") && np.includes("Email"));
ok("email is marked required", /Email <span class="req"/.test(np));
ok("explains WHY email is required (payroll identity / export key)",
   np.includes("how payroll tells two people apart"));
ok("warns the account CANNOT log in", np.includes("does not create a working login"));
ok("says forgot-password will NOT activate it", np.includes("Forgot password"));
ok("names the real activation path", np.includes("deploy/scripts/set-password.sh"));
ok("states the new person is a plain employee", /added as a regular <b>employee<\/b>/.test(np));
ok("says the act is audited", np.includes("audit log"));
ok("offers a way back to the existing-person list", np.includes("Cancel"));

// 4. duplicate email is caught client-side, in the field, naming the clash
const dup = html({ mode: "new", pick: "", newName: "Priya Two", newEmail: "PRIYA@AJACE.COM" });
ok("a clashing email is flagged before submitting", dup.includes("already uses"));
ok("...and names who already has it", dup.includes("Priya Raman"));
ok("...and marks the field invalid", dup.includes('class="field invalid"'));
ok("the why-email hint is replaced by the error, not shown alongside it",
   !dup.includes("how payroll tells two people apart"));

// 5. a server-side error is surfaced on the field too
const srv = html({ mode: "new", pick: "", newName: "A B", newEmail: "x@y.com" },
                  { serverEmailError: "That email is already registered." });
ok("a server email error is shown on the email field", srv.includes("That email is already registered."));

// 6. MYSELF
const self = html({ mode: "self", pick: "", newName: "", newEmail: "" });
ok("MYSELF hides the employee search entirely", !self.includes("ts-admin-roster"));
ok("MYSELF says the hours still go to review (they land 'submitted', not approved)",
   self.includes("review queue"));

console.log("");
if (fails.length) { console.error(`❌ target-picker-render — ${pass} passed, ${fails.length} failed`);
  fails.forEach((f) => console.error("   " + f)); process.exit(1); }
console.log(`✅ ALL PASS  —  ${pass} passed, 0 failed`);
