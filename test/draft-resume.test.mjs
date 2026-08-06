// An employee loses their session part-way through correcting a 31-day grid.
//
// THE FAILURE (before this change): components/DashboardClient.js always booted
// to mode "upload", app/dashboard/page.js fetched ONLY ts_employee_edits, and
// nothing re-persisted the review step after saveBaseline. So an unsubmitted
// correction existed nowhere the app would ever look, and the employee had to
// re-upload and re-run the extraction (docs/PROCESSING-TIME.md: 12s-6min
// typical, worst case uncapped at ~30min).
//
// This walks the same /api/data path the browser uses — lib/aws/data.js
// execute() — for every write and read, so it exercises the real policy: forced
// ownership, the jsonb stringify rule, and the server-side derivation of
// monthly_regular / monthly_overtime / monthly_total / days_worked.
import { execute } from "../lib/aws/data.js";
import { query, pool } from "../lib/aws/db.js";
import { rollup } from "../lib/engine.js";

const EMP = "dddd0000-0000-0000-0000-000000000001";
const OTHER = "dddd0000-0000-0000-0000-000000000002";
const employee = { id: EMP, email: "draft@x.com", role: "employee" };
const stranger = { id: OTHER, email: "other@x.com", role: "employee" };

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

// jsonb does NOT preserve key order — Postgres re-sorts object keys on the way
// in, so a raw JSON.stringify comparison of a round-tripped `days` array always
// fails even when nothing changed. Compare the fields that carry meaning, in a
// fixed order. (Nothing in the app depends on key order; rollup() and
// deriveTotals() both read by name.)
const shape = (cal) => JSON.stringify(
  (cal || []).map((c) => [c.date, c.regular ?? null, c.overtime ?? null, c.other ?? null, c.total ?? null])
);

