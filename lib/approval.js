// Manager approval — the ONE place the "was this timesheet signed off?" fact is
// defined, for both the server (extractor) and the browser (questionnaire,
// validation, admin display).
//
// TWO DIFFERENT FACTS, NEVER COLLAPSED INTO ONE BOOLEAN:
//   1. THE DOCUMENT CARRIED AN APPROVAL — machine-observed, with a quotable
//      string, a named approver and a confidence number.  -> detection.detected
//   2. A HUMAN ASSERTED THERE IS NO APPROVAL and submitted anyway.
//      -> questionnaire.managerApproval === "acknowledged_absent"
// (2) is a work queue: the timesheets somebody still has to chase. The moment
// the two are merged into `approved: true` that queue disappears, which is the
// only audit value this feature has.
//
// NOTHING HERE MAY EVER TOUCH HOURS. Approval answers "did a human sign off",
// never "are these numbers right". It is deliberately not an input to the
// extractor's accept gate, review routing, confidence, or any total.

// The bar a machine detection must clear to count as a real approval.
// 0.80 sits ABOVE CFG.minConfidence (0.75, which only asks "did we read the
// document at all") and just BELOW CFG.autoAcceptConfidence (0.85). A false
// positive here silently removes the only gate that catches an unapproved
// timesheet, so it must be stricter than "we managed to read the page".
// Anything below the bar is NOT a detection: it becomes a hint next to the
// acknowledgement checkbox, and a human still has to answer.
export const APPROVAL_MIN_CONFIDENCE = 0.8;

const EVIDENCE = ["signature", "approved_by_line", "approval_stamp",
  "portal_status", "approval_email"];

