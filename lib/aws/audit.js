// Who touched whose data. Admins can read every employee's profile, files and
// hours; without this there was no way to answer "who looked at this, and when".
//
// Never throws: an audit failure must not break the request the user is making,
// but it is logged loudly so a silently-broken audit trail is visible.
import { query } from "./db.js";

export async function audit({ actor, action, subjectId = null, detail = {}, ip = null }) {
  try {
    await query(
      `insert into public.ts_audit_log (actor_id, actor_email, action, subject_id, detail, ip)
       values ($1,$2,$3,$4,$5,$6)`,
      [actor?.id ?? null, actor?.email ?? null, action, subjectId, JSON.stringify(detail || {}), ip]
    );
  } catch (e) {
    console.error(`[audit] FAILED to record ${action}:`, e?.message || e);
  }
}
