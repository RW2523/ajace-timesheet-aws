import { redirect } from "next/navigation";
import { createClient } from "@/lib/api/server";
import AdminClient from "@/components/AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await api
    .from("ts_profiles").select("*").eq("id", user.id).single();
  if (!profile || profile.role !== "admin") {
    redirect("/dashboard");
  }

  // Only the columns the console actually renders. `select *` on
  // ts_employee_edits/ts_admin_edits drags a 31-entry `days` jsonb per row
  // across the wire on every visit — and every router.refresh() after a save.
  // The full `days` is fetched on demand when a submission is opened.
  // ts_timesheets is NOT fetched at all: it was pulled in full (also carrying
  // `days`) and then never read by AdminClient.
  // `reviewed_by` is here so an approved row can say WHO signed it off next to
  // the decision, instead of just when.
  const LIST_COLS = "id,timesheet_id,user_id,month,year,fields,validation,submitted,created_at," +
                    "status,reviewed_by,reviewed_at,review_note,final_regular,final_overtime,final_total";
  const [{ data: profiles }, { data: edits }, { data: files }, { data: adminEdits }] =
    await Promise.all([
      api.from("ts_profiles").select("*").order("full_name"),
      api.from("ts_employee_edits").select(LIST_COLS).order("created_at", { ascending: false }),
      api.from("ts_files").select("*").order("created_at", { ascending: false }),
      api.from("ts_admin_edits").select("id,employee_user_id,admin_user_id,month,year,note,created_at")
        .order("created_at", { ascending: false }),
    ]);

  return (
    <AdminClient
      profile={profile}
      profiles={profiles || []}
      edits={edits || []}
      files={files || []}
      adminEdits={adminEdits || []}
    />
  );
}
