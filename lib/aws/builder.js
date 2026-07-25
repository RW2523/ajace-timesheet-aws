// A tiny thenable query builder. `run(state)` executes it
// and resolves { data, error }. The browser shim passes a fetch-based runner;
// the server shim passes a direct-DB runner. This keeps the app's existing
// `.from(t).select().eq().single()` call sites working unchanged.
export function makeBuilder(table, run) {
  const st = {
    table, op: "select", columns: "*", filters: [],
    values: undefined, order: undefined, single: false, onConflict: undefined,
  };
  const api = {
    select(cols = "*") { st.columns = cols; return api; },
    insert(values) { st.op = "insert"; st.values = values; return api; },
    upsert(values, opts) { st.op = "upsert"; st.values = values; st.onConflict = opts?.onConflict; return api; },
    update(values) { st.op = "update"; st.values = values; return api; },
    delete() { st.op = "delete"; return api; },
    eq(col, val) { st.filters.push({ col, op: "eq", val }); return api; },
    order(col, opts) { st.order = { col, ascending: opts?.ascending !== false }; return api; },
    limit() { return api; }, // accepted, no-op (app doesn't rely on server limit)
    single() { st.single = true; return api; },
    maybeSingle() { st.single = true; return api; },
    then(resolve, reject) { return run(st).then(resolve, reject); },
    catch(reject) { return run(st).catch(reject); },
  };
  return api;
}
