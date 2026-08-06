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
  // The employee's own submissions. Without them the dashboard is write-only:
  // after submitting you'd see a blank upload screen with no proof it worked.
  //
  // `.eq("user_id", user.id)` IS LOAD-BEARING for admin AND hr. data.js forces
  // user_id = me on non-privileged selects, but ts_employee_edits carries BOTH
  // adminRead and staffRead (see lib/aws/data.js), so an admin or HR user
  // received EVERY employee's submissions here — and the dashboard's
  // "⏳ Submitted — awaiting review" banner, its hours and its review note were
  // then somebody else's row rendered as your own. `user_id` is selected as
  // well so DashboardClient can filter on it too: one scope on the server, one
  // on the client, because this is a payroll record being attributed to a
  // person by name on screen.
  const { data: mySubmissions } = await api
    .from("ts_employee_edits")
    .select("id,user_id,month,year,status,created_at,fields,review_note,final_total")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return <DashboardClient profile={profile} submissions={mySubmissions || []} />;
}
