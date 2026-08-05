// REGISTERING A PERSON FOR PAYROLL, WITHOUT CREATING A WAY IN.
//
// A person cannot exist in this database without a login row: ts_profiles.id
// references auth_users(id), ts_employee_edits.user_id references auth_users(id),
// and auth_users.password_hash is `text not null`. So "add Jane so I can file
// her October hours" MUST insert an auth_users row.
//
// That row must not be an account. Jane has never chosen a password and nobody
// has verified that the person typing her name knows her. What gets stored is
// therefore an UNUSABLE PASSWORD MARKER — a string that is structurally not a
// bcrypt hash and can never be produced by one — and the login route refuses it
// EXPLICITLY, before bcrypt is ever asked. She becomes able to sign in only when
// an operator sets a password deliberately (deploy/scripts/set-password.sh).
//
// (Measured, not assumed: `bcrypt.compare('anything', '!payroll-only:no-login')`
// resolves FALSE rather than throwing — so the incidental behaviour happens to
// be safe today. It is still not the control. bcryptjs THROWS on null/undefined,
// which is the same function one npm bump away from throwing on a bad string
// too, and an unhandled throw inside the login handler is a 500 with a stack
// trace instead of "invalid email or password". The explicit check runs first.)
import { pool } from "./db.js";
// The identity keys live in lib/roster.js — the pure module the BROWSER also
// imports — so the warning an admin sees while typing and the refusal the server
// issues are computed by the same three functions. See the header there.
import { mailboxKey, codeKey, nameKey, hasNonAscii, emailShapeProblem } from "../roster.js";

// Bcrypt hashes always begin "$2a$" / "$2b$" / "$2y$". A leading '!' cannot
// occur in one, so this marker is unforgeable as a hash and readable in psql.
export const UNUSABLE_PASSWORD = "!payroll-only:no-login";

/**
 * TRUE when this password_hash can never authenticate anybody.
 *
 * Deliberately a WHITELIST of the one shape that may be compared ("looks like a
 * bcrypt hash"), not a blacklist of the marker. A blacklist would let an empty
 * string, a NULL that slipped past the constraint, a truncated hash or a
 * half-written migration value fall through to bcrypt and depend on bcrypt
 * saying no. This says no first, for every one of them.
 */
export function isUnusablePassword(hash) {
  return typeof hash !== "string" || !/^\$2[aby]?\$/.test(hash);
}

/** Email clash — a 409 the UI can render, not an opaque 500. */
export class DuplicateEmailError extends Error {
  constructor(email) {
    super(`Someone is already registered with the email ${email}.`);
    this.name = "DuplicateEmailError";
    this.email = email;
  }
}
/**
 * The payroll match key is taken — a 409.
 *
 * ts_profiles.employee_code is the column a payroll IMPORT joins on. Two records
 * carrying one code are one code paid twice, and the export cannot tell them
 * apart by anything the downstream system reads.
 */
export class DuplicateEmployeeCodeError extends Error {
  constructor(code, holder) {
    super(`Employee code ${code} already belongs to ${holder?.full_name || holder?.email || "somebody else"}` +
          (holder?.email ? ` (${holder.email})` : "") +
          `. A payroll import matches on that code, so two people sharing it get one of them paid twice.`);
    this.name = "DuplicateEmployeeCodeError";
    this.code = code;
    this.holder = holder || null;
  }
}

/**
 * Somebody of this name is already registered — a 409 the admin can OVERRULE.
 *
 * NOT an error in the way a duplicate email is. Two real people are called John
 * Smith and both have to be paid, so this cannot be a flat refusal: a control
 * that fires on legitimate input with no way through gets worked around, and the
 * workaround is worse than the control.
 *
 * So it is a QUESTION, asked once, answered explicitly: the caller re-sends with
 * confirmDistinctPerson:true and that confirmation goes in the audit log. The
 * admin who says "yes, a different person" has said so on the record.
 */
export class NamesakeError extends Error {
  constructor(name, matches) {
    const who = matches.map((m) => m.email || m.id).join(", ");
    super(`${matches.length === 1 ? "Somebody is" : `${matches.length} people are`} already ` +
          `registered as “${name}” (${who}). If this is one of them, pick them from the list — ` +
          `filing under a second record pays the same person twice. If it really is a different ` +
          `person with the same name, confirm that and it will be recorded against your name.`);
    this.name = "NamesakeError";
    this.personName = name;
    this.matches = matches;
  }
}

/** Bad input — a 400. */
export class PersonInputError extends Error {
  constructor(msg) { super(msg); this.name = "PersonInputError"; }
}

