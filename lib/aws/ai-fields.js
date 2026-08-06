// ---------------------------------------------------------------------------
// "BELIEVE THE RECEIPT, NEVER THE PAYLOAD" — in one place, for both writers.
//
// fields.review_status / .flow / .agent_trace are the AI's verdict on ONE
// extraction. They are computed on the server (/api/process) but they reach the
// database THROUGH THE BROWSER, which used to make them simply whatever the
// browser said: any employee could POST fields.review_status:"auto_accepted"
// beside hours they typed by hand and the row wore "AI found no problems" in
// the admin queue. lib/aws/jwt.js answers that with a signed receipt bound to
// the user /api/process ran for, and the verdict is taken from the receipt.
//
// TWO routes now write those keys — /api/data (an employee's own filing) and
// /api/admin/timesheet (a filing made on somebody's behalf, which since the
// filing flows were merged can also be AI-assisted). Two copies of this rule
// would be two places for it to drift; the looser copy would win, and it would
// win silently, because a wrong review_status is a sorting hint nobody
// cross-checks. So the rule lives here, is called by both, and is executed by
// test/ai-fields.test.mjs.
//
// WHAT `verdict` IS: the return of readAiVerdict(stamp, userId) — null, or
// { reviewStatus, flow, confidence }. Verifying it is the CALLER's job and the
// binding is not negotiable: a receipt proves the AI ran for THAT person, so it
// is always checked against the user performing the write, never against the
// employee the timesheet is about. Inverting that would turn the receipt into a
// bearer token: an admin could staple an employee's own signed verdict onto an
// unrelated set of hours.
// ---------------------------------------------------------------------------

/**
 * The three `fields` keys, decided by the receipt.
 *
 * With no valid receipt all three are null — which means exactly what it says:
 * no AI ran on this submission. `agent_trace` is carried from the payload only
 * when the verdict verifies; it is a diagnostic blob with no signed form, so it
 * travels with the verdict it describes or not at all.
 */
export function aiFieldsFrom(verdict, bodyFields) {
  const src = bodyFields && typeof bodyFields === "object" && !Array.isArray(bodyFields)
    ? bodyFields : {};
  if (!verdict) {
    return { review_status: null, flow: null, agent_trace: null };
  }
  return {
    review_status: verdict.reviewStatus ?? null,
    flow: verdict.flow ?? null,
    agent_trace: src.agent_trace ?? null,
  };
}

/**
 * The extraction confidence, from the receipt only.
 *
 * ts_timesheets.ai_confidence is rendered as "the AI was N% sure about this
 * read". An unsigned number off the wire could assert 99% about hours nobody
 * extracted, so an unverified receipt yields null — the same answer as "no AI
 * ran", which is what it is. Receipts issued before the confidence claim
 * existed simply carry none and read as null too.
 */
export function aiConfidenceFrom(verdict) {
  const c = verdict?.confidence;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

/** "Did an AI actually produce these hours?" — the ts_timesheets.ai_status word. */
export function aiStatusFrom(verdict) {
  return verdict ? "ok" : "manual";
}
