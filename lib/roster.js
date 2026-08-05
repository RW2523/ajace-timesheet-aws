// ---------------------------------------------------------------------------
// "WHO IS THIS TIMESHEET FOR?" — the pure half.
//
// Deliberately JSX-free and import-free so it can be run directly by
// test/target-picker.test.mjs. The rule that decides WHOSE payroll record a set
// of hours lands on is the single most consequential line of logic in the admin
// console; it must be executable in a test, not merely inspected.
//
// The UI that drives it is components/TimesheetTargetPicker.js.
// ---------------------------------------------------------------------------

// mode: "self" | "other" | "new"
//   "other" and "new" are both the SOMEONE-ELSE branch; "new" additionally has
//   the add-a-person panel open. Keeping them as one mode field (rather than a
//   boolean beside it) means the target can never be half-resolved — there is
//   no state where the form thinks "existing" and the panel thinks "new".
export const EMPTY_PICK = {
  mode: "other", pick: "", newName: "", newEmail: "", newCode: "",
  // The admin's answer to "somebody of this name is already registered". Starts
  // false and is reset whenever the name changes, so it is always an answer to
  // the question actually on screen.
  confirmDistinct: false,
};

// How a roster row is spelled in the datalist. The option list and the matcher
// must agree character-for-character; a combo box whose own options don't
// resolve is one that can never select anybody.
export const optionLabel = (p) =>
  `${p.full_name || p.email}${p.email ? ` — ${p.email}` : ""}`;

const clean = (s) => String(s == null ? "" : s).trim();
const lower = (s) => clean(s).toLowerCase();

// ---------------------------------------------------------------------------
// WHAT MAKES TWO PAYROLL RECORDS THE SAME HUMAN.
//
// These three keys are the ONLY definition of that in the app, and they are
// here — in the JSX-free, import-free module — so the browser warning, the
// server refusal and the export's last-gate assertion all compare the same way.
// Three copies of "is this the same person?" that disagree by one trim() is
// precisely how somebody gets two payslips.
//
// This exists because they did. Three records were created for one human —
// "Nora New" three times, employee_code EC-NORA three times, at
// nora.new@ / nora.new+payroll@ / nora.nеw@ (that third one is a CYRILLIC е) —
// and the payroll export emitted all three, 32 payable hours, HTTP 200. Every
// layer was doing its job: auth_users' unique index saw three different byte
// strings, and it was right; the export's double-pay assertion counts approved
// rows per user_id, and it was right too. Nothing was looking at the person.
// ---------------------------------------------------------------------------

// The MAILBOX a payroll email actually lands in. `+tag` is an alias convention
// (Gmail, Fastmail, Exchange...) — nora.new+payroll@x and nora.new@x are one
// inbox and one human. Dots are NOT stripped: dot-folding is Gmail-specific,
// and a.b@ vs ab@ really are two different people almost everywhere else, so
// folding them would MERGE two humans, which is the same bug pointed the other
// way (one payslip for two people).
export function mailboxKey(email) {
  const e = lower(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  const local = e.slice(0, at).split("+")[0];
  return `${local}@${e.slice(at + 1)}`;
}

// The payroll import's match column. Case and stray spaces are not identity:
// "EC-NORA", "ec-nora " and "ec-nora" are one code.
export const codeKey = (code) => lower(code).replace(/\s+/g, " ");

// A person's name, folded for comparison only. NEVER an identity on its own —
// two real people are called John Smith — it only raises a question.
export const nameKey = (name) => lower(name).replace(/\s+/g, " ");

// Payroll identity must be readable, typeable and unambiguous by eye: it is the
// export column a human reconciles against a bank file. A Cyrillic е inside an
// otherwise-Latin address is invisible on screen and mints a second identity for
// the same person, so addresses outside printable ASCII are refused rather than
// guessed at. Refusing is safe: the address is rejected with an explanation, and
// nothing is created.
export const hasNonAscii = (s) => /[^\x20-\x7e]/.test(String(s == null ? "" : s));

// ASCII IS NECESSARY BUT NOT SUFFICIENT.
//
// hasNonAscii above closes the invisible/look-alike class. It does not close the
// class that is spelled entirely in ASCII, and these mint a second payroll
// identity for a mailbox that already has one just as effectively:
//
//   boss@ajace.com.    TRAILING DOT. A root-anchored FQDN: every mail server on
//                      earth delivers it to boss@ajace.com. Byte-wise it is a
//                      different string, so the unique index on lower(email)
//                      admits it, and in a CSV column next to the real address
//                      one trailing dot is not something a human reconciling a
//                      bank file will catch.
//   .boss@ajace.com    LEADING DOT — not a legal local part.
//   bo..ss@ajace.com   DOUBLED DOT — not a legal local part either.
//
// So the shape rule is an ALLOW-LIST, not the permissive "something@something.
// something" it replaces: dot-atom (RFC 5322 3.2.3) for the local part, and
// letter/digit/hyphen labels with an alphabetic TLD for the domain. The set of
// addresses this company posts a payslip to is small; every character admitted
// beyond it is one more possible spelling of somebody already on the payroll.
//
// The alphabetic-TLD rule also excludes xn-- punycode, i.e. IDN domains. That is
// the same confusable problem one level up (a look-alike DOMAIN rather than a
// look-alike local part), and refusing it is a complete answer: payroll for a
// genuinely internationalised address should be a decision taken here, in the
// open, not something a permissive regex lets through unnoticed.
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const LOCAL_RE = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,63}$/;

