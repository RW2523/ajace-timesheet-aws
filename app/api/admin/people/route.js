import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { query } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";
import { canCreatePeople } from "@/lib/aws/roles";
import { createPerson, DuplicateEmailError, DuplicateEmployeeCodeError,
         NamesakeError, PersonInputError } from "@/lib/aws/people";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// THE ROSTER, AND ADDING SOMEBODY TO IT.
//
// GET  — the people an admin/HR user may file hours for (the dropdown).
// POST — register a person who has never had an account.
//
// Registering a person MINTS A LOGIN ROW, because nothing in this database can
// exist without one (ts_profiles.id and ts_employee_edits.user_id both reference
// auth_users). It deliberately does NOT mint a usable account — see
// lib/aws/people.js for the unusable-password marker and the three auth routes
// that refuse it. This endpoint's job is to make that a privileged, audited act.
//
// Three properties this door must have, and where each is actually enforced:
//   1. admin or HR only, re-checked HERE on the server (currentUser() re-reads
//      the role from the database on every call — a stale cookie cannot claim it)
//   2. the person created is ALWAYS an 'employee'. Not "role is validated" —
//      lib/aws/people.js never reads a role from input at all, and writes the
//      literal into both tables. There is no key to aim at.
//   3. both rows or neither: createPerson() is one transaction, so this cannot
//      leave the auth_users-row-without-a-profile that would make someone
//      invisible to the payroll export.
// ---------------------------------------------------------------------------

const bad = (msg, status = 400) => NextResponse.json({ error: msg }, { status });

export async function GET() {
  const user = await currentUser();
  if (!user) return bad("not authenticated", 401);
  if (!canCreatePeople(user)) return bad("forbidden", 403);

  // Everyone a timesheet can be filed FOR. Other admins and HR staff are people
  // with payroll records too, so they are not filtered out — what is filtered
  // out is the deactivated, because filing hours for them is refused downstream
  // anyway and offering them in a dropdown only invites a 409.
  const people = await query(
    `select id, email, full_name, employee_code, client, role,
            coalesce(active, true) as active
       from public.ts_profiles
      where coalesce(active, true) = true
      order by lower(coalesce(full_name, email))`
  );
  return NextResponse.json({ people });
}

export async function POST(request) {
  const user = await currentUser();
  if (!user) return bad("not authenticated", 401);
  if (!canCreatePeople(user)) return bad("forbidden", 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return bad("invalid body");

  let person;
  try {
    // `body` is passed whole and ON PURPOSE not spread/filtered here: normalise
    // in lib/aws/people.js is the allow-list, and it has no `role` in it. Doing
    // a second, partial copy of that filtering in the route is how the two
    // drift and one of them starts letting a field through.
    person = await createPerson(body);
  } catch (e) {
    if (e instanceof PersonInputError) return bad(e.message, 400);
    if (e instanceof DuplicateEmailError) {
      // 409, not a silent second row: two payroll identities for one human is a
      // duplicate payslip. The UI shows this and the admin picks the existing
      // person from the dropdown instead.
      return NextResponse.json({ error: e.message, duplicateEmail: e.email }, { status: 409 });
    }
    // Same shape, same reason: the payroll import matches on employee_code, so
    // a second record carrying one is a second payslip on that code.
    if (e instanceof DuplicateEmployeeCodeError) {
      return NextResponse.json({ error: e.message, duplicateEmployeeCode: e.code }, { status: 409 });
    }
    // NOT a refusal — a question. The caller re-sends with
    // confirmDistinctPerson:true if it really is a different human of the same
    // name, and that answer is recorded in the audit entry below.
    if (e instanceof NamesakeError) {
      return NextResponse.json(
        { error: e.message, needsDistinctConfirmation: true,
          sameName: e.matches.map((m) => ({ id: m.id, full_name: m.full_name, email: m.email,
                                            employee_code: m.employee_code, active: m.active })) },
        { status: 409 }
      );
    }
    console.error("[admin/people] create failed, nothing was created:", e?.message || e);
    return bad("couldn't register that person", 500);
  }

  console.warn(`[admin/people] ${user.email} (${user.role}) registered ${person.email} — no password set`);
  await audit({
    actor: user,
    action: "person.create",
    subjectId: person.id,
    detail: { email: person.email, full_name: person.full_name,
              employee_code: person.employee_code || null,
              role: person.role, by_role: user.role, login_enabled: false,
              // "Somebody of this name already exists" was raised and this
              // admin overruled it. Against a trusted user who insists the
              // duplicate is a different person, the record of them saying so
              // IS the control — so it is stored, not inferred later.
              confirmed_distinct_from_namesake: person.confirmed_distinct === true },
    ip: clientIp(request),
  });

  return NextResponse.json({ ok: true, person }, { status: 201 });
}
