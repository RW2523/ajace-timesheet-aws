// ---------------------------------------------------------------------------
// WHERE A SET OF HOURS IS SENT, AND WHOSE FOLDER ITS DOCUMENT LANDS IN.
//
// There is exactly ONE filing screen in this product (components/DashboardClient
// .js). It files for the signed-in person, and — for an admin or HR user — for
// somebody else. Those two cases go to DIFFERENT endpoints, and they have to:
//
//   /api/data                 lib/aws/data.js FORCES the owner column to the
//                             authenticated user on every write
//                             (cleanValues: `out[cfg.owner] = user.id`). That
//                             rule is what stands between one employee and
//                             another's payroll record, and it is not relaxed.
//   /api/admin/timesheet      a server-only, admin/HR-only route that re-checks
//                             the caller's role, derives the money from `days`,
//                             writes the row under the TARGET's id, demands a
//                             note, and leaves an audit trail.
//
// MIS-ROUTING IS ASYMMETRIC, which is why this module exists and why the rule
// is derived from an ID rather than from a UI mode flag:
//   * a SELF filing sent to the admin route still lands 'submitted'
//     (route.js: `const approved = !forSelf && canReview(user)`) — redundant,
//     loud, harmless.
//   * an ON-BEHALF filing sent to /api/data returns HTTP 200 and files the
//     employee's hours against the ADMIN's own payroll record, with origin
//     "employee", into an append-only table the client cannot repair.
//
// Kept JSX-free and free of node built-ins so test/filing-route.test.mjs can
// EXECUTE it — the same reasoning that put resolveTarget() in lib/roster.js.
// A rule this consequential must be run by a test, not read by a reviewer.
// ---------------------------------------------------------------------------

// The SAME case-folding comparison app/api/admin/timesheet/route.js re-derives
// server-side (`isSelfFiling(user, employeeUserId)`), imported rather than
// re-typed so the screen and the route cannot disagree about whose hours these
// are. roles.js is pure, so this stays a client-safe module.
import { isSelfFiling } from "./aws/roles.js";

export const DATA_ROUTE = "/api/data";
export const ADMIN_ROUTE = "/api/admin/timesheet";

/**
 * THE rule. `targetId` is the resolved subject of the timesheet — the id whose
 * payroll record these hours belong to — and `selfId` is the signed-in user.
 *
 * A person who does not exist yet (kind "new") has no id, so `targetId` is
 * null: that is never the caller, and it can only be filed through the admin
 * route, which registers them inside the same transaction.
 */
export function chooseFilingRoute(targetId, selfId) {
  return isSelfFiling({ id: selfId }, targetId) ? DATA_ROUTE : ADMIN_ROUTE;
}

/** True when these hours belong to the signed-in person. */
export function isSelfFilingTarget(targetId, selfId) {
  return chooseFilingRoute(targetId, selfId) === DATA_ROUTE;
}

/**
 * The S3 key for a filing's source document: `{targetId}/{YYYY-MM}/{ts}.{ext}`.
 *
 * THE FIRST SEGMENT IS THE SUBJECT OF THE TIMESHEET, NOT THE UPLOADER — for a
 * self filing those are the same value, and for an on-behalf filing they are
 * not. Three things depend on it:
 *
 *   * /api/storage/get is owner-or-admin, so a document stored under the
 *     admin's prefix is a hard 403 for the employee whose timesheet it is. The
 *     product's stated promise is "stored against the employee so they can see
 *     it too", and it would fail closed and silently;
 *   * the console finds a filing's document with `f.user_id === detail.user_id`,
 *     so the reviewer would get no "View document" button — indistinguishable
 *     from "no document was attached";
 *   * app/api/admin/timesheet/route.js REFUSES a path that does not start with
 *     `${targetUserId}/`. That check is the containment; this function is what
 *     makes the browser satisfy it honestly rather than by accident.
 *
 * Throws rather than composing `undefined/…`: a key with no owner is a filing
 * that would 400 after the bytes are already in the bucket.
 */
export function storageKeyFor(targetId, per, ext, now = Date.now()) {
  const id = String(targetId == null ? "" : targetId).trim();
  if (!id) throw new Error("no employee is selected, so there is nowhere to store this document");
  const month = Number(per?.month);
  const year = Number(per?.year);
  if (!Number.isFinite(month) || !Number.isFinite(year)) {
    throw new Error("no period is selected, so there is nowhere to store this document");
  }
  const safeExt = String(ext || "bin").replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "bin";
  return `${id}/${year}-${String(month).padStart(2, "0")}/${now}.${safeExt}`;
}

/**
 * "Is the file already in storage under the right key?" — the memo test for
 * DashboardClient's storedRef.
 *
 * `targetId` is part of it for the same reason `month`/`year` are. Without it,
 * picking employee A, attaching may.pdf, then switching to employee B and
 * filing returns A's path — and route.js:252 rejects the filing AFTER the bytes
 * are in the bucket, with a message about a document the admin thought they had
 * just attached to B.
 */
export function sameStoredFile(memo, { fileName, per, targetId } = {}) {
  if (!memo) return false;
  return memo.fileName === fileName &&
         memo.month === per?.month &&
         memo.year === per?.year &&
         String(memo.targetId ?? "") === String(targetId ?? "");
}
