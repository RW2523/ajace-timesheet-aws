// Import a REAL App Router handler (app/api/**/route.js) into plain Node.
//
// Why this exists: the routes are the thing that has to be right, and until now
// every assertion about them was made by READING their source. A source read
// cannot tell you that `if (isUnusablePassword(...))` actually runs before
// bcrypt, only that the line is written above it. So this registers a module
// resolve hook that teaches bare Node the two things only Next's bundler knows:
//
//   "@/lib/aws/db"  -> <repo>/lib/aws/db.js      (the jsconfig.json path alias;
//                                                 Node ESM does not read it, and
//                                                 it also needs the extension)
//   "next/server"   -> "next/server.js"          (Next's package exports map is
//   "next/headers"  -> "next/headers.js"          resolved by the bundler, not
//                                                 by Node's ESM resolver)
//
// NOTHING ELSE IS SUBSTITUTED. The handler that runs under these tests is the
// same file, byte for byte, that `next build` compiles — no stub of db.js, no
// fake of people.js, no re-implementation of the guard being tested. If the
// guard is deleted from the route, this import still succeeds and the test fails,
// which is the entire point.
//
// LIMIT, stated so nobody over-reads a green run: cookies() from next/headers
// throws outside a request scope, so only handler paths that do not set or read
// a cookie can be exercised here. Every path these tests drive is a REFUSAL
// (401/403/400/409), and refusals never touch the session cookie. A success path
// that calls setSessionCookie() must be tested against a running server instead.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's App Router storages are written to run on Edge as well as Node, so they
// take AsyncLocalStorage off the global rather than importing node:async_hooks,
// and throw "accessed in runtime where it is not available" if it is absent.
// This has to be set BEFORE the first route import: lib/aws/auth.js imports
// next/headers at module load, which pulls the storage modules in with it.
if (!globalThis.AsyncLocalStorage) globalThis.AsyncLocalStorage = AsyncLocalStorage;

const ROOT = new URL("..", import.meta.url).href.replace(/\/$/, "");

const hookSource = `
const ROOT = ${JSON.stringify(ROOT)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/headers") {
    return nextResolve(specifier + ".js", context);
  }
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const withExt = /\\.[a-z]+$/.test(rel) ? rel : rel + ".js";
    return nextResolve(ROOT + "/" + withExt, context);
  }
  return nextResolve(specifier, context);
}
`;

let registered = false;
/** Call once before importing any route module. */
export function enableRouteImports() {
  if (registered) return;
  register("data:text/javascript," + encodeURIComponent(hookSource), import.meta.url);
  registered = true;
}

/** Import a route by repo-relative path, e.g. "app/api/auth/login/route.js". */
export async function importRoute(relPath) {
  enableRouteImports();
  return import(pathToFileURL(new URL("../" + relPath, import.meta.url).pathname).href);
}

/** Build a Request the App Router handlers accept. */
export function jsonRequest(url, body, init = {}) {
  return new Request(url, {
    method: init.method || "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": init.ip || "203.0.113.7", ...(init.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// A REQUEST SCOPE, so currentUser() can read a cookie.
//
// currentUser() calls cookies() from next/headers, which reads Next's request
// AsyncLocalStorage and throws "called outside a request scope" if there isn't
// one. Running the handler inside that same storage with a cookie jar is what a
// real request does; nothing about currentUser() is stubbed, so the session
// token is verified by the real verifySession() and the role is re-read from the
// real database exactly as it is in production.
let _requestAsyncStorage;
async function requestStorage() {
  if (!_requestAsyncStorage) {
    ({ requestAsyncStorage: _requestAsyncStorage } =
      await import("next/dist/client/components/request-async-storage.external.js"));
  }
  return _requestAsyncStorage;
}

/**
 * Run `fn` as if inside a request carrying `cookies` (a plain {name: value}).
 * Returns { result, jar } — jar is the Map the handler wrote cookies into, so a
 * test can assert that a session cookie WAS or WAS NOT set.
 */
export async function withRequestScope(cookies, fn) {
  const als = await requestStorage();
  const jar = new Map(Object.entries(cookies || {}));
  const bag = {
    get: (n) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (n) => jar.has(n),
    set: (n, v) => { jar.set(typeof n === "object" ? n.name : n, typeof n === "object" ? n.value : v); },
    delete: (n) => jar.delete(n),
  };
  const store = { cookies: bag, mutableCookies: bag, headers: new Headers(), draftMode: {} };
  const result = await als.run(store, fn);
  return { result, jar };
}
