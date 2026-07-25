"use client";
// Browser-side API client. Wraps this app's own routes (/api/auth/*,
// /api/data, /api/storage/*) behind a small `.auth` / `.from` / `.storage`
// surface so components read declaratively instead of hand-rolling fetches.
import { makeBuilder } from "@/lib/aws/builder";

const JSON_HEADERS = { "Content-Type": "application/json" };
const wrapErr = (msg) => ({ message: msg || "request failed" });

async function dataRunner(st) {
  const res = await fetch("/api/data", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(st),
  });
  const j = await res.json().catch(() => ({ data: null, error: "bad response" }));
  // /api/data reports `error` as a plain string; callers read `error.message`.
  // Normalise to the { message } shape so failures are readable, not `undefined`.
  if (j && j.error) {
    return { data: null, error: wrapErr(typeof j.error === "string" ? j.error : j.error.message) };
  }
  return j;
}

export function createClient() {
  return {
    auth: {
      async signInWithPassword({ email, password }) {
        const r = await fetch("/api/auth/login", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password }) });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { data: { user: j.user, session: {} }, error: null } : { data: null, error: wrapErr(j.error) };
      },
      async signUp({ email, password, options }) {
        const r = await fetch("/api/auth/signup", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password, meta: options?.data || {} }) });
        const j = await r.json().catch(() => ({}));
        // signup sets the session cookie, so return a truthy session (already logged in)
        return r.ok ? { data: { user: j.user, session: {} }, error: null } : { data: null, error: wrapErr(j.error) };
      },
      async signOut() {
        await fetch("/api/auth/logout", { method: "POST" });
        return { error: null };
      },
      async getUser() {
        const r = await fetch("/api/auth/me");
        const j = await r.json().catch(() => ({ user: null }));
        return { data: { user: j.user || null } };
      },
      // Always resolves ok (never reveals whether the address exists).
      // `emailConfigured` is a config-level constant, so the UI can avoid
      // promising "check your inbox" when SES isn't set up yet.
      async resetPasswordForEmail(email) {
        const r = await fetch("/api/auth/forgot", {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email }),
        });
        const j = await r.json().catch(() => ({}));
        return { data: { emailConfigured: !!j.emailConfigured }, error: null };
      },
      // reset now happens via a token on the /reset page (see /api/auth/reset)
      async updateUser() { return { data: null, error: wrapErr("use the reset link") }; },
    },

    from: (table) => makeBuilder(table, dataRunner),

    storage: {
      from() {
        // App-proxied storage: bytes flow browser <-> app <-> S3. Same-origin,
        // so no S3 CORS config and no presigned-PUT checksum issues.
        const getUrl = (path) => `/api/storage/get?path=${encodeURIComponent(path)}`;
        return {
          async upload(path, file) {
            const fd = new FormData();
            fd.append("path", path);
            fd.append("file", file);
            const r = await fetch("/api/storage/upload", { method: "POST", body: fd });
            if (r.ok) return { data: { path }, error: null };
            const j = await r.json().catch(() => ({}));
            return { data: null, error: wrapErr(j.error || "upload failed") };
          },
          // returns a same-origin URL the app serves (usable as src/href or fetched)
          async createSignedUrl(path) {
            return { data: { signedUrl: getUrl(path) }, error: null };
          },
          async download(path) {
            const f = await fetch(getUrl(path));
            return f.ok ? { data: await f.blob(), error: null } : { data: null, error: wrapErr("download failed") };
          },
          async remove(paths) {
            await fetch("/api/storage/remove", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ paths }) });
            return { data: null, error: null };
          },
        };
      },
    },
  };
}
