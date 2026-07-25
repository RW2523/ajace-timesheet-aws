import { redirect } from "next/navigation";
import { createClient } from "@/lib/api/server";
import DashboardClient from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let { data: profile } = await supabase
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
  return <DashboardClient profile={profile} />;
}
