// WHO MAY DO WHAT.
//
// One place, so a new privileged role cannot be added to some checks and missed
// in others — a role that is privileged in nine routes and unrecognised in the
// tenth is not a permissions model, it is a scattered 403.
//
// The roles:
//   employee — files their OWN hours, through /api/data, and nothing else.
//   hr       — files hours on behalf of people, and registers new people.
//   admin    — everything hr can do, PLUS review/approve, export, settings.
//
// HR DELIBERATELY CANNOT APPROVE OR EXPORT.
//   * Approve: whoever types a wage figure must not be the one who signs it off.
//     If HR could do both, "reviewed" would mean nothing on any row HR entered.
//     So a filing HR makes on someone's behalf lands as 'submitted' and waits
//     for an admin — see app/api/admin/timesheet/route.js.
//   * Export: the CSV is the bulk-PII egress path for the whole company. Adding
//     a second role to it doubles the number of accounts whose compromise leaks
//     everyone's pay, for no workflow gain — HR types hours, it does not need
//     to bulk-download them.
// Widening either of those is a deliberate decision, taken here, not an
// accident of copying `isPrivileged` into one more route.

export const ROLES = ["employee", "hr", "admin"];

/** May file a timesheet on ANOTHER person's behalf, and register new people. */
export const canFileForOthers = (user) => user?.role === "admin" || user?.role === "hr";

/** May create a person record (which mints a login row). Same set, named for
 *  the act rather than the route, so the two never drift apart silently. */
export const canCreatePeople = (user) => canFileForOthers(user);

/** May review/approve/reject, export payroll, change settings. ADMIN ONLY. */
export const canReview = (user) => user?.role === "admin";
export const canExport = (user) => user?.role === "admin";

// ---------------------------------------------------------------------------
// READING THE ROSTER AND THE SUBMISSION LIST — admin AND hr.
//
// This is NOT a convenience widening; without it HR's console actively lies.
// lib/aws/data.js scopes every table to the caller unless a rule says otherwise,
// so an HR user opening /admin would read ONE profile (their own) and ZERO
// submissions. The console does not fail visibly on that — it renders. The
// month-end chase list ("who still owes me a timesheet") is computed as
// "active people with no current submission", so with an empty submission list
// it names EVERY employee, including the ones who filed on time. HR then files
// a timesheet for somebody who already has one, /api/admin/timesheet answers
// needsSupersede, and the modal offers "replace it" — so a wrong read here ends
// with a real employee's own submission retired by an HR user who was told it
// did not exist. An empty list is not a safe default in payroll; it is a
// confident false statement.
//
// HR sees the same rows /api/admin/people already returns to HR (the roster) and
// the submissions HR is expected to chase and file. What stays admin-only is
// what roles.js already withheld and two reads that belong to reviewing, not to
// filing: ts_files (the stored source documents) and ts_admin_edits (the
// correction audit trail). HR needs neither to type hours, and /api/storage/get
// is admin-only anyway, so a Files tab for HR would be a column of 403s.
export const canSeeAllTimesheets = (user) => canFileForOthers(user);

// ---------------------------------------------------------------------------
// AND THE SAME RULE APPLIED TO THE ADMIN THEMSELVES.
//
// canReview() answers "is this person allowed to review timesheets". It does not
// answer "is this person allowed to review THIS timesheet", and for exactly one
// row the answer is no: their own.
//
// HR was fenced out of approving what HR typed on the reasoning above — whoever
// types a wage figure must not be the one who signs it off. That reasoning does
// not stop applying because the typist happens to be an admin. An admin filing
// their own hours (for:"self" here, or the ordinary employee dashboard via
// /api/data — an admin has a profile and can submit like anyone else) lands in
// 'submitted', in the queue that same admin administers. Without this rule they
// can then approve it, and the resulting row is indistinguishable in the payroll
// CSV from an ordinary employee's reviewed submission: the person who decided
// those hours get paid, and the person getting paid, are the same person, and
// nothing in the file says so.
//
// So: a submission is reviewed by SOMEBODY ELSE, or it is not reviewed.
// This blocks approve, reject and reopen alike — all three are review decisions,
// and it blocks corrections too, since a correction sets the paid final_total.
//
// THE COST, STATED PLAINLY: in a company with exactly one admin, that admin's
// own timesheet cannot be approved and so will not appear in the payroll export.
// That is the intended outcome, not an oversight — a payroll system where one
// account can pay itself unobserved is worse than one that requires a second
// admin before the first one can be paid. Appoint a second admin
// (deploy/scripts/make-admin.sh) and the deadlock is gone.
// One identity comparison, used by both halves of the rule below, so "is this
// the same person" cannot mean one thing on the filing side and another on the
// reviewing side. Case-folded because a uuid is hex and both cases are legal
// text for the same id — the DB compares them as uuid values, but these two
// checks compare the strings that arrive over HTTP.
const samePerson = (a, b) =>
  !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

export const isSelfReview = (user, submissionUserId) => samePerson(user?.id, submissionUserId);

// THE OTHER HALF, on the filing side — and it is not the same check twice.
//
// app/api/admin/timesheet/route.js decides "am I filing for myself?" in order to
// choose the status: on someone else's behalf an admin's filing lands 'approved'
// (there is no second party, and the note + provenance + audit trail are what
// make that acceptable), while anyone's own hours land 'submitted' for a real
// review. That decision was read off the MODE the client asked for, so
// {for:"existing", employeeUserId:<my own id>} took the on-behalf branch and
// auto-approved the caller's own wages in a single request — the same hole as
// self-review, through a door that skips review entirely rather than abusing it.
//
// So the question is answered by WHO THE HOURS ARE FOR, never by which word the
// client used to ask for them.
export const isSelfFiling = (user, targetUserId) => samePerson(user?.id, targetUserId);

/** The sentence the API returns and the console renders. One wording, one place,
 *  so the refusal always explains the same rule. */
export const SELF_REVIEW_REFUSAL =
  "You can't review your own timesheet. Whoever files hours must not be the one " +
  "who signs them off, so another admin has to approve, reject or correct this one.";