for (const [id, mail] of [[EMP, "draft@x.com"], [OTHER, "other@x.com"]]) {
  await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x','employee') on conflict (id) do nothing`, [id, mail]);
  await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,'D','employee') on conflict (id) do nothing`, [id, mail]);
}

const YEAR = 2026, MONTH = 5;

// What the AI first read: 20 weekdays at 8h.
const extracted = [];
for (let d = 1; d <= 20; d++) {
  extracted.push({ date: `2026-05-${String(d).padStart(2, "0")}`, regular: 8, overtime: null, other: null, total: 8, filled: true });
}
// What the employee has corrected it to when the laptop sleeps: one day fixed
// from 8h to 6h, one day given 2h of overtime, one PTO day added.
const corrected = extracted.map((c) => ({ ...c }));
corrected[3] = { ...corrected[3], regular: 6, total: 6 };
corrected[7] = { ...corrected[7], overtime: 2, total: 10 };
corrected.push({ date: "2026-05-25", regular: null, overtime: null, other: 8, total: 8, filled: true });

console.log("\n── 1. extraction lands (saveBaseline) ──");
let r = await execute(employee, {
  table: "ts_timesheets", op: "upsert", onConflict: "user_id,year,month", single: true,
  values: {
    user_id: EMP, month: MONTH, year: YEAR, days: extracted,
    questionnaire: {}, validation: {}, ai_status: "ok",
  },
});
ok("baseline saved", !r.error, r.error);
const tsId = r.data?.id;
ok("baseline derives 160h", Number(r.data?.monthly_total) === 160, String(r.data?.monthly_total));
ok("no draft yet — nothing to resume", r.data?.draft === null, JSON.stringify(r.data?.draft));

console.log("\n── 2. the employee corrects the grid; autosave fires ──");
const draftBlob = {
  v: 1,
  savedAt: "2026-06-02T10:15:00.000Z",
  fields: { employee_name: "Dana Draft", employee_id: "E-7", client: "Acme", project: "Apollo" },
  q: { regularHours: "158", overtimeHours: "2", workedWeekends: "no" },
  holidayWork: { "2026-05-25": false },
  aiMeta: { fileName: "may.pdf", confidence: 0.82 },
  aiApproval: null,
  aiBaseline: extracted,
  fileName: "may.pdf",
};
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: tsId }],
  values: {
    days: corrected,
    questionnaire: { ...draftBlob.q, holidayWork: draftBlob.holidayWork },
    validation: { errors: [], warnings: [] },
    employee_name: "Dana Draft", employee_id: "E-7", client: "Acme",
    draft: draftBlob,
  },
});
ok("autosave accepted", !r.error, r.error);

const expected = rollup(corrected);   // 158 regular, 2 overtime, 8 other, 168 total, 21 days
ok("autosave DERIVED the totals server-side, not from the client",
   Number(r.data?.[0]?.monthly_total) === expected.total &&
   Number(r.data?.[0]?.monthly_regular) === expected.regular &&
   Number(r.data?.[0]?.monthly_overtime) === expected.overtime &&
   Number(r.data?.[0]?.days_worked) === expected.daysWorked,
   JSON.stringify({ got: r.data?.[0], want: expected }));

console.log("\n── 3. THE ORIGINAL FAILURE: session lost, nothing submitted ──");
// This is what app/dashboard/page.js used to be the ONLY source of truth for.
const edits = await execute(employee, {
  table: "ts_employee_edits", op: "select",
  columns: "id,month,year,days", filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("ts_employee_edits holds NOTHING — a draft is not a submission",
   (edits.data || []).length === 0, JSON.stringify(edits.data));

console.log("\n── 4. the fix: the reopened dashboard finds the draft ──");
// Byte-for-byte the select DashboardClient's period effect issues.
const found = await execute(employee, {
  table: "ts_timesheets", op: "select", single: true,
  columns: "id,month,year,days,draft",
  filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("a row comes back", !found.error && !!found.data, found.error);
ok("it is marked as an unfinished draft", !!found.data?.draft, JSON.stringify(found.data?.draft));
ok("the CORRECTED grid comes back, not the extraction",
   shape(found.data?.days) === shape(corrected) && shape(found.data?.days) !== shape(extracted),
   shape(found.data?.days));
ok("the questionnaire answers come back", found.data?.draft?.q?.regularHours === "158");
ok("the holiday map comes back", found.data?.draft?.holidayWork["2026-05-25"] === false);
ok("the identity fields come back", found.data?.draft?.fields?.project === "Apollo");
ok("aiBaseline comes back, so holiday 'Worked' can still look hours up",
   Array.isArray(found.data?.draft?.aiBaseline) && found.data.draft.aiBaseline.length === 20);

console.log("\n── 5. resuming cannot change what anyone is paid ──");
// resumeDraft() rebuilds `calendar` from row.days and never from the blob.
const resumedCalendar = found.data.days;
const resumedTotals = rollup(resumedCalendar);
ok("client rollup of the resumed grid == pre-crash rollup",
   JSON.stringify(resumedTotals) === JSON.stringify(expected),
   JSON.stringify({ resumedTotals, expected }));
const stored = await query(`select monthly_regular,monthly_overtime,monthly_total,days_worked from ts_timesheets where id=$1`, [tsId]);
ok("server columns agree with that rollup",
   Number(stored[0].monthly_regular) === expected.regular &&
   Number(stored[0].monthly_overtime) === expected.overtime &&
   Number(stored[0].monthly_total) === expected.total &&
   Number(stored[0].days_worked) === expected.daysWorked,
   JSON.stringify(stored[0]));

// Submitting the resumed grid derives the SAME figures as the lost session would.
r = await execute(employee, {
  table: "ts_employee_edits", op: "insert", single: true,
  values: {
    timesheet_id: tsId, user_id: EMP, month: MONTH, year: YEAR, submitted: true,
    fields: { employee_name: "Dana Draft", totals: { regular: 1, overtime: 1, total: 1 } },
    days: resumedCalendar, questionnaire: {}, validation: {},
  },
});
ok("resumed submission accepted", !r.error, r.error);
ok("submitted fields.totals derived from the resumed days, not the claimed 1s",
   r.data?.fields?.totals?.total === expected.total && r.data?.fields?.totals?.regular === expected.regular,
   JSON.stringify(r.data?.fields?.totals));

console.log("\n── 6. `draft` is not a back door into the money columns ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: tsId }],
  values: { draft: { totals: { total: 9999 } }, monthly_total: 9999, monthly_regular: 9999 },
});
ok("totals smuggled alongside a draft, with no days, still refused", !!r.error, JSON.stringify(r.data));
let after = await query(`select monthly_total from ts_timesheets where id=$1`, [tsId]);
ok("stored total untouched", Number(after[0].monthly_total) === expected.total, String(after[0].monthly_total));

// A draft blob may legitimately be written on its own (it carries no hours).
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: tsId }],
  values: { draft: { ...draftBlob, savedAt: "2026-06-02T10:20:00.000Z" } },
});
ok("draft-only write allowed (no money column touched)", !r.error, r.error);
after = await query(`select monthly_total from ts_timesheets where id=$1`, [tsId]);
ok("and it still did not move the total", Number(after[0].monthly_total) === expected.total, String(after[0].monthly_total));

console.log("\n── 7. submitting / discarding clears the draft ──");
r = await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: tsId }],
  values: { draft: null },
});
ok("clear accepted", !r.error, r.error);
const cleared = await execute(employee, {
  table: "ts_timesheets", op: "select", single: true, columns: "id,days,draft",
  filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("nothing is offered for resume any more", cleared.data && cleared.data.draft === null,
   JSON.stringify(cleared.data?.draft));
ok("the hours themselves survive the clear",
   shape(cleared.data?.days) === shape(corrected), shape(cleared.data?.days));

console.log("\n── 8. a draft is private to its owner ──");
// Re-arm one so there is something to try to read.
await execute(employee, {
  table: "ts_timesheets", op: "update", filters: [{ col: "id", val: tsId }],
  values: { draft: draftBlob },
});
const peek = await execute(stranger, {
  table: "ts_timesheets", op: "select", columns: "id,draft",
  filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("another employee sees no rows", (peek.data || []).length === 0, JSON.stringify(peek.data));

// ...but a PRIVILEGED one is not stopped by the data layer, and that is the
// whole reason the client query had to change.
console.log("\n── 9. an admin's resume read must be scoped BY THE CLIENT ──");
// ts_timesheets carries adminRead, and buildWhere() drops the owner predicate on
// SELECT for an admin. So the dashboard's own period query — which used only
// .eq(year).eq(month) and then took .single() of an UNORDERED result — could
// hand an admin an arbitrary employee's timesheet as their own unfinished draft.
// resumeDraft() then pointed timesheetRef at a foreign row id, after which every
// subsequent write matched zero rows and returned error:null for ever.
const ADM = "dddd0000-0000-0000-0000-00000000000e";
await query(`insert into auth_users(id,email,password_hash,role) values($1,'draftadm@x.com','x','admin')
             on conflict (id) do nothing`, [ADM]);
await query(`insert into ts_profiles(id,email,full_name,role) values($1,'draftadm@x.com','A','admin')
             on conflict (id) do nothing`, [ADM]);
const adminUser = { id: ADM, email: "draftadm@x.com", role: "admin" };

const adminUnscoped = await execute(adminUser, {
  table: "ts_timesheets", op: "select", columns: "id,user_id,days,draft",
  filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("an admin's UNSCOPED read really does return the employee's row",
   (adminUnscoped.data || []).some((r2) => r2.user_id === EMP),
   JSON.stringify((adminUnscoped.data || []).map((r2) => r2.user_id)));
ok("...and it carries a live draft, so it WOULD have been offered as theirs",
   (adminUnscoped.data || []).some((r2) => r2.user_id === EMP && !!r2.draft));

// The query the dashboard now issues. `.eq("user_id", uid)` is a no-op for an
// employee and load-bearing for an admin — one line, and the only thing between
// an admin and a stranger's half-finished payroll grid.
const adminScoped = await execute(adminUser, {
  table: "ts_timesheets", op: "select", single: true, columns: "id,month,year,days,draft",
  filters: [{ col: "user_id", val: ADM }, { col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("scoped by user_id, the admin is offered NOTHING to resume",
   !adminScoped.error && adminScoped.data === null, JSON.stringify(adminScoped.data));
const empScoped = await execute(employee, {
  table: "ts_timesheets", op: "select", single: true, columns: "id,month,year,days,draft",
  filters: [{ col: "user_id", val: EMP }, { col: "year", val: YEAR }, { col: "month", val: MONTH }],
});
ok("...and the employee still gets their own back, unchanged",
   empScoped.data?.id === tsId && !!empScoped.data?.draft, JSON.stringify(empScoped.data?.id));

// The same widening applies to the submissions the dashboard renders its
// "⏳ Submitted — awaiting review" banner from. ts_employee_edits carries BOTH
// adminRead and staffRead, so an admin OR HR user received every employee's
// rows — and the banner, its hours and its review note could be somebody else's.
const HRU = { id: "dddd0000-0000-0000-0000-00000000000f", email: "drafthr@x.com", role: "hr" };
await query(`insert into auth_users(id,email,password_hash,role) values($1,$2,'x','hr')
             on conflict (id) do nothing`, [HRU.id, HRU.email]);
await query(`insert into ts_profiles(id,email,full_name,role) values($1,$2,'H','hr')
             on conflict (id) do nothing`, [HRU.id, HRU.email]);
for (const u of [adminUser, HRU]) {
  const seen = await execute(u, {
    table: "ts_employee_edits", op: "select", columns: "id,user_id",
    filters: [{ col: "year", val: YEAR }, { col: "month", val: MONTH }],
  });
  ok(`an unscoped ts_employee_edits read as ${u.role} returns the employee's submissions`,
     (seen.data || []).some((e) => e.user_id === EMP), String((seen.data || []).length));
  const scopedSeen = await execute(u, {
    table: "ts_employee_edits", op: "select", columns: "id,user_id",
    filters: [{ col: "user_id", val: u.id }, { col: "year", val: YEAR }, { col: "month", val: MONTH }],
  });
  ok(`...and adding .eq("user_id") removes them, which is what the dashboard now sends`,
     (scopedSeen.data || []).every((e) => e.user_id === u.id), JSON.stringify(scopedSeen.data));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed`);
await pool().end(); process.exit(fail ? 1 : 0);
