#!/usr/bin/env node
// THE AI VERDICT RECEIPT — believe the receipt, never the payload, and verify it
// against the CALLER.
//
// fields.review_status is the AI's verdict on ONE extraction. It is computed on
// the server but reaches the database THROUGH THE BROWSER, which used to make it
// simply whatever the browser said: any employee could POST
// review_status:"auto_accepted" beside hours they typed by hand and the row wore
// "AI found no problems" in the admin queue. lib/aws/jwt.js answers that with a
// signed receipt bound to the user /api/process ran for.
//
// Two writers now emit those keys — /api/data (an employee's own filing) and
// /api/admin/timesheet (a filing made on somebody's behalf, which since the
// filing flows were merged can also be AI-assisted). This asserts they share ONE
// implementation, and that its binding points at the caller.
//
// WHY THE BINDING MATTERS MORE THAN EVER. On an on-behalf filing there are two
// people in play: the admin who ran the extraction and holds the receipt, and
// the employee the hours are about, who has never touched /api/process. Checking
// the receipt against the TARGET would invert the rule and turn the stamp into a
// bearer token — any receipt for any person would authenticate any filing about
// them. That inversion is one identifier away and would be invisible in review,
// so it is executed here.
//
// Real jose, real signing, real verification. Needs no database and no network.
//
// Run:  node test/ai-fields.test.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiFieldsFrom, aiConfidenceFrom, aiStatusFrom } from "../lib/aws/ai-fields.js";
import { signAiVerdict, readAiVerdict, signSession, verifySession } from "../lib/aws/jwt.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let passed = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`); }
};

// ===========================================================================
console.log("— aiFieldsFrom: what a MISSING receipt means");
// It means what it says: no AI ran on this submission. Not "trust the payload".
const claimed = { review_status: "auto_accepted", flow: "consensus",
                  agent_trace: { handled_by: "made this up" } };
const none = aiFieldsFrom(null, claimed);
ok("no receipt -> review_status is null however loudly the payload claims otherwise",
   none.review_status === null, JSON.stringify(none));
ok("no receipt -> flow is null", none.flow === null);
ok("no receipt -> agent_trace is null (it travels with the verdict or not at all)",
   none.agent_trace === null);
ok("no receipt -> ai_status is 'manual'", aiStatusFrom(null) === "manual");
ok("no receipt -> ai_confidence is null, not a number off the wire",
   aiConfidenceFrom(null) === null);

console.log("\n— aiFieldsFrom: a VALID receipt wins over whatever the payload says");
const verdict = { reviewStatus: "needs_review", flow: "direct_serverless", confidence: 0.71 };
const got = aiFieldsFrom(verdict, claimed);
ok("the verdict comes from the receipt, not from the payload beside it",
   got.review_status === "needs_review" && got.flow === "direct_serverless",
   JSON.stringify(got));
ok("agent_trace is carried from the payload ONLY once the verdict verifies",
   got.agent_trace === claimed.agent_trace);
ok("ai_status becomes 'ok' — an AI really did produce these hours",
   aiStatusFrom(verdict) === "ok");
ok("ai_confidence comes from the receipt", aiConfidenceFrom(verdict) === 0.71);
ok("a non-numeric confidence on a receipt reads as null, never NaN into a numeric column",
   aiConfidenceFrom({ ...verdict, confidence: "high" }) === null &&
   aiConfidenceFrom({ ...verdict, confidence: NaN }) === null);
ok("a garbage payload cannot inject extra keys through this helper",
   Object.keys(aiFieldsFrom(verdict, "not an object")).sort().join(",") ===
     "agent_trace,flow,review_status");

// ===========================================================================
console.log("\n— the receipt is bound to ONE person, and it is the caller");
process.env.AUTH_JWT_SECRET ||= "test-only-secret-that-is-at-least-32-bytes-long";
const ADMIN = "aaaa1111-0000-4000-8000-000000000001";
const EMPLOYEE = "bbbb2222-0000-4000-8000-000000000002";

const stamp = await signAiVerdict({
  userId: ADMIN, reviewStatus: "auto_accepted", flow: "consensus", confidence: 0.93,
});
const asCaller = await readAiVerdict(stamp, ADMIN);
ok("the ADMIN who ran the extraction can redeem their own receipt",
   asCaller?.reviewStatus === "auto_accepted" && asCaller.flow === "consensus",
   JSON.stringify(asCaller));
ok("...and the confidence claim survives the round trip", asCaller?.confidence === 0.93);
// THE INVERSION TEST. This is the one that must stay red if somebody "fixes" a
// null confidence by verifying against the employee the timesheet is about.
ok("the same receipt read against the TARGET employee returns null",
   (await readAiVerdict(stamp, EMPLOYEE)) === null);
