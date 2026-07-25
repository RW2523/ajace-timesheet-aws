// Scoped data access — replaces PostgREST + RLS.
// Every request is bound to the authenticated user; ownership is FORCED here in
// SQL (not trusted from the client). Only whitelisted tables/columns/ops pass.
import { query } from "./db.js";

// Per-table policy. `owner` = the column that ties a row to a user.
// `write` = columns a client may set. adminRead = admins may read all rows.
// `json` = jsonb columns; these MUST be JSON.stringify'd before binding, because
// node-pg encodes a top-level JS Array as a Postgres array literal ({...,...}),
// which jsonb then rejects with "invalid input syntax for type json". Note that
// ts_timesheets.projects is text[], NOT jsonb — it must stay a raw JS array.
const T = {
  ts_profiles: {
    owner: "id", adminRead: true,
    write: ["email","full_name","phone","employer","client","job_title","employee_code","country","manager_name","manager_email","role"],
  },
  ts_files: {
    owner: "user_id", adminRead: true,
    write: ["user_id","month","year","file_name","storage_path","mime_type","size_bytes","status"],
  },
  ts_timesheets: {
    owner: "user_id", adminRead: true, upsertKeys: ["user_id,year,month"],
    json: ["days","questionnaire","validation"],
    write: ["user_id","file_id","month","year","employee_name","employee_id","client","projects","monthly_regular","monthly_overtime","monthly_total","days_worked","days","questionnaire","validation","ai_confidence","ai_status"],
  },
  ts_employee_edits: {
    owner: "user_id", adminRead: true,
    // APPEND-ONLY. A submission is a payroll record: once written, the employee
    // must not be able to rewrite or delete it. Corrections are new rows, so the
    // history stays intact and auditable.
    ops: ["select", "insert"],
    // Review columns are readable here but only writable via /api/admin/review.
    extraRead: ["status","reviewed_by","reviewed_at","review_note",
                "final_regular","final_overtime","final_total"],
    json: ["fields","days","questionnaire","validation"],
    write: ["timesheet_id","user_id","month","year","fields","days","questionnaire","validation","submitted"],
  },
  ts_admin_edits: {
    owner: "admin_user_id", adminOnly: true,
    ops: ["select", "insert"],          // append-only: revisions are never rewritten
    json: ["fields","days","questionnaire","validation"],
    write: ["timesheet_id","employee_user_id","admin_user_id","month","year","fields","days","questionnaire","validation","note"],
  },
  ts_app_settings: {
    key: "key", publicRead: true, adminWrite: true,
    upsertKeys: ["key"], touch: "updated_at",
    write: ["key","value"],
  },
};

