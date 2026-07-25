import { redirect } from "next/navigation";
import { createClient } from "@/lib/api/server";
import DashboardClient from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  if (!user) redirect("/login");

  let { data: profile } = await api
    .from("ts_profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) {
    profile = {
      id: user.id, email: user.email, full_name: user.email,
      role: "employee", employer: "", client: "", employee_code: "",
    };
  }
  // The employee's own submissions. data.js forces user_id = me on non-admin
  // selects, so this is already scoped. Without it the dashboard is write-only:
  // after submitting you'd see a blank upload screen with no proof it worked.
  const { data: mySubmissions } = await api
    .from("ts_employee_edits")
    .select("id,month,year,status,created_at,fields,review_note,final_total")
    .order("created_at", { ascending: false });

  return <DashboardClient profile={profile} submissions={mySubmissions || []} />;
}