function str(v, max = 300) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function conf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
function isoDate(v) {
  const s = str(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// Loose name comparison for the self-approval check only. Never used to decide
// who anybody is — just "is the approver literally the worker".
function nameKey(v) {
  return String(v || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/**
 * Normalize the model's `manager_approval` block into the shape the app stores.
 * ALWAYS returns an object when extraction ran, so "the AI looked and found
 * nothing" is distinguishable from "no AI ran at all" (which is null).
 *
 * @param raw           data.manager_approval from the contract
 * @param employeeName  data.employee_name — used for the self-approval check
 * @param model         the model id that produced this read
 * @param legacy        {manager_name, approval_status} — the pre-existing
 *                      free-text fields, used only as a sub-threshold HINT
 */
export function normalizeApproval(raw, employeeName, model = null, legacy = null) {
  const src = raw && typeof raw === "object" ? raw : {};
  let present = src.present === true;
  let evidence = EVIDENCE.includes(src.evidence) ? src.evidence : null;
  let approver = str(src.approver_name, 120);
  let approvedOn = isoDate(src.approved_on);
  let verbatim = str(src.verbatim, 300);
  let confidence = conf(src.confidence);
  let fromLegacy = false;

  // Fallback for a model that ignored the new block but still filled the old
  // free-text fields. Deliberately capped BELOW the bar: there is no quotable
  // evidence behind it, so it can only ever surface as a hint the human confirms.
  if (!present && legacy && !raw) {
    const status = String(legacy.approval_status || "").toLowerCase();
    const legacyApprover = str(legacy.manager_name, 120);
    if (legacyApprover && /\b(approved|signed|authorised|authorized)\b/.test(status)) {
      present = true;
      approver = legacyApprover;
      confidence = Math.min(confidence || 0.6, APPROVAL_MIN_CONFIDENCE - 0.01);
      fromLegacy = true;
    }
  }

  // ---- the gate. Every clause exists because of a specific failure mode. ----
  let rejectReason = null;
  let detected = present;
  if (detected && confidence < APPROVAL_MIN_CONFIDENCE) {
    detected = false; rejectReason = "low_confidence";            // hedge -> ask a human
  }
  if (detected && !approver && !verbatim) {
    detected = false; rejectReason = "no_evidence";               // bare present:true
  }
  if (detected && approver && employeeName &&
      nameKey(approver) === nameKey(employeeName)) {
    detected = false; rejectReason = "self_approval";             // you can't sign your own
  }
  if (!present) rejectReason = "not_found";

  return {
    source: "ai",
    asked: true,
    detected,
    present,
    evidence,
    approver_name: approver,
    approved_on: approvedOn,
    verbatim,
    confidence: Math.round(confidence * 100) / 100,
    threshold: APPROVAL_MIN_CONFIDENCE,
    reject_reason: rejectReason,
    from_legacy_fields: fromLegacy,
    model: model || null,
  };
}

/**
 * Blocking validation. Returned strings go into validateTimesheet's `errors`,
 * which disables the Submit button — so the question must always be ANSWERABLE:
 * the questionnaire renders the approval card unconditionally, on the AI path
 * and the manual path alike.
 */
export function approvalErrors(questionnaire) {
  const q = questionnaire || {};
  const state = q.managerApproval;
  const det = q.approvalDetection || null;
  const errors = [];

  if (state === "detected") {
    // The only legitimate way into this state is a detection that cleared the
    // bar. If it didn't (hand-edited state, a stale object), fall back to the
    // acknowledgement rather than trusting the flag.
    if (!det || det.detected !== true) {
      errors.push("Confirm the manager-approval question before submitting.");
    }
    return errors;
  }
  if (state === "acknowledged_absent") {
    if (q.managerApprovalAck !== true) {
      errors.push("Tick the box to confirm this timesheet has no manager approval.");
    }
    return errors;
  }
  errors.push("Answer the manager-approval question before submitting.");
  return errors;
}

/**
 * The compact copy written to ts_employee_edits.fields.approval, so the admin
 * list can show a column without loading every questionnaire blob.
 * NOTE: `fields.approval` is its own key — nothing approval-related goes inside
 * fields.totals, which is money-bearing.
 */
export function approvalSummary(questionnaire) {
  const q = questionnaire || {};
  const det = q.approvalDetection || null;
  if (q.managerApproval === "detected" && det?.detected) {
    return {
      source: "ai",
      detected: true,
      approver_name: det.approver_name || null,
      approved_on: det.approved_on || null,
      confidence: det.confidence ?? null,
      override: false,
    };
  }
  if (q.managerApproval === "acknowledged_absent" && q.managerApprovalAck === true) {
    return {
      source: "employee_ack",
      detected: false,
      approver_name: null,
      approved_on: null,
      confidence: det?.confidence ?? null,
      override: q.approvalOverride === true,
    };
  }
  return { source: "unanswered", detected: false, approver_name: null,
           approved_on: null, confidence: null, override: false };
}

/**
 * One badge for every surface (employee questionnaire, admin drawer, admin
 * table). tone is a plain word so each surface picks its own colours.
 *
 * A row submitted BEFORE this shipped has no approval keys at all -> "unknown".
 * It must NEVER render as approved: back-filling green onto the entire existing
 * history would be a lie an auditor can't unpick.
 */
export function approvalBadge(questionnaire) {
  const q = questionnaire || {};
  const det = q.approvalDetection || null;
  if (q.managerApproval === undefined && q.managerApprovalAck === undefined && !det) {
    return { tone: "unknown", label: "—",
             detail: "Submitted before manager-approval capture existed." };
  }
  if (q.managerApproval === "detected" && det?.detected) {
    const who = det.approver_name ? ` — ${det.approver_name}` : "";
    const pct = det.confidence != null ? ` (${Math.round(det.confidence * 100)}%)` : "";
    return { tone: "detected", label: `Approval in document${who}${pct}`,
             detail: det.verbatim || null };
  }
  if (q.managerApproval === "acknowledged_absent" && q.managerApprovalAck === true) {
    return {
      tone: "acknowledged_absent",
      label: q.approvalOverride
        ? "No approval — employee overrode a detection"
        : "No approval — acknowledged by employee",
      detail: det?.present
        ? `AI saw: ${det.verbatim || det.approver_name || "possible approval"}`
        : null,
    };
  }
  return { tone: "unanswered", label: "Not answered", detail: null };
}