export async function execute(user, body) {
  try {
    const { table, op } = body || {};
    const cfg = T[table];
    if (!cfg) return { data: null, error: "table not allowed" };
    const isAdmin = user.role === "admin";
    if (cfg.adminOnly && !isAdmin) return { data: null, error: "forbidden" };

    // Table-level write gate. Covers DELETE too — cleanValues() is only reached
    // by insert/upsert/update, so without this a non-admin could delete rows of
    // an admin-only, owner-less table (ts_app_settings).
    const MUTATING = op === "insert" || op === "upsert" || op === "update" || op === "delete";
    if (cfg.adminWrite && MUTATING && !isAdmin) return { data: null, error: "forbidden" };

    // Per-table operation allowlist. Tables that record payroll history are
    // append-only, so `update`/`delete` are refused for everyone — including
    // admins — rather than merely being scoped by ownership.
    if (cfg.ops && !cfg.ops.includes(op)) {
      return { data: null, error: `operation not allowed on ${table}: ${op}` };
    }

    const readable = new Set([...(cfg.write || []), ...(cfg.extraRead || []),
                              "id", "created_at", cfg.owner, cfg.key, cfg.touch].filter(Boolean));
    const ident = (c) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(c) || !readable.has(c)) throw new Error(`bad column: ${c}`);
      return `"${c}"`;
    };
    const params = [];
    const P = (v) => { params.push(v); return `$${params.length}`; };

    // An owner-less table (e.g. ts_app_settings) has nothing to scope a mutation
    // by, so an update/delete without its key filter would hit every row.
    if ((op === "update" || op === "delete") && !cfg.owner) {
      const fcols = (body.filters || []).map((f) => f.col);
      if (!cfg.key || !fcols.includes(cfg.key)) throw new Error("unscoped mutation refused");
    }

    const buildWhere = (scope = true) => {
      const w = [];
      for (const f of body.filters || []) {
        if (f.op && f.op !== "eq") throw new Error("only eq filters supported");
        w.push(`${ident(f.col)} = ${P(f.val)}`);
      }
      if (scope && !(cfg.publicRead && op === "select")) {
        if (cfg.owner) {
          const seeAll = isAdmin && cfg.adminRead && op === "select";
          if (!seeAll) w.push(`${ident(cfg.owner)} = ${P(user.id)}`);
        }
      }
      return w.length ? `where ${w.join(" and ")}` : "";
    };

    // enforce writable columns + force owner + block role escalation
    const jsonCols = new Set(cfg.json || []);
    const cleanValues = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (!(cfg.write || []).includes(k)) continue;
        // jsonb columns must be serialised; everything else (incl. text[]) binds raw
        out[k] = jsonCols.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : v;
      }
      if (cfg.owner === "id") out.id = user.id;
      else if (cfg.owner) out[cfg.owner] = user.id;
      if (table === "ts_admin_edits") out.admin_user_id = user.id;
      if (table === "ts_profiles" && !isAdmin) delete out.role; // no self-escalation
      if (table === "ts_app_settings" && !isAdmin) throw new Error("forbidden");
      return out;
    };

    const cols = (() => {
      const c = body.columns;
      if (!c || c === "*") return "*";
      const arr = Array.isArray(c) ? c : String(c).split(",").map((s) => s.trim());
      return arr.map(ident).join(", ");
    })();

    let sql, rows;
    switch (op) {
      case "select": {
        const order = body.order
          ? ` order by ${ident(body.order.col)} ${body.order.ascending === false ? "desc" : "asc"}`
          : "";
        sql = `select ${cols} from public.${table} ${buildWhere()}${order}`;
        rows = await query(sql, params);
        break;
      }
      case "insert":
      case "upsert": {
        const vals = cleanValues(body.values);
        const keys = Object.keys(vals);
        if (!keys.length) throw new Error("no values");
        const colList = keys.map(ident).join(", ");
        const valList = keys.map((k) => P(vals[k])).join(", ");
        let conflict = "";
        if (op === "upsert") {
          const oc = body.onConflict;
          if (!(cfg.upsertKeys || []).includes(oc)) throw new Error("bad onConflict");
          const setList = keys.filter((k) => !oc.split(",").includes(k))
            .map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ");
          // column defaults only fire on INSERT, so refresh the timestamp here
          const touch = cfg.touch ? `, ${ident(cfg.touch)} = now()` : "";
          conflict = ` on conflict (${oc}) do update set ${setList}${touch}`;
        }
        sql = `insert into public.${table} (${colList}) values (${valList})${conflict} returning *`;
        rows = await query(sql, params);
        break;
      }
      case "update": {
        const vals = cleanValues(body.values);
        const keys = Object.keys(vals);
        if (!keys.length) throw new Error("no values");
        const setList = keys.map((k) => `${ident(k)} = ${P(vals[k])}`).join(", ");
        sql = `update public.${table} set ${setList} ${buildWhere()} returning *`;
        rows = await query(sql, params);
        break;
      }
      case "delete": {
        sql = `delete from public.${table} ${buildWhere()} returning *`;
        rows = await query(sql, params);
        break;
      }
      default:
        return { data: null, error: `op not allowed: ${op}` };
    }

    return { data: body.single ? rows[0] || null : rows, error: null };
  } catch (e) {
    return { data: null, error: e.message || String(e) };
  }
}