ok("a receipt for the EMPLOYEE cannot be stapled onto the admin's filing either",
   (await readAiVerdict(await signAiVerdict({ userId: EMPLOYEE, reviewStatus: "auto_accepted" }),
                        ADMIN)) === null);
ok("a tampered receipt verifies as nothing", (await readAiVerdict(stamp + "x", ADMIN)) === null);
ok("no receipt, an empty one, or a non-string is null — never a throw",
   (await readAiVerdict(null, ADMIN)) === null &&
   (await readAiVerdict("", ADMIN)) === null &&
   (await readAiVerdict({}, ADMIN)) === null);
ok("a receipt with no userId to check against is null",
   (await readAiVerdict(stamp, null)) === null);

// The two token families are signed with the same secret, so they must not be
// interchangeable. This was closed with an audience claim; assert both ways.
const session = await signSession({ id: ADMIN, email: "a@x.com", role: "admin", session_version: 1 });
ok("a SESSION cookie cannot stand in for an AI receipt",
   (await readAiVerdict(session, ADMIN)) === null);
ok("an AI receipt cannot stand in for a session cookie",
   (await verifySession(stamp)) === null);

// Backwards compatibility: receipts minted before the confidence claim existed
// carry no `c` and must still verify, reading back as null.
const legacy = await signAiVerdict({ userId: ADMIN, reviewStatus: "blocked", flow: "premium" });
const legacyRead = await readAiVerdict(legacy, ADMIN);
ok("a receipt with no confidence claim still verifies (additive, not breaking)",
   legacyRead?.reviewStatus === "blocked");
ok("...and reads back as a null confidence, which is the honest answer",
   legacyRead?.confidence === null);

// ===========================================================================
console.log("\n— both writers use the same module, with the same binding");
const dataSrc = readFileSync(join(ROOT, "lib/aws/data.js"), "utf8");
const routeSrc = readFileSync(join(ROOT, "app/api/admin/timesheet/route.js"), "utf8");

ok("lib/aws/data.js imports aiFieldsFrom rather than keeping its own copy",
   /import \{ aiFieldsFrom \} from "\.\/ai-fields\.js"/.test(dataSrc) &&
   /aiFieldsFrom\(aiVerdict, src\)/.test(dataSrc));
ok("...and still verifies against the user performing the write",
   /readAiVerdict\(body\?\.values\?\.fields\?\.ai_stamp, user\.id\)/.test(dataSrc));
ok("...and still strips the receipt itself out of the stored record",
   /delete fieldsOut\.ai_stamp;/.test(dataSrc));

ok("/api/admin/timesheet reads the receipt with readAiVerdict(…, user.id) — THE CALLER",
   /readAiVerdict\(bodyFields\.ai_stamp, user\.id\)/.test(routeSrc));
ok("...and NEVER against targetUserId (the inversion that would break the binding)",
   !/readAiVerdict\([^)]*targetUserId/.test(routeSrc));
ok("...and takes review_status/flow/agent_trace from the shared helper",
   /\.\.\.aiFieldsFrom\(aiVerdict, bodyFields\)/.test(routeSrc));
ok("...and no longer hardcodes the three nulls it used to",
   !/review_status: null,\s*\/\/ no AI ran/.test(routeSrc));
ok("ai_status is derived from the receipt, not the 'manual' literal it used to be",
   /aiStatusFrom\(aiVerdict\), aiConfidenceFrom\(aiVerdict\)/.test(routeSrc) &&
   !/,'manual'\)/.test(routeSrc));
ok("the receipt is stripped before the fields spread, so it is never stored",
   /const \{ ai_stamp: _receipt, entry: _clientEntry, \.\.\.carriedFields \} = bodyFields;/.test(routeSrc));
// The `entry` stamp is provenance the server owns. An employee putting it on
// their own submission would make self-entered hours read as hours an admin had
// already vouched for.
ok("a client-supplied `entry` stamp is stripped too, by both writers",
   /delete fieldsOut\.entry;/.test(dataSrc) && /entry: _clientEntry/.test(routeSrc));

// And /api/process signs the confidence, or the claim above is unreachable.
const processSrc = readFileSync(join(ROOT, "app/api/process/route.js"), "utf8");
ok("/api/process puts the extraction confidence on the receipt (both flows)",
   (processSrc.match(/confidence: employee\??\.?\.?confidence \?\? null/g) || []).length >= 2 ||
   (processSrc.match(/confidence: employee/g) || []).length >= 2, processSrc.match(/confidence: employee[^\n]*/g));

console.log("");
if (failures.length) {
  console.error(`❌ ai-fields — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ ALL PASS  —  ${passed} passed, 0 failed`);
