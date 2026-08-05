"use client";
import { useMemo } from "react";
import { EMPTY_PICK, optionLabel, findPerson, emailProblem, codeProblem, namesakes } from "@/lib/roster";

// ---------------------------------------------------------------------------
// "WHO IS THIS TIMESHEET FOR?" — the one place that answers it.
//
// An admin/HR user filing a timesheet has three answers, and before this
// component only one of them worked:
//
//   MYSELF          — file against my own payroll record
//   SOMEONE ELSE    — an already-registered person, picked from the roster
//   ...who isn't registered yet — type their name and add them on the spot
//
// The third case is why this exists. The old combo box was a bare
// <input list=…>: typing a name that matched nobody left the form in a state
// where the submit button was disabled and NOTHING said why. The admin typed a
// real person's real name, saw a normal-looking form, pressed a dead button and
// had no idea what was wrong. Typing a new name must never silently do nothing.
//
// The picker owns no state of its own. It is driven by one `value` object and
// one `onChange`; lib/roster.js `resolveTarget()` turns that object into the
// single answer the rest of the modal reads. Two copies of "who is this for?"
// — one for the UI and one for the POST body — is exactly how the wrong person
// gets paid, so there is only one, and it lives in a JSX-free module so
// test/target-picker.test.mjs can execute it rather than merely read it.
// ---------------------------------------------------------------------------

const clean = (s) => String(s == null ? "" : s).trim();
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Required-field marker. Same `.req` class (and `--req` colour) as every other
// form in the app — red is reserved for "what you typed is wrong", this is
// "you still have to fill this in".
export function Req() {
  return <span className="req" title="Required" aria-hidden="true">*</span>;
}

const radioRow = {
  display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 11px",
  border: "1px solid var(--line)", borderRadius: "var(--radius-sm)",
  cursor: "pointer", flex: "1 1 220px",
};

