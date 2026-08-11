#!/usr/bin/env node
/**
 * entitlement.test.js — earnedEntitlement, the ad-free value-exchange arithmetic (P2P-0074, iter 105).
 *
 * Turns trustworthy relay bytes (receiptedBytes) into ad-free seconds owed, per a policy rate. Same
 * discipline as priceSaving/sanitizeBytes: junk in -> 0 out, never a fabricated entitlement. The
 * assertion that matters most is the last group — a dollar/second figure from garbage bytes reads
 * as real and would be worse than 0.
 *
 * Usage: node test/entitlement.test.js     (exit 0 = pass, 1 = fail)
 */
import { earnedEntitlement, DEFAULT_BYTES_PER_AD_FREE_SECOND } from "../server/entitlement.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

const R = DEFAULT_BYTES_PER_AD_FREE_SECOND; // 1e6

console.log("zero and linearity at the default rate");
{
  check("0 bytes -> 0 seconds", earnedEntitlement({ receiptedBytes: 0 }), 0);
  check("1 MB -> 1 ad-free second", earnedEntitlement({ receiptedBytes: R }), 1);
  check("10 MB -> 10 seconds", earnedEntitlement({ receiptedBytes: 10 * R }), 10);
  // Floored to whole seconds — you cannot owe a fractional ad-free second.
  check("1.9 MB -> 1 second (floored)", earnedEntitlement({ receiptedBytes: 1.9 * R }), 1);
  check("under one rate-unit -> 0", earnedEntitlement({ receiptedBytes: R - 1 }), 0);
}

console.log("\nmonotonic non-decreasing in receiptedBytes");
{
  let prev = -1, ok = true;
  for (const mb of [0, 0.5, 1, 2, 5, 5, 100]) {
    const s = earnedEntitlement({ receiptedBytes: mb * R });
    if (s < prev) ok = false;
    prev = s;
  }
  checkTrue("more bytes never earns fewer seconds", ok);
}

console.log("\ncustom policy rate scales inversely");
{
  // Half the bytes-per-second => twice the seconds for the same bytes.
  check("rate 0.5MB/s: 1MB -> 2 seconds", earnedEntitlement({ receiptedBytes: R, bytesPerSecond: R / 2 }), 2);
  check("rate 2MB/s: 1MB -> 0 seconds (floored)", earnedEntitlement({ receiptedBytes: R, bytesPerSecond: 2 * R }), 0);
  check("rate 2MB/s: 4MB -> 2 seconds", earnedEntitlement({ receiptedBytes: 4 * R, bytesPerSecond: 2 * R }), 2);
}

console.log("\ncap clamps a whale");
{
  check("100MB capped at 30s -> 30", earnedEntitlement({ receiptedBytes: 100 * R, capSeconds: 30 }), 30);
  check("under the cap is unaffected", earnedEntitlement({ receiptedBytes: 10 * R, capSeconds: 30 }), 10);
  check("a non-positive cap means no cap", earnedEntitlement({ receiptedBytes: 100 * R, capSeconds: 0 }), 100);
  check("a NaN cap means no cap", earnedEntitlement({ receiptedBytes: 100 * R, capSeconds: NaN }), 100);
  check("cap is floored too", earnedEntitlement({ receiptedBytes: 100 * R, capSeconds: 30.9 }), 30);
}

console.log("\nJUNK IN -> 0 OUT: no fabricated entitlement");
{
  check("negative bytes -> 0", earnedEntitlement({ receiptedBytes: -1e9 }), 0);
  check("NaN bytes -> 0", earnedEntitlement({ receiptedBytes: NaN }), 0);
  check("Infinity bytes -> 0", earnedEntitlement({ receiptedBytes: Infinity }), 0);
  check("non-numeric string -> 0", earnedEntitlement({ receiptedBytes: "lots" }), 0);
  check("a numeric string coerces (Number('1000000')) -> 1", earnedEntitlement({ receiptedBytes: "1000000" }), 1);
  check("undefined bytes -> 0", earnedEntitlement({ receiptedBytes: undefined }), 0);
  check("missing arg object -> 0", earnedEntitlement(), 0);
  // A garbage RATE must fall back to the default, not divide to Infinity/NaN.
  check("negative rate falls back to default (1MB -> 1)", earnedEntitlement({ receiptedBytes: R, bytesPerSecond: -5 }), 1);
  check("zero rate falls back to default", earnedEntitlement({ receiptedBytes: R, bytesPerSecond: 0 }), 1);
  check("NaN rate falls back to default", earnedEntitlement({ receiptedBytes: R, bytesPerSecond: NaN }), 1);
  // Never NaN/Infinity out.
  checkTrue("output is always a finite integer >= 0", (() => {
    for (const b of [0, -1, NaN, Infinity, "x", 3.3 * R, 1e15]) {
      const s = earnedEntitlement({ receiptedBytes: b });
      if (!Number.isInteger(s) || s < 0) return false;
    }
    return true;
  })());
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
