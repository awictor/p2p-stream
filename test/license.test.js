#!/usr/bin/env node
/**
 * license.test.js — the repo is legally adoptable (iter 83, P2P-0066).
 *
 * A public repo with NO license is default-copyright: nobody may use, copy, or ship it, so every
 * "drop this in front of your CDN" pitch is legally void. The user chose MIT (iter 82). This pins
 * that the LICENSE file exists, is the real MIT text (not a stub), and that package.json agrees --
 * a package.json claiming a license the LICENSE file does not match is its own trap.
 *
 * Usage: node test/license.test.js     (exit 0 = pass, 1 = fail)
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
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

console.log("LICENSE exists and is the real MIT text");
{
  const p = path.join(ROOT, "LICENSE");
  checkTrue("LICENSE file exists at repo root", existsSync(p),
    "no license = default copyright = legally un-adoptable");
  const txt = existsSync(p) ? readFileSync(p, "utf8") : "";
  checkTrue("says 'MIT License'", /MIT License/.test(txt));
  // The load-bearing grant sentence — a stub or placeholder would omit it.
  checkTrue("contains the MIT permission grant", /Permission is hereby granted, free of charge/.test(txt));
  checkTrue("contains the AS IS warranty disclaimer", /THE SOFTWARE IS PROVIDED "AS IS"/.test(txt));
  // A real copyright line with a holder, not the template's "[year] [name]" placeholder.
  checkTrue("has a real copyright line (year + holder, not a placeholder)",
    /Copyright \(c\) \d{4} \S+/.test(txt) && !/\[year\]|\[fullname\]|<year>|YOUR NAME/i.test(txt),
    "an unfilled MIT template is not a license");
}

console.log("\npackage.json agrees with the LICENSE file");
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check("package.json license is MIT", pkg.license, "MIT");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