export default function TimesheetTargetPicker({
  value, onChange, roster = [], people = [], self = null, serverEmailError = "",
  // The SERVER's namesake verdict. `people` is a snapshot taken when the console
  // rendered, so a person added by a colleague two minutes ago is not in it —
  // the browser sees no clash, the server does, and this is how its answer gets
  // back onto the panel instead of surfacing as a generic red banner.
  serverSameName = null,
}) {
  const v = value || EMPTY_PICK;
  const set = (patch) => onChange({ ...v, ...patch });
  const isOther = v.mode !== "self";

  const matched = useMemo(() => findPerson(roster, v.pick), [roster, v.pick]);
  const typed = clean(v.pick);
  const noMatch = isOther && v.mode !== "new" && typed.length > 0 && !matched;

  // Whatever the admin typed is the best guess at who they meant. If it looks
  // like an address, seed the email; otherwise seed the name.
  function openNewPerson() {
    const looksLikeEmail = EMAIL_SHAPE.test(typed);
    set({
      mode: "new",
      newName: looksLikeEmail ? clean(v.newName) : typed,
      newEmail: looksLikeEmail ? typed : clean(v.newEmail),
    });
  }

  const localEmailIssue = v.mode === "new" && clean(v.newEmail)
    ? emailProblem(v.newEmail, people)
    : null;
  const emailIssue = serverEmailError || localEmailIssue;
  const nameTooShort = v.mode === "new" && clean(v.newName).length > 0 && clean(v.newName).length < 2;
  const codeIssue = v.mode === "new" ? codeProblem(v.newCode, people) : null;
  // Everyone already registered under this name. NOT an error — the question in
  // NewPersonPanel. `people` (not `roster`) on purpose: a duplicate is most often
  // made of a leaver or an admin, and those are exactly who the roster hides.
  const sameName = useMemo(
    () => (v.mode === "new" ? namesakes(v.newName, people) : []),
    [v.mode, v.newName, people]
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
          Who is this timesheet for? <Req />
        </legend>
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "stretch" }}>
          <label style={{ ...radioRow, borderColor: v.mode === "self" ? "var(--brand)" : "var(--line)" }}>
            <input type="radio" name="ts-target-who" checked={v.mode === "self"}
                   onChange={() => set({ mode: "self" })} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Myself</span>
              <span className="hint" style={{ display: "block" }}>
                {self?.full_name || self?.email || "your own record"}
              </span>
            </span>
          </label>
          <label style={{ ...radioRow, borderColor: isOther ? "var(--brand)" : "var(--line)" }}>
            <input type="radio" name="ts-target-who" checked={isOther}
                   onChange={() => set({ mode: "other" })} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Someone else</span>
              <span className="hint" style={{ display: "block" }}>
                Pick from {roster.length} registered {roster.length === 1 ? "person" : "people"}, or add a new one
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {v.mode === "self" && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          These hours land on <b>your own</b> payroll record and go into the review queue
          like anyone else’s — being able to approve timesheets does not extend to
          approving your own.
        </div>
      )}

      {isOther && (
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label htmlFor="ts-target-pick">Employee <Req /></label>
          <input id="ts-target-pick" list="ts-admin-roster" value={v.pick} autoComplete="off"
                 disabled={v.mode === "new"}
                 onChange={(e) => set({ pick: e.target.value })}
                 placeholder="Type a name or email…" />
          <datalist id="ts-admin-roster">
            {roster.map((p) => <option key={p.id} value={optionLabel(p)} />)}
          </datalist>

          {matched && v.mode !== "new" && (
            <div style={{ fontSize: 12, marginTop: 4, color: "var(--green)" }}>
              ✓ {matched.full_name || matched.email}
            </div>
          )}
          {!typed && v.mode !== "new" && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Start typing to search the {roster.length} registered
              {" "}{roster.length === 1 ? "person" : "people"}. Not on the list? Type their
              name and you’ll be offered the option to add them.
            </div>
          )}

          {/* THE POINT OF THIS COMPONENT. A name that matches nobody used to be a
              dead end with no message at all. */}
          {noMatch && (
            <div className="alert info" style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 8 }}>
                Nobody registered matches <b>“{typed}”</b>.
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={openNewPerson}>
                Add “{typed}” as a new employee
              </button>
              <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                …or keep typing to find an existing one.
              </span>
            </div>
          )}

          {v.mode === "new" && (
            <NewPersonPanel
              v={v} set={set}
              emailIssue={emailIssue} nameTooShort={nameTooShort}
              codeIssue={codeIssue} sameName={sameName}
              serverSameName={serverSameName}
              onCancel={() => set({ mode: "other" })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function NewPersonPanel({ v, set, emailIssue, nameTooShort, codeIssue,
                          sameName = [], serverSameName = null, onCancel }) {
  // Whichever list is non-empty. The server's wins when it has one, because it
  // read the table this instant and the browser's copy is a page-load old.
  const clashes = (serverSameName && serverSameName.length ? serverSameName : sameName) || [];
  return (
    <div style={{
      marginTop: 10, padding: "14px 14px 2px", border: "1px solid var(--line-strong)",
      borderRadius: "var(--radius-sm)", background: "var(--surface-2)",
    }}>
      {/* wrap: on a phone the heading and its own escape hatch both wrap to two
          lines and were jammed together in a 272px row. */}
      <div className="between" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>Add a new person to payroll</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel — pick an existing person
        </button>
      </div>

      <div className="grid-2">
        <div className={`field${nameTooShort ? " invalid" : ""}`}>
          <label htmlFor="ts-new-name">Full name <Req /></label>
          {/* Changing the name un-answers the namesake question: a tick left over
              from "yes, a different John Smith" must not still be ticked once the
              name says Jane Doe. */}
          <input id="ts-new-name" value={v.newName} autoComplete="off"
                 onChange={(e) => set({ newName: e.target.value, confirmDistinct: false })}
                 placeholder="e.g. Priya Raman" />
          {nameTooShort && (
            <div style={{ fontSize: 12, color: "var(--red)" }}>
              Please enter the person’s full name.
            </div>
          )}
        </div>
        <div className={`field${emailIssue ? " invalid" : ""}`}>
          <label htmlFor="ts-new-email">Email <Req /></label>
          <input id="ts-new-email" type="email" value={v.newEmail} autoComplete="off"
                 onChange={(e) => set({ newEmail: e.target.value })}
                 placeholder="e.g. priya.raman@example.com" />
          {emailIssue
            ? <div style={{ fontSize: 12, color: "var(--red)" }}>{emailIssue}</div>
            : <div className="hint">
                Required, and it must not already be in use. The email address —
                not the name — is how payroll tells two people apart, and it is the
                column your export is keyed on. Two Priya Ramans with one address
                is a wrong payslip.
              </div>}
        </div>
        {/* Full width: three fields in a two-column grid put this one alone on
            row two, under a 70px hole left by the Email hint's height. Its own
            hint wants the width anyway. */}
        <div className={`field${codeIssue ? " invalid" : ""}`} style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="ts-new-code">Employee code</label>
          <input id="ts-new-code" value={v.newCode || ""} autoComplete="off"
                 onChange={(e) => set({ newCode: e.target.value })}
                 placeholder="optional — e.g. EC-0194" />
          {codeIssue
            ? <div style={{ fontSize: 12, color: "var(--red)" }}>{codeIssue}</div>
            : <div className="hint">
                Optional, but if your payroll system matches people by a code, this is
                that code — it goes in the export. It must belong to nobody else: two
                records sharing one is one code paid twice, and the export now refuses
                to run when it finds that.
              </div>}
        </div>
      </div>

      {/* SOMEBODY OF THIS NAME ALREADY EXISTS.
          Not a refusal. Two real people are called John Smith and both have to be
          paid, so this cannot be decided FOR the admin — but it must not be
          decided BY DEFAULT either, which is exactly what used to happen: a
          second and third "Nora New" were created without a word said, and the
          payroll export paid all of them. So the question is asked once, the
          existing people are shown with the addresses that tell them apart, and
          the answer is recorded against the admin who gave it. */}
      {clashes.length > 0 && (
        <div className="alert warn" style={{ marginBottom: 12 }}>
          <b>
            {clashes.length === 1
              ? "Somebody of this name is already registered."
              : `${clashes.length} people of this name are already registered.`}
          </b>
          <ul style={{ margin: "6px 0 8px", paddingLeft: 18 }}>
            {clashes.map((p) => (
              <li key={p.id} style={{ fontSize: 13 }}>
                {p.full_name || "(no name)"} — {p.email}
                {p.employee_code ? ` · code ${p.employee_code}` : ""}
                {p.active === false ? " · deactivated" : ""}
              </li>
            ))}
          </ul>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            If this is one of them, cancel and pick them from the list — a second record
            for one person is two payslips for one person. Only tick this if it really
            is a different human who happens to share the name.
          </div>
          {/* color/fontWeight: this bare <label> sits inside the outer .field, so
              `.field label` painted the one line the admin has to read and act
              on in slate-blue 600 — a different colour family from the amber
              alert it lives in, and it made its <b> compute to 900. */}
          <label className="row" style={{ gap: 8, alignItems: "flex-start", fontSize: 13,
                                          color: "inherit", fontWeight: 400 }}>
            <input type="checkbox" checked={!!v.confirmDistinct}
                   onChange={(e) => set({ confirmDistinct: e.target.checked })} />
            <span>
              This is a <b>different person</b> who happens to have the same name.
              <span className="muted" style={{ display: "block", fontSize: 12 }}>
                Recorded in the audit log against your name.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* An admin who thinks they have just created a LOGIN will file a support
          ticket the moment this person can't sign in. Say it before they submit,
          not after. */}
      <div className="alert warn" style={{ marginBottom: 12 }}>
        <b>This does not create a working login.</b>
        <div style={{ marginTop: 4 }}>
          {clean(v.newName) || "This person"} gets a payroll record only. No password is
          set and none can be guessed, so the account cannot be signed into at all — and
          “Forgot password” will not bring it to life either, because nobody has yet
          verified who this person is.
        </div>
        <div style={{ marginTop: 6 }}>
          To give them access later, an administrator sets a password on the server with{" "}
          <code>deploy/scripts/set-password.sh</code>. Their hours are filed and payable
          either way — this only affects whether they can sign in.
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        They are added as a regular <b>employee</b>. Adding a person is recorded in the
        audit log against your name.
      </div>
    </div>
  );
}
