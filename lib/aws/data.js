// Scoped data access — replaces PostgREST + RLS.
// Every request is bound to the authenticated user; ownership is FORCED here in
// SQL (not trusted from the client). Only whitelisted tables/columns/ops pass.
import { query } from "./db.js";
import { readAiVerdict } from "./jwt.js";
// THE hours formula and its bounds live in ONE place (lib/hours.js). The strict
// variant refuses negative, non-numeric, or impossible hours instead of summing
// them into a payable figure — deriving faithfully from days the client made up
// is not the same as deriving something payable.
import { deriveTotalsStrict } from "../hours.js";
// The role predicates, from the one module that owns them. `staffRead` below is
// the ONLY thing in this file that knows a role other than admin can be
// privileged, and it asks roles.js rather than spelling out a role string.
import { canSeeAllTimesheets } from "./roles.js";

// Per-table policy. `owner` = the column that ties a row to a user.
// `write` = columns a client may set. adminRead = admins may read all rows.
// staffRead = admin AND hr may read all rows (see canSeeAllTimesheets in
// roles.js for why HR's console is wrong-not-just-empty without it). staffRead
// is READ ONLY and deliberately separate from adminRead: a table gets it by
// being named here, so ts_files (source documents) and ts_admin_edits (the
// correction trail) keep the narrower rule by default rather than by luck.
// `json` = jsonb columns; these MUST be JSON.stringify'd before binding, because
// node-pg encodes a top-level JS Array as a Postgres array literal ({...,...}),
// which jsonb then rejects with "invalid input syntax for type json". Note that
// ts_timesheets.projects is text[], NOT jsonb — it must stay a raw JS array.
const T = {
  ts_profiles: {
    // staffRead: the roster. HR already receives exactly these rows from
    // GET /api/admin/people (canCreatePeople-gated) to populate the "who is this
    // timesheet for?" dropdown; this is the same list reaching the same screen
    // through the page's own query instead of a second fetch.
    owner: "id", adminRead: true, staffRead: true,
    // NO DELETE — for anyone, including admins. DEFAULT_OPS below already keeps
    // delete out of every table that does not ask for it; this list is stated
    // anyway, because the cost of spelling it out is one line and the cost of
    // it silently coming back is somebody's unpaid month.
    //
    // The profile is the PERSON RECORD payroll is keyed on: /api/admin/export
    // joins it to turn a submission into a payable line, and the admin roster
    // and month-end chase list are built from it. Destroying it does not log
    // the employee out (currentUser() LEFT JOINs profiles and coalesces
    // role/active), so they keep submitting and admins keep approving while
    // every approved row they own — past and future — silently drops out of
    // the payroll CSV. Nobody
    // notices, because a missing row looks exactly like a person who did not
    // work. app/api/auth/signup already fixed the mirror image of this by
    // making the login and the profile ONE transaction; leaving `delete` open
    // here reopened the same hole from the other end.
    //
    // Deletion is not the operation anyone actually wants: the schema added
    // ts_profiles.active precisely so a departing employee is DEACTIVATED, and
    // switched the payroll FKs to ON DELETE RESTRICT so their history survives.
    // Nothing in this app has ever called delete on this table.
    ops: ["select", "insert", "upsert", "update"],
    write: ["email","full_name","phone","employer","client","job_title","employee_code","country","manager_name","manager_email","role"],
  },
  ts_files: {
    owner: "user_id", adminRead: true,
    write: ["user_id","month","year","file_name","storage_path","mime_type","size_bytes","status"],
  },
  ts_timesheets: {
    owner: "user_id", adminRead: true, upsertKeys: ["user_id,year,month"],
    // No `ops` needed to keep DELETE out — delete is opt-in for every table
    // (see DEFAULT_OPS below). It matters here more than anywhere: this row is
    // the PARENT of the payroll records. ts_employee_edits and ts_admin_edits
    // both carry `timesheet_id references ts_timesheets(id)`, so deleting one
    // of these used to take the approved submissions and the admin audit trail
    // with it — an append-only child table is worthless if its parent can be
    // deleted by the employee who owns it.
    // `draft` is the employee's in-progress review state (see schema.sql). It
    // carries NO hours: a draft's hours are `days`, so the money guard below
    // still governs every number that can reach payroll.
    json: ["days","questionnaire","validation","draft"],
    write: ["user_id","file_id","month","year","employee_name","employee_id","client","projects","monthly_regular","monthly_overtime","monthly_total","days_worked","days","questionnaire","validation","ai_confidence","ai_status","draft"],
  },
  ts_employee_edits: {
    // staffRead: WHO HAS FILED, and what for. This is the chase list's input —
    // see canSeeAllTimesheets(). Note what staffRead does NOT grant: `ops` below
    // is select+insert, and an HR insert still lands owner-forced to HR's own
    // id (cleanValues), so reading everyone's rows gives HR no way to write on
    // anyone's record here. Filing for someone else goes through
    // /api/admin/timesheet, which re-checks the role and derives the money.
    owner: "user_id", adminRead: true, staffRead: true,
    // APPEND-ONLY. A submission is a payroll record: once written, the employee
    // must not be able to rewrite or delete it. Corrections are new rows, so the
    // history stays intact and auditable.
    ops: ["select", "insert"],
    // Review columns are readable here but only writable via /api/admin/review.
    // `final_days` is the corrected day grid — READ-ONLY here, like the other
    // final_* columns, and deliberately absent from `write`: the grid a payroll
    // figure was derived from may only be set by the route that derived it.
    // The console must read it, though: it is the grid of record once a
    // correction exists, and rendering the employee's superseded one instead is
    // how a later correction gets computed from pre-correction hours.
    extraRead: ["status","reviewed_by","reviewed_at","review_note",
                "final_regular","final_overtime","final_other","final_total","final_days"],
    json: ["fields","days","questionnaire","validation"],
    write: ["timesheet_id","user_id","month","year","fields","days","questionnaire","validation","submitted"],
  },
  ts_admin_edits: {
    // adminRead, and NOT staffRead. This is the oversight trail: every row means
    // "a privileged user touched THAT person's payroll record". `owner` here is
    // the ACTOR, not the subject, so without adminRead the table was scoped to
    // rows you wrote yourself — the console's "Admin revisions" tab showed an
    // admin only their own revisions, which is the one audience it is useless
    // to. That was invisible while an admin was the only person who could file
    // on somebody's behalf; now that HR can, every HR filing writes a row here
    // with admin_user_id = the HR user, and the admins who have to review those
    // filings could not see a single one of them. A trail nobody but its author
    // can read is not an audit trail.
    //
    // The tab was always built to render other people's rows — it prints
    // `pmap[a.admin_user_id].full_name` in an "Edited by admin" column, which
    // can only ever have been the current user's own name until now.
    //
    // HR does not get it: HR is the party being overseen here, and reading who
    // corrected whose figures is a reviewer's business (see canSeeAllTimesheets).
    owner: "admin_user_id", adminOnly: true, adminRead: true,
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

// Operations a table permits when it declares no `ops` of its own. DELETE is
// deliberately absent: destroying a payroll row is never something the browser
// needs to do, and a table that forgets to think about it must not get it.
const DEFAULT_OPS = ["select", "insert", "upsert", "update"];

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
    //
    // DELETE IS OPT-IN, NOT OPT-OUT. `ops` used to be honoured only when a
    // table declared it, so a table that said nothing got *every* operation,
    // delete included. ts_employee_edits and ts_admin_edits remembered to
    // declare it; ts_timesheets did not — and because both payroll tables are
    // children of ts_timesheets, one `{"table":"ts_timesheets","op":"delete"}`
    // from any authenticated employee cascaded away their own approved rows
    // and the admin audit trail (the DELETE is owner-scoped, so it was "their"
    // data — that is exactly why nothing stopped it). No route, component or
    // query builder in this app ever deletes a row, so the safe default is
    // that a table gets delete only by asking for it, in writing, here.
    const allowedOps = cfg.ops || DEFAULT_OPS;
    if (!allowedOps.includes(op)) {
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
          // `op === "select"` is the load-bearing half of both clauses: an
          // unscoped read is a wider view, an unscoped WRITE would let a
          // privileged user's update/upsert land on somebody else's row.
          const seeAll =
            op === "select" &&
            ((isAdmin && cfg.adminRead) || (cfg.staffRead && canSeeAllTimesheets(user)));
          if (!seeAll) w.push(`${ident(cfg.owner)} = ${P(user.id)}`);
        }
      }
      return w.length ? `where ${w.join(" and ")}` : "";
    };

    // Payroll figures are DERIVED SERVER-SIDE from the day entries (lib/hours.js).
    // The browser sends totals too, but they are advisory only: without this, the
    // numbers that get paid are whatever the client posted. Derivation alone was
    // not enough — see lib/hours.js — so the days themselves are bounded here.

    // The AI verdict receipt that came with this write, verified ONCE here
    // because cleanValues() below is synchronous. null unless /api/process
    // really did issue one to THIS user. See lib/aws/jwt.js.
    const aiVerdict =
      table === "ts_employee_edits" && MUTATING
        ? await readAiVerdict(body?.values?.fields?.ai_stamp, user.id)
        : null;

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

      // ---- `fields`: the client composes this jsonb, but some of its keys are
      // ---- the SERVER'S WORD, not the client's -----------------------------
      // Only `totals` used to be overwritten; every OTHER key was merged
      // verbatim from the request, and two of them are read as PROVENANCE:
      //
      //   * fields.entry — the "an admin filed this on the employee's behalf"
      //     stamp. /api/admin/timesheet names it as one of the three controls
      //     that make admin-entered hours safe, the payroll CSV prints it as
      //     Origin / "Entered by", and the console renders "Filed by <name> on
      //     the employee's behalf". An employee could put it on their OWN
      //     submission and their self-entered hours then read as hours an admin
      //     had already vouched for. No client write may set it — the only
      //     writer is /api/admin/timesheet, which INSERTs it in SQL.
      //
      //   * fields.review_status / .flow / .agent_trace — the AI's verdict on
      //     the extraction, which the admin queue shows as a sorting signal.
      //     It IS computed server-side, but it reaches here through the browser,
      //     so it is taken from the signed receipt /api/process issued to this
      //     user and never from the payload sitting beside it. No valid
      //     receipt means exactly what it says: no AI ran on this submission.
      let fieldsOut = null;
      if (table === "ts_employee_edits" && "fields" in (obj || {})) {
        const src = obj.fields && typeof obj.fields === "object" && !Array.isArray(obj.fields)
          ? obj.fields : {};
        fieldsOut = { ...src };
        delete fieldsOut.entry;
        delete fieldsOut.ai_stamp;   // the receipt is an input, not part of the record
        if (aiVerdict) {
          fieldsOut.review_status = aiVerdict.reviewStatus;
          fieldsOut.flow = aiVerdict.flow;
        } else {
          fieldsOut.review_status = null;
          fieldsOut.flow = null;
          fieldsOut.agent_trace = null;
        }
        out.fields = JSON.stringify(fieldsOut);
      }

      // Recompute the money numbers from the submitted days, overwriting
      // whatever the client claimed.
      //
      // These used to be gated on `Array.isArray(obj?.days)`, which made the
      // derivation OPT-OUT-ABLE: a hand-crafted POST to /api/data that simply
      // omitted `days` skipped it entirely and stored the client's own totals —
      // and fields.totals is exactly what the payroll CSV pays. Any
      // authenticated employee can reach /api/data, so a missing `days` on a
      // money-bearing table is now an ERROR, never a reason to trust the client.
      const MONEY_TABLES = ["ts_timesheets", "ts_employee_edits"];
      if (MONEY_TABLES.includes(table)) {
        const writesMoney =
          table === "ts_timesheets"
            ? ["monthly_regular", "monthly_overtime", "monthly_total", "days_worked"]
                .some((k) => k in (obj || {}))
            : "fields" in (obj || {});

        if (!Array.isArray(obj?.days)) {
          // Refuse only when the payload actually carries figures; a write that
          // touches neither days nor totals (e.g. a status-only patch) is fine.
          if (writesMoney) {
            throw new Error(
              `${table}: 'days' is required when writing hours — totals are derived server-side, not accepted from the client`,
            );
          }
        } else {
          // THROWS on hours that cannot be real (negative, non-numeric, more
          // than 24 in a day, more than a month can hold). execute() turns that
          // into { error } -> HTTP 400 with the reason, so nothing impossible is
          // ever stored as a payable number.
          const t = deriveTotalsStrict(obj.days);
          if (table === "ts_timesheets") {
            out.monthly_regular = t.regular;
            out.monthly_overtime = t.overtime;
            out.monthly_total = t.total;
            out.days_worked = t.daysWorked;
          } else {
            // fields is jsonb and stringified below, so patch the object first.
            // Patch the SANITISED copy — patching obj.fields here would put the
            // client's `entry`/`review_status` straight back.
            const base = fieldsOut || {};
            const f = { ...base, totals: { ...(base.totals || {}), ...t } };
            out.fields = JSON.stringify(f);
          }
        }
      }
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
