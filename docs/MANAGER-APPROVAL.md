# Manager approval (item 5) — what it is, where it is stored, who wires what

The operator's ask: *"look for the manager approval flow, and if a timesheet
does not have approval in the file, or the AI can't find it, say a yes / need
acknowledge if it is not present; if AI detected it can directly put as yes."*

## The rule that everything else follows

**Two different facts. Never one boolean.**

| Fact | Where it lives | What it means |
|---|---|---|
| The **document** carried an approval | `questionnaire.approvalDetection.detected === true` | Machine-observed, with a quotable string, a named approver, a date, a confidence number |
| A **human asserted there is none** | `questionnaire.managerApproval === "acknowledged_absent"` **and** `questionnaire.managerApprovalAck === true` | No document evidence exists; the employee submitted anyway |

Collapsing these into `approved: true` destroys the only audit value the feature
has. The second state *is the work queue* — the set of timesheets somebody still
has to chase for a signature — and it vanishes the moment the two are merged.

## Where it is stored (no migration, no schema change)

`submit()` already writes `questionnaire: { ...q, holidayWork }` to **both**
`ts_employee_edits` and `ts_timesheets`. Both columns are `jsonb`, both are in
the `lib/aws/data.js` write allowlists, and both are `JSON.stringify`'d
**centrally** by data.js — so pass plain objects, never pre-stringified ones
(invariant 4; double-encoding has silently destroyed writes in this project
twice).

Four keys ride along inside `questionnaire`:

```js
q.managerApproval    // "detected" | "acknowledged_absent" | null   (null = unanswered)
q.managerApprovalAck // boolean — true only when the employee ticked the box
q.approvalDetection  // the AI block below, or null. READ-ONLY: written once, never edited
q.approvalOverride   // true when the employee contradicted a positive detection
```

`q.approvalDetection` is exactly what `normalizeApproval()` returned:

```js
{ source: "ai", asked: true, detected, present, evidence, approver_name,
  approved_on, verbatim, confidence, threshold, reject_reason,
  from_legacy_fields, model }
```

Nothing approval-related goes near a money-bearing column. `monthly_*` and
`days_worked` are still derived server-side from `days` (invariant 1) and this
feature never sends a total.

`ts_employee_edits` and `ts_admin_edits` stay **append-only** (invariant 2): a
correction after submission is a NEW row, never an update.

### The compact copy for the admin list — one line still to add

`AdminClient`'s list query drives its columns off `e.fields.*` and does not
reliably carry `questionnaire` per row. So `submit()` in
`components/DashboardClient.js` should also put a compact copy on `fields`:

```js
import { approvalSummary } from "@/lib/approval";
// inside submit(), in the ts_employee_edits insert:
fields: { ...fields, totals: r,
          approval: approvalSummary({ ...q, holidayWork }),   // <-- add this
          flow: ..., agent_trace: ..., review_status: ... },
```

`approvalSummary()` returns
`{ source: "ai" | "employee_ack" | "unanswered", detected, approver_name,
approved_on, confidence, override }`. It is its own key — **nothing goes inside
`fields.totals`**, which is money-bearing.

## The confidence bar, and why 0.80

`APPROVAL_MIN_CONFIDENCE = 0.8` (`lib/approval.js`). A detection counts only when
**all four** hold:

1. `present === true`
2. `confidence >= 0.8`
3. `approver_name` **or** `verbatim` is non-empty — a bare `present: true` with
   nothing quotable is refused in code, not trusted
4. the approver is not the employee — you cannot approve your own timesheet, and
   the code checks it rather than relying on the prompt saying so

0.80 sits **above** `CFG.minConfidence` (0.75, which only asks "did we read the
document at all") and just **below** `CFG.autoAcceptConfidence` (0.85). A false
positive here silently removes the only gate that catches an unapproved
timesheet, so the bar has to be stricter than "we managed to read the page".

**A low-confidence detection behaves exactly like NOT detected.** It never
pre-answers anything; it surfaces as a hint above the checkbox — *"We may have
seen 'Approved by J. Smith' (62% sure — we only count it at 80% or better), so
please confirm below"* — and the employee still has to acknowledge.

## The flow

1. **Extraction.** `lib/directpp/prompts.js` now asks for a structured
   `manager_approval` block (present / evidence / approver_name / approved_on /
   verbatim / confidence) with rules about what is and is not evidence: a blank
   signature line, a bare "Approver:" label, a manager's name in a header,
   "Submitted"/"Pending"/"Draft", and the employee's own signature are all
   `present=false`.
2. **Gate.** `shapeEmployee()` calls `normalizeApproval()` and attaches
   `employee.approval`. This happens **after** `route()` and feeds nothing:
   approval is not an input to `acceptGate()`, `mapContract()`, the review
   status, the confidence, or any total. A signature says a human signed off; it
   never says the hours were read correctly.
3. **Transport.** `/api/process` returns it on `employee.approval` and also at
   the top level as `approval`.
4. **Questionnaire.** Detected → green card, answered **Yes** for the employee,
   showing the approver, the date, the confidence and the verbatim quote, plus
   one escape hatch ("That's not right — this isn't approved") that sets
   `approvalOverride` **without ever mutating the detection block**. Not detected
   → amber card with a required checkbox: *"I confirm this timesheet has not been
   approved by my manager, and I'm submitting it anyway."*
5. **Gate on submit.** `lib/validate.js` calls `approvalErrors()`; its strings go
   into `errors`, which disables the Submit button and short-circuits `submit()`.
   Silence is not an answer.

The verify round is deliberately untouched: `directVerifySystem()` still tells
the second model to *ignore any approver/manager signature*, because its one job
is re-counting hours. Approval evidence comes from the primary read only.

## Handoff — two optional props on `<Questionnaire>`

`components/Questionnaire.js` is written so that **missing the handoff is safe,
not silently wrong**. With no props wired it shows the acknowledgement path and
blocks submit until the employee ticks the box; it can never show a false
"approved".

```jsx
<Questionnaire
  q={q} setQ={setQ} holidays={holidays} holidayWork={holidayWork}
  setHolidayWork={setHolidayWork} calendar={calendar} totals={totals}
  approval={aiMeta?.approval || null}   /* data.approval from /api/process   */
  setCalendar={setCalendar}             /* enables the item-8 hour clearing  */
/>
```

- **`approval`** — pass `data.approval` (or `data.employee?.approval`) through
  whatever state holds the extraction result. On `startManual()` it must be
  `null`: a hand-keyed timesheet has no document, so it always takes the
  acknowledgement path.
- **`setCalendar`** — the plain `useState` setter. Questionnaire calls it with a
  functional updater and edits only `regular` / `overtime` / `total` / `filled` /
  `workedOnHoliday` on the one day being toggled.

## Admin display (for whoever owns item 2)

`approvalBadge(questionnaire)` in `lib/approval.js` returns
`{ tone, label, detail }` with `tone` one of `detected` / `acknowledged_absent` /
`unanswered` / `unknown`.

- **Keep approval OUT of the `review_status` vocabulary** (`clean` /
  `needs_review` / `approved`). Approval-by-the-employee's-manager is orthogonal
  to the admin's own review decision; merging them recreates exactly the badge
  collision item 2 exists to fix. Separate column, or at most a separate filter.
- **`tone: "unknown"` renders "—".** Every row submitted before this shipped has
  no approval keys. Rendering those as green would mislabel the entire existing
  history as manager-approved. **Never backfill.**
- Print the `verbatim` quote in the drawer so the admin can search for the same
  string in the preview pane.
