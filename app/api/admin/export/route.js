import { currentUser } from "@/lib/aws/auth";
import { query } from "@/lib/aws/db";
import { audit } from "@/lib/aws/audit";
import { clientIp } from "@/lib/aws/ratelimit";

export const runtime = "nodejs";

// Payroll export: one row per employee for a period, as CSV.
// The hours exported are the NUMBERS OF RECORD — an admin correction
// (final_*) wins over what the employee submitted, which is the whole point of
// reviewing. Superseded submissions are excluded so a resubmission can never
// double-count.
const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Guard against CSV/formula injection when opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function GET(request) {
  const user = await currentUser();
  if (!user) return new Response("not authenticated", { status: 401 });
  if (user.role !== "admin") return new Response("forbidden", { status: 403 });

  const sp = new URL(request.url).searchParams;
  const year = parseInt(sp.get("year") || "", 10);
  const month = parseInt(sp.get("month") || "", 10);
  if (!year || !month || month < 1 || month > 12) {
    return new Response("year and month are required", { status: 400 });
  }
  // Default to the numbers you'd actually pay: approved only.
  const approvedOnly = sp.get("all") !== "1";

  const rows = await query(
    `select p.full_name, p.email, p.employee_code, p.employer, p.client,
            e.year, e.month, e.status, e.created_at, e.reviewed_at, e.review_note,
            coalesce(e.final_regular,  (e.fields->'totals'->>'regular')::numeric)  as regular,
            coalesce(e.final_overtime, (e.fields->'totals'->>'overtime')::numeric) as overtime,
            coalesce(e.final_total,    (e.fields->'totals'->>'total')::numeric)    as total,
            (e.final_total is not null) as corrected_by_admin
       from public.ts_employee_edits e
       join public.ts_profiles p on p.id = e.user_id
      where e.year = $1 and e.month = $2
        and e.status <> 'superseded'
        and ($3 = false or e.status = 'approved')
      order by p.full_name nulls last, p.email`,
    [year, month, approvedOnly]
  );

  const header = ["Employee","Email","Employee code","Employer","Client","Year","Month",
                  "Regular hours","Overtime hours","Total hours","Status","Corrected by admin",
                  "Submitted at","Reviewed at","Review note"];
  const body = rows.map((r) => [
    r.full_name, r.email, r.employee_code, r.employer, r.client, r.year, r.month,
    r.regular ?? 0, r.overtime ?? 0, r.total ?? 0, r.status, r.corrected_by_admin ? "yes" : "",
    r.created_at?.toISOString?.().slice(0, 19).replace("T", " ") ?? "",
    r.reviewed_at?.toISOString?.().slice(0, 19).replace("T", " ") ?? "",
    r.review_note,
  ].map(csvCell).join(","));

  const totalHours = rows.reduce((a, r) => a + Number(r.total || 0), 0);
  const csv = [
    header.join(","),
    ...body,
    "",
    `${csvCell("TOTAL")},,,,,,,,,${csvCell(totalHours.toFixed(2))}`,
  ].join("\r\n");

  const name = `timesheets-${year}-${String(month).padStart(2, "0")}${approvedOnly ? "-approved" : "-all"}.csv`;
  console.info(`[export] ${user.email} exported ${rows.length} row(s) for ${year}-${month}`);
  await audit({ actor: user, action: "export",
                detail: { year, month, rows: rows.length, approvedOnly, totalHours },
                ip: clientIp(request) });
  return new Response("﻿" + csv, {   // BOM so Excel reads UTF-8 correctly
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
