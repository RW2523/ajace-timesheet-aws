import { NextResponse } from "next/server";

// Public diagnostic: is the live site's AI backend (the engine behind ENGINE_URL)
// reachable right now? Used to verify the self-healing tunnel without logging in.
// Does NOT expose the engine URL or key — only an online/offline signal.
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.ENGINE_URL || "";
  if (!url) return NextResponse.json({ ai_backend: "not_configured" });
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json({
      ai_backend: r.ok ? "online" : "error",
      llm_enabled: !!d.llm_enabled,
    });
  } catch {
    return NextResponse.json({ ai_backend: "offline" });
  }
}
