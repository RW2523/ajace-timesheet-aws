import { redirect } from "next/navigation";
import { createClient } from "@/lib/api/server";
import AdminClient from "@/components/AdminClient";
import { canFileForOthers, canReview } from "@/lib/aws/roles";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await api
    .from("ts_profiles").select("*").eq("id", user.id).single();

  // THE DOOR. This is the page that holds "file a timesheet for somebody else",
  // and that right belongs to admin AND hr (lib/aws/roles.js). It was a literal
  // role === "admin" test, so an HR user was redirected to /dashboard while
  // every API behind this screen answered them 200 — the permission existed and
  // the only way to use it was to hand-craft an HTTP request. Half a feature.
  //
  // canFileForOthers is the SAME predicate app/api/admin/timesheet and
  // /api/admin/people gate on, so the page and the routes it posts to cannot
  // drift into disagreeing about who is allowed in.
  //
  // The page is the door, not the fence: every privileged action behind it is
  // re-checked server-side, and the admin-only ones (review, export, storage
  // reads) refuse HR on their own even if this guard were wrong again.
  if (!profile || !canFileForOthers(profile)) {
    redirect("/dashboard");
  }
  const reviewer = canReview(profile);

  // Only the columns the console actually renders. `select *` on
  // ts_employee_edits/ts_admin_edits drags a 31-entry `days` jsonb per row
  // across the wire on every visit — and every router.refresh() after a save.
  // The full `days` is fetched on demand when a submission is opened.
  // ts_timesheets is NOT fetched at all: it was pulled in full (also carrying
  // `days`) and then never read by AdminClient.
  // `reviewed_by` is here so an approved row can say WHO signed it off next to
  // the decision, instead of just when.
  const LIST_COLS = "id,timesheet_id,user_id,month,year,fields,validation,submitted,created_at," +
                    "status,reviewed_by,reviewed_at,review_note," +
                    // final_other travels with the other two: a corrected row's
                    // total includes paid-but-not-worked hours, and a console that
                    // fetches the total without them shows a breakdown that does
                    // not add up to the figure payroll pays.
                    "final_regular,final_overtime,final_other,final_total";
  //
  // The last two are REVIEWER-ONLY and are not merely hidden in the client:
  // ts_files (stored source documents) and ts_admin_edits (the correction trail)
  // stay admin-scoped in lib/aws/data.js, so asking for them as HR would return
  // one user's rows and a "forbidden" respectively. Not asking is the honest
  // version of the same answer — and it keeps the empty arrays HR renders from
  // being mistaken for "there is nothing there".
  const [{ data: profiles }, { data: edits }, filesRes, adminEditsRes] =
    await Promise.all([
      api.from("ts_profiles").select("*").order("full_name"),
      api.from("ts_employee_edits").select(LIST_COLS).order("created_at", { ascending: false }),
      reviewer
        ? api.from("ts_files").select("*").order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      reviewer
        ? api.from("ts_admin_edits").select("id,employee_user_id,admin_user_id,month,year,note,created_at")
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);

  return (
    <AdminClient
      profile={profile}
      profiles={profiles || []}
      edits={edits || []}
      files={filesRes?.data || []}
      adminEdits={adminEditsRes?.data || []}
    />
  );
}
