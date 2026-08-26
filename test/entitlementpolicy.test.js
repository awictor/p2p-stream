#!/usr/bin/env node
/**
 * entitlementpolicy.test.js — tiered ad-free entitlement policy (P2P-0095, iter 173).
 *
 * RICHER ENTITLEMENT POLICY milestone. applyPolicy(receiptedBytes, policy) turns the payout-grade
 * relay figure into ad-free SECONDS under a MARGINAL tiered rate (tax-bracket style: each byte band
 * earns at its own tier's rate), with an optional dayCapSeconds ceiling. Still OWED, never PAID.
 *
 * Pins: marginal (not whole-recompute) accounting, monotonicity, 0-at-0, junk->0, cap clamp, and
 * equivalence to the flat earnedEntitlement for a single open tier.
 *
 * Usage: node test/entitlementpolicy.test.js     (exit 0 = pass, 1 = fail)
 */
import { applyPolicy, earnedEntitlement } from "../server/entitlement.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}

// Two-tier policy: first 10MB at 1MB/s (cheap: 1s per MB), everything above at 2MB/s (dearer: 0.5s per MB).
const POLICY = {
  tiers: [
    { uptoBytes: 10_000_000, bytesPerSecond: 1_000_000 },
    { bytesPerSecond: 2_000_000 }, // open last tier
  ],
};

console.log("marginal tiers — each band earns at its own rate (tax-bracket, not whole-recompute)");
{
  // 5MB, all in tier 1: 5MB / 1MB/s = 5s.
  check("below threshold uses tier-1 rate", applyPolicy(5_000_000, POLICY), 5);
  // Exactly 10MB: 10s (tier 1 full).
  check("at threshold = tier-1 full", applyPolicy(10_000_000, POLICY), 10);
  // 14MB: 10s (first 10MB @1MB/s) + 4MB/2MB/s = 2s => 12s. Whole-recompute at 2MB/s would give 7s;
  // whole-recompute at 1MB/s would give 14s. Marginal is 12 — this is the discriminating assertion.
  check("above threshold is MARGINAL (10 + 2 = 12, not 7 or 14)", applyPolicy(14_000_000, POLICY), 12);
}

console.log("\nmonotonic non-decreasing, exactly 0 at 0");
{
  check("0 bytes -> 0", applyPolicy(0, POLICY), 0);
  checkTrue("more bytes never fewer seconds",
    applyPolicy(20_000_000, POLICY) >= applyPolicy(14_000_000, POLICY) &&
    applyPolicy(14_000_000, POLICY) >= applyPolicy(5_000_000, POLICY));
}

console.log("\njunk -> 0 (never fabricate an entitlement)");
{
  check("negative -> 0", applyPolicy(-5, POLICY), 0);
  check("NaN -> 0", applyPolicy(NaN, POLICY), 0);
  check("string junk -> 0", applyPolicy("lots", POLICY), 0);
}

console.log("\ndayCapSeconds clamps the total");
{
  const capped = { ...POLICY, dayCapSeconds: 8 };
  // 14MB would be 12s uncapped; cap at 8.
  check("clamps to dayCapSeconds", applyPolicy(14_000_000, capped), 8);
  check("below cap unaffected", applyPolicy(5_000_000, capped), 5);
}

console.log("\nsingle open tier == flat earnedEntitlement for the same rate");
{
  const flatPolicy = { tiers: [{ bytesPerSecond: 1_000_000 }] };
  const bytes = 7_500_000;
  check("applyPolicy single-tier matches earnedEntitlement",
    applyPolicy(bytes, flatPolicy), earnedEntitlement({ receiptedBytes: bytes, bytesPerSecond: 1_000_000 }));
}

console.log("\nempty/malformed policy falls back to flat default (not 0 for real bytes)");
{
  checkTrue("no tiers -> flat default > 0 for real bytes", applyPolicy(5_000_000, {}) > 0);
  checkTrue("no tiers matches earnedEntitlement default",
    applyPolicy(5_000_000, {}) === earnedEntitlement({ receiptedBytes: 5_000_000 }));
}

// ---- HARDEN (P2P-0174): pin the malformed-tier edge contract so a refactor can't silently drift it.
console.log("\njunk-rate tier: its band earns 0, and bytes in that band are NOT re-credited elsewhere");
{
  // tier1 0-10MB @1MB/s (=10s), tier2 10-20MB with a JUNK rate (0 seconds for that band), tier3 open @1MB/s.
  // 15MB: 10s (tier1) + 0 (tier2 junk band, the 5MB in 10-15 earns nothing) + 0 (nothing above 20MB) = 10s.
  // The 5MB in the junk band must be CONSUMED (lower advances), not spilled into tier3 — else it double-earns.
  const p = { tiers: [
    { uptoBytes: 10_000_000, bytesPerSecond: 1_000_000 },
    { uptoBytes: 20_000_000, bytesPerSecond: 0 },      // junk rate -> band earns 0
    { bytesPerSecond: 1_000_000 },                      // open
  ] };
  check("junk-rate band earns 0 and does not leak to a later tier", applyPolicy(15_000_000, p), 10);
  // 25MB: 10s (tier1) + 0 (tier2) + 5MB above 20MB @1MB/s = 5s => 15s.
  check("bytes above the junk band earn in the open tier", applyPolicy(25_000_000, p), 15);
}

console.log("\nnon-ascending uptoBytes: a tier whose ceiling <= lower collapses to the open path (documented)");
{
  // tier2's uptoBytes (5MB) is BELOW tier1's (10MB). Per the code, ceil = upto>lower ? upto : Infinity,
  // so tier2 becomes an OPEN tier catching the remainder at its rate. Pin THIS behaviour (not a crash/NaN).
  const p = { tiers: [
    { uptoBytes: 10_000_000, bytesPerSecond: 1_000_000 },
    { uptoBytes: 5_000_000, bytesPerSecond: 2_000_000 }, // mis-ordered -> treated as open
  ] };
  // 14MB: 10s (tier1 0-10MB) + 4MB @2MB/s = 2s => 12s. No NaN, no crash, deterministic.
  check("mis-ordered tier resolves deterministically (no NaN)", applyPolicy(14_000_000, p), 12);
  checkTrue("result is a finite integer", Number.isInteger(applyPolicy(14_000_000, p)));
}

console.log("\ntiers not an array -> flat fallback (not a throw)");
{
  checkTrue("tiers:'oops' falls back to flat default", applyPolicy(5_000_000, { tiers: "oops" }) === earnedEntitlement({ receiptedBytes: 5_000_000 }));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
