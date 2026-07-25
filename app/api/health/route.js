import { query } from "@/lib/aws/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unauthenticated liveness+readiness probe for the monitoring cron.
// Deliberately leaks nothing: no version, no hostname, no error detail — just
// whether the app can serve and reach its database.
export async function GET() {
  const started = Date.now();
  try {
    await query("select 1");
    return Response.json(
      { ok: true, db: "up", ms: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // 503 so a plain HTTP status check is enough to alert on.
    return Response.json(
      { ok: false, db: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
