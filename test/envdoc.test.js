#!/usr/bin/env node
/**
 * envdoc.test.js — every operator-facing env var is documented (iter 87, P2P-0067).
 *
 * HARD RULE 5: an item that needs config reads it from an env var AND documents it. The security
 * guards shipped iters 75/77/79/84 are all env-tunable, and SECURITY.md tells an operator to tune
 * them -- but a knob with no documented name is not actionable. This greps the REAL sources for
 * every `process.env.X` and asserts each appears in .env.example, so a new undocumented env cannot
 * be introduced silently.
 *
 * Scanned: server/*.js and test/verify-offload.js (the operator/harness surface). Excluded: envs
 * that are machine/runtime internals, not operator config -- HOME, USERPROFILE (home-dir
 * resolution), PLAYWRIGHT_PATH (test-driver location). If a real new operator var is added it MUST
 * land in .env.example; if a new INTERNAL var is added it must be added to EXCEPTIONS here with a
 * reason, which is itself a visible decision.
 *
 * Usage: node test/envdoc.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

// Internal/runtime envs that are NOT operator configuration. Each excluded WITH a reason so the
// exclusion is a visible, reviewable decision rather than a silent gap.
const EXCEPTIONS = {
  HOME: "home-dir resolution for the vendored-binary path, OS-provided",
  USERPROFILE: "Windows home-dir resolution, OS-provided",
  PLAYWRIGHT_PATH: "location of the local playwright driver, a developer machine detail",
  P: "shell loop index inside a bash script, not a Node env",
};

const SOURCES = ["server/metrics.js", "server/tracker.js", "test/verify-offload.js"];

// Collect every process.env.NAME the code reads. posIntEnv("NAME", d) is the iter-84 wrapper — its
// argument is an env name too, and a naive process.env grep MISSES it (learned iter 86), so scan
// both forms.
const read = new Set();
for (const rel of SOURCES) {
  const src = readFileSync(path.join(ROOT, rel), "utf8");
  for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) read.add(m[1]);
  for (const m of src.matchAll(/posIntEnv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g)) read.add(m[1]);
}

console.log(".env.example exists and is the single source of documented env");
const envPath = path.join(ROOT, ".env.example");
checkTrue(".env.example exists", existsSync(envPath),
  "HARD RULE 5: env-configurable must be documented");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
// Names documented in .env.example (LHS of `NAME=`, ignoring comment lines).
const documented = new Set(
  envText.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"))
    .map((l) => (l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/) || [])[1]).filter(Boolean)
);

console.log("\nfound these env reads in the code:");
console.log("  " + [...read].sort().join(", "));

console.log("\nevery operator-facing env the code reads is documented in .env.example");
{
  for (const name of [...read].sort()) {
    if (name in EXCEPTIONS) {
      console.log(`  SKIP  ${name} — excepted: ${EXCEPTIONS[name]}`);
      continue;
    }
    checkTrue(`${name} is documented in .env.example`, documented.has(name),
      "a tunable guard with no documented name is not actionable (HARD RULE 5)");
  }
}

console.log("\nthe security-guard knobs SECURITY.md references are specifically present");
{
  // These are the ones a security reviewer will look for after reading SECURITY.md.
  for (const g of ["MAX_CLIENTS", "WS_MAX_PAYLOAD", "MAX_REPORT_BYTES", "MIN_ATTESTERS"]) {
    checkTrue(`${g} documented`, documented.has(g));
  }
}

console.log("\n.env.example holds no real secret (defaults/placeholders only)");
{
  // A committed .env.example must never carry a real credential. Heuristic: no obvious key material.
  checkTrue("no bearer/API-key-looking value", !/(BEARER|SECRET|APIKEY|API_KEY|PASSWORD)\s*=\s*\S+/i.test(envText));
  checkTrue("no long base64-ish token on any RHS",
    !envText.split(/\r?\n/).some((l) => /=\s*[A-Za-z0-9+/]{40,}=*\s*$/.test(l)));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
