import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { queryOne } from "@/lib/aws/db";

export const runtime = "nodejs";

// The ONLY way a submission's review state changes.
//
// Submissions stay append-only through /api/data (an employee can never rewrite
// a payroll record). Review is a separate, admin-only action that touches only
// review columns, so the employee's original submission is preserved verbatim
// alongside the decision and any corrected totals.
const ALLOWED = new Set(["submitted", "approved", "rejected"]);

export async function POST(request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { editId, status, note, finals } = await request.json().catch(() => ({}));
  if (!editId) return NextResponse.json({ error: "editId required" }, { status: 400 });
  if (status && !ALLOWED.has(status)) {
    return NextResponse.json({ error: `status must be one of ${[...ALLOWED].join(", ")}` }, { status: 400 });
  }

  // A superseded submission is history — reviewing it would be meaningless.
  const target = await queryOne(`select id, status from public.ts_employee_edits where id=$1`, [editId]);
  if (!target) return NextResponse.json({ error: "submission not found" }, { status: 404 });
  if (target.status === "superseded") {
    return NextResponse.json(
      { error: "This submission was replaced by a newer one; review that instead." },
      { status: 409 }
    );
  }

  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const hasFinals = finals && typeof finals === "object";

  const row = await queryOne(
    `update public.ts_employee_edits
        set status         = coalesce($2, status),
            review_note    = coalesce($3, review_note),
            final_regular  = case when $4 then $5 else final_regular  end,
            final_overtime = case when $4 then $6 else final_overtime end,
            final_total    = case when $4 then $7 else final_total    end,
            reviewed_by    = $8,
            reviewed_at    = now()
      where id = $1
      returning id, status, review_note, final_regular, final_overtime, final_total, reviewed_at`,
    [editId, status || null, note ?? null, !!hasFinals,
     hasFinals ? num(finals.regular) : null,
     hasFinals ? num(finals.overtime) : null,
     hasFinals ? num(finals.total) : null,
     user.id]
  );

  console.info(`[review] ${user.email} set ${editId} -> ${row.status}${hasFinals ? " (totals corrected)" : ""}`);
  return NextResponse.json({ ok: true, submission: row });
}
