// ---------------------------------------------------------------------------
// ONE HUMAN, ONE PAYROLL IDENTITY — the email half.
//
// The email column IS the payroll identity: the roster dropdown, the review
// queue an admin reads before approving hours, and the join column of the
// exported CSV. Uniqueness is byte-wise (lower(email) in JS, and the
// auth_users_email_lower_uniq index in Postgres), which only protects a human
// if two addresses that LOOK the same have the same bytes.
//
// They did not. The shape rule used to be /^[^@\s]+@[^@\s]+\.[^@\s]+$/, and
// JavaScript's \s does not match the Cf (format) category, so HR could register
// "boss@ajace.com<U+200B>" beside the admin's own "boss@ajace.com", file 200
// hours against it, and the admin approving those hours saw two rows that were
// character-for-character identical on screen. Not a login (the twin carries
// the unusable-password marker and can never authenticate) — a defeat of the
// maker-checker control, which is the thing that makes an approval mean
// anything. The exported CSV totalled both.
//
// Every REFUSED case below was accepted, with HTTP 201, before this test.
// Needs no database: lib/roster.js is pure on purpose.
// ---------------------------------------------------------------------------
import { emailShapeProblem, hasNonAscii, mailboxKey } from "../lib/roster.js";
import { normalisePerson, PersonInputError } from "../lib/aws/people.js";

let pass = 0, fail = 0;
const ok = (cond, what) => {
  if (cond) { pass++; console.log("  ok   " + what); }
  else { fail++; console.log("  FAIL " + what); }
};

// The server's own door, exercised end to end through the function that every
// person-creating route calls. `throws` is what the route turns into a 400.
function personRefused(email) {
  try {
    normalisePerson({ email, fullName: "Twin Person" });
    return null;                      // accepted — that is the bug
  } catch (e) {
    return e instanceof PersonInputError ? e.message : `WRONG ERROR: ${e.name}`;
  }
}

console.log("\n-- invisible and look-alike characters are refused --");
// Named by codepoint, because the point is that they are unreadable in source.
const CONFUSABLES = [
  ["U+200B zero-width space, appended", "boss@ajace.com​"],
  ["U+2060 word joiner, appended",      "boss@ajace.com⁠"],
  ["U+200B inside the local part",      "bo​ss@ajace.com"],
  ["U+043E Cyrillic o for Latin o",     "bоss@ajace.com"],
  ["U+202E right-to-left override",     "boss@ajace.com‮"],
  ["U+00AD soft hyphen",                "bo­ss@ajace.com"],
  ["U+0001 control character",          "boss@ajace.com"],
  ["U+FEFF zero-width no-break space",  "bo﻿ss@ajace.com"],
];
for (const [what, email] of CONFUSABLES) {
  ok(!!personRefused(email), `refused: ${what}`);
}

console.log("\n-- the same trick spelled in plain ASCII is refused too --");
// hasNonAscii cannot see these; they still deliver to an existing mailbox.
const ASCII_TWINS = [
  ["trailing dot (root-anchored FQDN)", "boss@ajace.com."],
  ["leading dot in the local part",     ".boss@ajace.com"],
  ["trailing dot in the local part",    "boss.@ajace.com"],
  ["doubled dot in the local part",     "bo..ss@ajace.com"],
  ["doubled dot in the domain",         "boss@ajace..com"],
  ["hyphen-led domain label",           "boss@-ajace.com"],
  ["no domain at all",                  "boss@localhost"],
  ["xn-- internationalised domain",     "boss@xn--80ak6aa92e.com"],
];
for (const [what, email] of ASCII_TWINS) {
  ok(!!personRefused(email), `refused: ${what}`);
}

console.log("\n-- but real addresses still work (a control nobody can use gets removed) --");
const REAL = [
  "nora.new@ajace.com",
  "n@a.co",
  "first.last@sub.domain.ajace.com",
  "o'brien@ajace.com",
  "jean-luc@ajace-group.com",
  "r2d2@ajace2.com",
  "a_b@ajace.com",
  "contractor@ajace.co.uk",
  "x@ajace.technology",
];
for (const email of REAL) {
  const why = personRefused(email);
  ok(why === null, `accepted: ${email}${why ? "  -> " + why : ""}`);
}

console.log("\n-- normalisation still folds the harmless differences onto one identity --");
ok(normalisePerson({ email: "  BOSS@Ajace.COM  ", fullName: "A B" }).email === "boss@ajace.com",
   "case and surrounding spaces fold to one stored address");
ok(normalisePerson({ email: "boss@ajace.com ", fullName: "A B" }).email === "boss@ajace.com",
   "a trailing NBSP is trimmed, so the twin folds onto the real address");
ok(mailboxKey("boss+payroll@ajace.com") === mailboxKey("boss@ajace.com"),
   "+tag is the same mailbox, so it is caught as a duplicate rather than created");

console.log("\n-- the browser is warned by the SAME rule the server enforces --");
// If these two ever disagree, the admin is told an address is fine and then the
// server refuses it, or worse, the browser is stricter and nobody notices the
// server is not.
for (const [, email] of [...CONFUSABLES, ...ASCII_TWINS]) {
  const lowered = email.trim().toLowerCase();
  const browserSaysNo = hasNonAscii(lowered) || !!emailShapeProblem(lowered);
  ok(browserSaysNo, `browser also refuses ${JSON.stringify(email)}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}  —  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
