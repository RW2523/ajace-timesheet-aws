import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { deleteObjects } from "@/lib/aws/storage";

export const runtime = "nodejs";

export async function POST(request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const { paths = [] } = await request.json().catch(() => ({}));
  const allowed = paths.filter((p) => String(p).split("/")[0] === user.id || user.role === "admin");
  await deleteObjects(allowed);
  return NextResponse.json({ ok: true });
}