// Why this address may not be stored, as a lowercase reason clause, or null if
// the shape is fine. Callers compose it into their own sentence, so the browser
// and the server can word it their own way while applying ONE rule.
// Assumes an already trimmed + lowercased string, and that hasNonAscii has
// already had its say (its message is far more useful for a look-alike letter).
export function emailShapeProblem(email) {
  const e = String(email == null ? "" : email);
  // RFC 5321: 254 for the whole address, 64 for the local part.
  if (e.length > 254) return "it is too long to be an email address";

  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return "it isn’t shaped like an email address";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);

  if (local.length > 64) return "the part before the @ is too long";
  if (local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    return "the part before the @ has a stray dot, which mail servers don’t accept";
  if (!LOCAL_RE.test(local)) return "the part before the @ has a character that isn’t allowed in an address";

  if (domain.endsWith("."))
    return "it ends with a dot — that is the same mailbox written a second way, " +
           "so it would create a second record for somebody who already has one";
  const labels = domain.split(".");
  // Two labels minimum, so "boss@localhost" is out.
  if (labels.length < 2) return "the part after the @ isn’t a full domain name";
  // "xn--" is the ACE prefix: the ASCII encoding of an internationalised domain.
  // Refused in ANY label, not just the last one, so this rule says one thing
  // rather than "no IDN top-level domains, but IDN second-level is fine".
  // Nobody at this company is paid at one, and letting IDN in through the domain
  // half of the address re-opens the look-alike problem the local half just had.
  if (labels.some((l) => l.startsWith("xn--")))
    return "the part after the @ is an internationalised (xn--) domain, which payroll doesn’t accept";
  if (!labels.every((l) => LABEL_RE.test(l))) return "the part after the @ isn’t a valid domain name";
  if (!TLD_RE.test(labels[labels.length - 1]))
    return "the part after the @ doesn’t end in a normal domain ending like .com";

  return null;
}

export function findPerson(roster, pick) {
  const p = clean(pick);
  if (!p) return null;
  const list = roster || [];
  const byLabel = list.find((r) => optionLabel(r) === p);
  if (byLabel) return byLabel;
  const byEmail = list.find((r) => lower(r.email) && lower(r.email) === lower(p));
  if (byEmail) return byEmail;
  // MATCH ON THE BARE NAME TOO — but only when it picks out exactly one person.
  //
  // Without this, typing "Nora New" (the name, no " — email" suffix) matched
  // NOBODY, and the picker's whole reason for existing is that a no-match offers
  // "Add Nora New as a new employee". So the screen invited an admin to create a
  // second Nora New by typing the first one's name correctly. That is not a
  // check that was missing, it is a check that was pointing backwards.
  //
  // Ambiguity is deliberately NOT resolved here: if two people are called John
  // Smith, this returns null and the datalist keeps asking, because guessing
  // which John Smith gets paid is the one thing this control must never do.
  const byName = list.filter((r) => nameKey(r.full_name) && nameKey(r.full_name) === nameKey(p));
  return byName.length === 1 ? byName[0] : null;
}

/** Everyone already registered under this name. Not an error — a question. */
export function namesakes(name, people) {
  const k = nameKey(name);
  if (!k) return [];
  return (people || []).filter((p) => nameKey(p.full_name) === k);
}

