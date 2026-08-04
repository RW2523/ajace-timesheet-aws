#!/usr/bin/env node
// Real syntax gate for the JS sources.
//
// WHY THIS EXISTS: `node --check file.js` is NOT a syntax gate for this repo.
// Node >= 20 detects ESM from the source (an `import`/`export` anywhere), and
// for the ESM path `--check` exits 0 without reporting parse errors. Verified
// on Node v22.20.0: a file containing
//     import x from "y";
//     const a = <div>{x</div>;
//     function f( { const q = ;
// passes `node --check` with exit 0. The same bytes in a .cjs file fail with
// exit 1. Every file under app/, components/ and lib/ has import/export, so
// `node --check` was silently green on all of them — zero signal.
//
// This gate parses each file with the @babel/parser that Next already ships
// (next/dist/compiled/babel/parser), with JSX enabled, so it sees exactly the
// syntax the build sees. It needs no database, no network and no build.
//
// Run:  node test/syntax.test.mjs      (also runs first inside test/run.sh)

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("next/dist/compiled/babel/parser");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOTS = ["app", "components", "lib", "test"];
const ROOT_FILES = ["middleware.js", "next.config.js"];
const EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "out", "build"]);

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // directory absent in this checkout
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (EXTS.has(extname(e.name))) acc.push(full);
  }
  return acc;
}

const files = [];
for (const r of ROOTS) walk(join(ROOT, r), files);
for (const f of ROOT_FILES) {
  const full = join(ROOT, f);
  try {
    if (statSync(full).isFile()) files.push(full);
  } catch {
    /* optional */
  }
}
files.sort();

const failures = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  // "unambiguous" lets the CommonJS config files (next.config.js) parse as
  // scripts while everything with import/export parses as a module.
  const sourceType = extname(file) === ".cjs" ? "script" : "unambiguous";
  try {
    parse(src, { sourceType, plugins: ["jsx"], errorRecovery: false });
  } catch (err) {
    const loc = err.loc ? `${err.loc.line}:${err.loc.column}` : "?";
    failures.push({ file: relative(ROOT, file).split(sep).join("/"), loc, message: err.message });
  }
}

if (failures.length) {
  console.error(`syntax: ${failures.length} file(s) failed to parse`);
  for (const f of failures) console.error(`  ${f.file}:${f.loc}  ${f.message}`);
  process.exit(1);
}
console.log(`syntax: ${files.length} files parsed OK (ESM + JSX)`);