/**
 * Validate + normalise a new-person payload.
 *
 * NOTE WHAT IS ABSENT: `role`. It is not read, not validated, not defaulted
 * from input — there is no key in the returned object an attacker could aim at.
 * The role is written as the literal 'employee' at the INSERT below. That is why
 * this door cannot mint an admin or an HR account: not because a check rejects
 * role:'admin', but because nothing anywhere in this file ever looks at it.
 */
export function normalisePerson(input) {
  const p = (input && typeof input === "object") ? input : {};
  const email = String(p.email || "").trim().toLowerCase();
  if (!email) throw new PersonInputError("an email address is required — it is the payroll identity for this person");
  // A look-alike letter mints a SECOND identity for one person that no human
  // reviewing the CSV can see: "nora.new@" and "nora.nеw@" (Cyrillic е) are
  // different byte strings, so the unique index on lower(email) passes both, and
  // they render identically in every screen and every spreadsheet. Payroll
  // identity has to survive being read by a person, so it is plain ASCII or it
  // is refused. Refusing costs nothing recoverable — nothing is created and the
  // message says exactly what to do.
  if (hasNonAscii(email)) {
    throw new PersonInputError(
      "that email contains a character that isn't plain ASCII — usually a look-alike letter " +
      "pasted from another document (a Cyrillic е is indistinguishable from an e on screen). " +
      "The address is this person's payroll identity, so it has to be unambiguous: retype it."
    );
  }
  // ...and the same trick spelled entirely in ASCII. "boss@ajace.com." is a
  // DIFFERENT byte string from "boss@ajace.com", so lower(email) and its unique
  // index admit both, but it is the same mailbox and the same human — one dot in
  // a CSV column is not a difference anybody reconciling a bank file will see.
  // The shape rule (dot-atom local part, real domain labels, alphabetic TLD)
  // lives beside hasNonAscii in lib/roster.js so the browser refuses exactly what
  // the server refuses. THIS call is the enforcement; the browser's is a courtesy.
  const shape = emailShapeProblem(email);
  if (shape) {
    throw new PersonInputError(
      `that doesn't look like a valid email address — ${shape}. It is this person's ` +
      `payroll identity, so it has to be exactly the address they are paid at.`
    );
  }

  const fullName = String(p.fullName ?? p.full_name ?? "").trim();
  if (fullName.length < 2) throw new PersonInputError("a full name is required");
  if (fullName.length > 200) throw new PersonInputError("that name is too long");

  const opt = (v, max = 200) => {
    const s = v == null ? "" : String(v).trim();
    if (!s) return null;
    return s.slice(0, max);
  };
  return {
    email,
    fullName,
    phone: opt(p.phone, 40),
    employer: opt(p.employer),
    client: opt(p.client),
    jobTitle: opt(p.jobTitle ?? p.job_title),
    employeeCode: opt(p.employeeCode ?? p.employee_code, 60),
    country: opt(p.country, 8) || "US",
    managerName: opt(p.managerName ?? p.manager_name),
    managerEmail: opt(p.managerEmail ?? p.manager_email)?.toLowerCase() || null,
    // NOT a person attribute — the admin's answer to "somebody of this name is
    // already registered; is this a different human?". Carried on the object
    // because normalisePerson is idempotent: the timesheet route normalises
    // early, hands the RESULT to createPersonTx, and an answer dropped in
    // between would re-ask a question the admin has already answered and fail
    // the filing. Nothing but the namesake check reads it, and it cannot grant
    // anything — the worst it does is let a second John Smith be created, on
    // the record, which is the outcome it exists to make possible.
    confirmDistinctPerson: p.confirmDistinctPerson === true,
  };
}

/**
 * Insert the person USING A CALLER-SUPPLIED TRANSACTION.
 *
 * The caller passes a `client` already inside `begin`, which is what lets
 * "create Jane and file her October hours" be ONE atomic act: if the timesheet
 * insert three statements later throws, the rollback takes Jane with it and
 * there is no half-registered person left behind to confuse the next admin.
 *
 * The two inserts here are the same one-act/one-transaction rule the signup
 * route already follows — an auth_users row with no ts_profiles row is a person
 * who can be filed against but is missing from the payroll export entirely.
 *
 * @param client a pg client INSIDE an open transaction
 * @returns {id, email, full_name, role, active}
 */
