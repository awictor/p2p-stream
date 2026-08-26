#!/usr/bin/env node
/**
 * numenv.test.js — validated numeric env reader (P2P-0097, config-robustness sweep).
 *
 * The bug this closes (iter 84 recurring): `Number(x ?? d)` lets a typo'd NaN through (?? only guards
 * null/undefined), and `Number(x)||d` maps a legit 0 to the default AND passes a negative. A guard
 * limit that silently becomes NaN/negative is worse than the default — it reads as real. numEnv
 * catches NaN and negatives, allows fractions (unlike posIntEnv, since refillPerSec=0.5 is valid),
 * and `allowZero` accepts 0 as a documented opt-out (e.g. RATE_CAPACITY=0 disables limiting).
 *
 * tracker.js exports numEnv; it mirrors the metrics.js copy. Testing the exported one pins the shape.
 *
 * Usage: node test/numenv.test.js     (exit 0 = pass, 1 = fail)
 */
import { numEnv } from "../server/tracker.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const D = 30; // stand-in default
const at = (val, opts) => numEnv("X", D, { env: val === undefined ? {} : { X: String(val) }, ...opts });

console.log("valid values pass through (incl. fractions)");
{
  check("a positive integer", at(42), 42);
  check("a fraction (numEnv allows it, posIntEnv would not)", at(0.5), 0.5);
  check("a large value", at(1e9), 1e9);
}

console.log("\nthe two bugs numEnv exists to catch");
{
  // Number('abc' ?? 30) === NaN -> the ?? bug. numEnv must reject.
  check("NaN (non-numeric string) -> default", at("abc"), D);
  // Number('-5')||30 === -5 -> the ||d bug (negative passes). numEnv must reject.
  check("negative -> default", at(-5), D);
}

console.log("\nzero handling: opt-out only when allowZero");
{
  check("0 without allowZero -> default (0 is not a positive limit)", at(0), D);
  check("0 WITH allowZero -> 0 (documented disable switch)", at(0, { allowZero: true }), 0);
  check("negative still rejected even with allowZero", at(-1, { allowZero: true }), D);
}

console.log("\nunset / empty -> default");
{
  check("undefined -> default", at(undefined), D);
  check("empty string -> default", numEnv("X", D, { env: { X: "" } }), D);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
