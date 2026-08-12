#!/usr/bin/env node
/**
 * powbits.test.js — ISSUE_POW_BITS is clamped so a mis-set difficulty cannot BRICK issuance
 * (P2P HARDEN, iter 120).
 *
 * The shipped solver (solvePow, maxTries=1<<24) can only reliably find a nonce up to ~24 leading
 * zero bits. Before this guard, `ISSUE_POW_BITS=40` would be honoured verbatim: every POST /issue
 * would 400 forever because no client could ever produce a meeting nonce, and NOTHING warned — a
 * self-inflicted DoS on the cert path. resolvePowBits() clamps to MAX_POW_BITS and warns, the same
 * fail-safe as the iter-84 MAX_* env limits (a garbage limit must fall back + warn, never silently
 * disable/brick the guard).
 *
 * Usage: node test/powbits.test.js     (exit 0 = pass, 1 = fail)
 */
import { resolvePowBits, MAX_POW_BITS } from "../server/tracker.js";
import { solvePow, verifyPow, makeChallenge } from "../server/identity.js";

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

// Capture warnings so we can assert the fail-safe SPOKE (a silent clamp is a footgun of its own).
function withWarn(fn) {
  const warns = [];
  const r = fn((m) => warns.push(m));
  return { r, warns };
}

console.log("valid range passes through unchanged");
{
  check("unset -> 0 (OFF, back-compat default)", resolvePowBits(undefined, () => {}), 0);
  check("'0' -> 0", resolvePowBits("0", () => {}), 0);
  check("'12' -> 12", resolvePowBits("12", () => {}), 12);
  check(`MAX (${MAX_POW_BITS}) passes unchanged`, resolvePowBits(String(MAX_POW_BITS), () => {}), MAX_POW_BITS);
}

console.log("\nover-large difficulty is CLAMPED and WARNS (not honoured as an un-meetable target)");
{
  const { r, warns } = withWarn((w) => resolvePowBits("40", w));
  check("40 -> clamped to MAX", r, MAX_POW_BITS);
  checkTrue("a warning fired about the clamp", warns.some((m) => /clamp|MAX_POW_BITS/i.test(m)),
    "a silent clamp hides an operator's mistake");
}

console.log("\ngarbage falls back to 0 and warns (iter-84 fail-safe class)");
{
  const { r, warns } = withWarn((w) => resolvePowBits("8oo", w));
  check("'8oo' -> 0 (not NaN, not honoured)", r, 0);
  checkTrue("garbage warned", warns.some((m) => /not a positive integer/i.test(m)));
  check("negative -> 0", resolvePowBits("-5", () => {}), 0);
  check("fractional -> 0 (not an integer bit target)", resolvePowBits("3.5", () => {}), 0);
  // Silent on the explicit OFF values — no noise when the operator meant OFF.
  const quiet = withWarn((w) => resolvePowBits("0", w));
  check("'0' does not warn (explicit OFF is not a mistake)", quiet.warns.length, 0);
}

console.log("\nthe clamp ceiling is within the shipped solver's reach (the whole point)");
{
  // If MAX_POW_BITS were set above what solvePow can reach, the clamp would still brick issuance.
  // solvePow's maxTries is 1<<24, i.e. it can cover up to ~24 leading-zero bits; assert the ceiling
  // does not exceed that budget. (Brute-forcing a full MAX-bit nonce here would cost ~2^MAX hashes
  // and stall the suite — the invariant is the ceiling ≤ the solver's tries-exponent, not a live
  // solve at the ceiling.)
  check("MAX_POW_BITS does not exceed the solver's 24-bit tries budget", MAX_POW_BITS <= 24, true);
  // A cheap representative solve proves the solver + verify actually agree at a non-trivial target.
  const challenge = makeChallenge();
  const bits = 16;
  const nonce = solvePow(challenge, bits);
  checkTrue(`solvePow finds a nonce at a representative ${bits} bits`, typeof nonce === "string" && nonce.length > 0);
  checkTrue("and it verifies", verifyPow(challenge, nonce, bits));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
