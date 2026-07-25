import { redirect } from "next/navigation";
import { createClient } from "@/lib/api/server";

export default async function Home() {
  const api = await createClient();
  const {
    data: { user },
  } = await api.auth.getUser();
  redirect(user ? "/dashboard" : "/login");
}
