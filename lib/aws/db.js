// Direct Postgres (Amazon RDS) connection pool — replaces Supabase/PostgREST.
// One pool per server process. RDS requires TLS; we trust the AWS CA chain.
import { Pool } from "pg";

let _pool;
export function pool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // RDS uses a TLS cert signed by the AWS RDS CA. rejectUnauthorized:false
      // accepts it without bundling the CA file; set PGSSL=disable for local/no-TLS.
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

// Small helper: parameterized query -> rows. NEVER interpolate user input into `text`.
export async function query(text, params = []) {
  const res = await pool().query(text, params);
  return res.rows;
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}
