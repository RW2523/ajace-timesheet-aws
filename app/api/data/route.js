import { NextResponse } from "next/server";
import { currentUser } from "@/lib/aws/auth";
import { execute } from "@/lib/aws/data";

export const runtime = "nodejs";

// Single scoped data endpoint — replaces PostgREST. Ownership/role enforced in
// lib/aws/data.js (deny-by-default), so the browser can't reach other users' rows.
export async function POST(request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ data: null, error: "not authenticated" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const res = await execute(user, body);
  return NextResponse.json(res, { status: res.error ? 400 : 200 });
}