// Returns a human sentence, or null when the address is usable so far as the
// browser can tell.
//
// `people` must be EVERY profile, not just the filable roster: the roster hides
// admins and deactivated leavers, so checking against it would wave through a
// clash with a leaver's address — which is exactly the clash that would come
// back from the server as an unexplained error the admin cannot act on.
export function emailProblem(email, people) {
  const e = clean(email);
  if (!e) return "An email address is required.";
  // Non-ASCII first: for a look-alike letter its message is the one that helps.
  if (hasNonAscii(e)) {
    return "That address contains a character that isn’t plain ASCII — often a " +
      "look-alike letter pasted from elsewhere (a Cyrillic е reads exactly like an e). " +
      "It is the payroll identity, so it has to be unambiguous: retype it.";
  }
  // Then the shape. Note this runs on the LOWERCASED address, the same form the
  // server stores and compares, so the browser and the server agree.
  const shape = emailShapeProblem(lower(e));
  if (shape) return `That doesn’t look like an email address — ${shape}.`;
  const clash = (people || []).find((p) => lower(p.email) && lower(p.email) === lower(e));
  if (clash) {
    return `${clash.full_name || "Somebody"} already uses ${e}. ` +
      `Pick them from the list above instead of adding a second record.`;
  }
  // Same mailbox, different spelling. nora.new+payroll@ and nora.new@ deliver to
  // one inbox and belong to one person, so a second payroll record on the second
  // spelling is a second payslip for that person.
  const alias = (people || []).find(
    (p) => lower(p.email) && mailboxKey(p.email) === mailboxKey(e)
  );
  if (alias) {
    return `${alias.full_name || "Somebody"} is already registered as ${alias.email}, ` +
      `which is the same mailbox as ${e}. Pick them from the list above.`;
  }
  return null;
}

// Why this employee code may not be used, or null. Optional — plenty of people
// have none — but if one is given it must belong to nobody else, because it is
// the field the payroll import identifies people BY.
export function codeProblem(code, people) {
  const k = codeKey(code);
  if (!k) return null;
  const holder = (people || []).find((p) => codeKey(p.employee_code) === k);
  if (!holder) return null;
  return `Employee code ${clean(code)} already belongs to ` +
    `${holder.full_name || holder.email || "somebody else"}. Payroll matches people on that ` +
    `code, so two people sharing one gets one of them paid twice.`;
}

// THE single answer. null means "not decided yet" — the modal must not submit.
//   { kind: "self",     id, name, email, client }
//   { kind: "existing", id, name, email, client }
//   { kind: "new",      id: null, name, email }
//
// Note what is NOT here: no role. A person added through this door is always a
// plain employee, and the way to guarantee that from the client is to never let
// the client name a role at all. The server decides it regardless.
export function resolveTarget(value, opts) {
  const { roster = [], people = [], self = null } = opts || {};
  const v = value || EMPTY_PICK;

  if (v.mode === "self") {
    if (!self || !self.id) return null;
    return {
      kind: "self",
      id: self.id,
      name: self.full_name || self.email || "me",
      email: self.email || null,
      client: self.client || "",
    };
  }

  if (v.mode === "new") {
    const name = clean(v.newName);
    if (name.length < 2) return null;
    if (emailProblem(v.newEmail, people)) return null;
    // A payroll code already in use is not "probably fine" — it is the column a
    // payroll import joins on, so two records holding it are one code paid
    // twice. Same refusal the server makes (lib/aws/people.js), made here first
    // so the admin is told while they are still looking at the field.
    if (codeProblem(v.newCode, people)) return null;
    // Somebody of this name already exists and the admin has not said whether
    // this is a different human. Do NOT resolve — but the picker renders the
    // question right above this, so the disabled button always has a reason on
    // screen next to it. (This module refusing to answer is the point: guessing
    // "probably the same person" or "probably a new one" both pay somebody
    // wrongly, and only the admin knows which.)
    if (!v.confirmDistinct && namesakes(name, people).length > 0) return null;
    return { kind: "new", id: null, name, email: clean(v.newEmail),
             code: clean(v.newCode) || null, confirmDistinct: v.confirmDistinct === true,
             client: "" };
  }

  const p = findPerson(roster, v.pick);
  if (!p) return null;
  return {
    kind: "existing",
    id: p.id,
    name: p.full_name || p.email,
    email: p.email || null,
    client: p.client || "",
  };
}

// A stable identity for "whose record am I about to write to". The supersede
// prompt is raised for ONE person and month; acting on a prompt raised for a
// different person would retire a timesheet nobody looked at.
export function targetKey(t) {
  return t ? `${t.kind}:${t.id || lower(t.email) || t.name}` : "";
}

// NOTE: who may file for others / review is NOT defined here. lib/aws/roles.js
// is the one place that decides it and the routes enforce it from there; that
// file is pure (no imports, no node built-ins) so this client screen imports the
// SAME predicates rather than keeping a second copy that can drift out of step.
// A second copy is exactly the failure roles.js's own header warns about.