export async function createPersonTx(client, input) {
  const p = normalisePerson(input);

  // ---- IS THIS ALREADY SOMEBODY? -----------------------------------------
  // Everything below runs on the caller's transaction, so what it reads is what
  // the insert three statements later writes against — and the FOR-KEY-SHARE-free
  // race that remains is closed by the unique indexes, not by these reads. These
  // exist to produce a sentence an admin can act on ("that's Nora, pick her from
  // the list") instead of a 500 out of a constraint name.
  //
  // Three questions, in increasing order of how sure we are:
  //   the same MAILBOX      -> refuse (certainly one human)
  //   the same PAYROLL CODE -> refuse (certainly one payslip)
  //   the same NAME         -> ask    (possibly two humans)

  // Friendly, case-insensitive pre-check on the address itself, plus the alias
  // spellings of it. `nora.new+payroll@ajace.com` is not a different person from
  // `nora.new@ajace.com`; it is the same inbox with a tag on it, and it walked
  // straight past `lower(email) =` because the two strings genuinely differ.
  const clash = (await client.query(
    `select u.id, u.email, p.full_name
       from public.auth_users u
       left join public.ts_profiles p on p.id = u.id
      where lower(u.email) = $1
         or (split_part(lower(u.email), '@', 2) = $2
             and split_part(split_part(lower(u.email), '@', 1), '+', 1) = $3)
      limit 1`,
    [p.email, p.email.slice(p.email.lastIndexOf("@") + 1),
     mailboxKey(p.email).split("@")[0]]
  )).rows[0];
  if (clash) throw new DuplicateEmailError(clash.email || p.email);

  // The payroll import's join column. Left unguarded, this was the whole bug:
  // three profiles, all employee_code EC-NORA, all exported, all payable — and
  // the downstream system has no way of telling them apart because that code IS
  // how it identifies people. Case- and space-insensitive, because "ec-nora "
  // is not a different code.
  if (p.employeeCode) {
    const codeClash = (await client.query(
      `select id, email, full_name from public.ts_profiles
        where employee_code is not null
          and lower(regexp_replace(btrim(employee_code), '\\s+', ' ', 'g')) = $1
        limit 1`,
      [codeKey(p.employeeCode)]
    )).rows[0];
    if (codeClash) throw new DuplicateEmployeeCodeError(p.employeeCode, codeClash);
  }

  // ...and the name. This one only ASKS. See NamesakeError: two real people are
  // called John Smith and a flat refusal would make the second one unpayable.
  // Deactivated leavers are included on purpose — re-registering a leaver under
  // a new address rather than reactivating them is one of the ways the duplicate
  // gets made, and it is exactly the case the admin needs told about.
  if (!p.confirmDistinctPerson) {
    const namesakes = (await client.query(
      `select id, email, full_name, employee_code, coalesce(active, true) as active
         from public.ts_profiles
        where lower(regexp_replace(btrim(coalesce(full_name, '')), '\\s+', ' ', 'g')) = $1
        order by lower(email) limit 5`,
      [nameKey(p.fullName)]
    )).rows;
    if (namesakes.length > 0) throw new NamesakeError(p.fullName, namesakes);
  }

  let u;
  try {
    u = (await client.query(
      // role: the LITERAL 'employee'. Not a parameter. Not from `p`.
      `insert into public.auth_users (email, password_hash, role, email_verified)
       values ($1, $2, 'employee', false)
       returning id, email, role`,
      [p.email, UNUSABLE_PASSWORD]
    )).rows[0];
  } catch (e) {
    // 23505 = unique_violation, from auth_users_email_lower_uniq (or the plain
    // email unique) when two admins add the same person at the same instant.
    if (e?.code === "23505") throw new DuplicateEmailError(p.email);
    throw e;
  }

  let prof;
  try {
    prof = (await client.query(
      // role: the LITERAL 'employee' here too. ts_profiles.role is the one
      // currentUser() actually reads (it coalesces profile over auth_users), so
      // leaving it to a default would be leaving the effective role to a default.
      `insert into public.ts_profiles
         (id, email, full_name, phone, role, employer, client, job_title,
          employee_code, country, manager_name, manager_email, active)
       values ($1,$2,$3,$4,'employee',$5,$6,$7,$8,$9,$10,$11,true)
       returning id, email, full_name, employee_code, role, active`,
      [u.id, p.email, p.fullName, p.phone, p.employer, p.client, p.jobTitle,
       p.employeeCode, p.country, p.managerName, p.managerEmail]
    )).rows[0];
  } catch (e) {
    // ts_profiles_employee_code_lower_uniq, when two admins register the same
    // code in the same instant and both got past the read above. The read is the
    // good error message; THIS is the guarantee.
    if (e?.code === "23505") throw new DuplicateEmployeeCodeError(p.employeeCode, null);
    throw e;
  }

  return { id: u.id, email: prof.email, full_name: prof.full_name,
           employee_code: prof.employee_code, role: prof.role, active: prof.active,
           // Recorded by both callers in ts_audit_log. An admin who overruled
           // "somebody of this name already exists" said so, under their name,
           // at a timestamp — which is the only control there can be over a
           // trusted user who insists the duplicate is a different person.
           confirmed_distinct: p.confirmDistinctPerson };
}

/** Standalone version for callers with nothing else to do — owns its own tx. */
export async function createPerson(input) {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const person = await createPersonTx(client, input);
    await client.query("commit");
    return person;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
