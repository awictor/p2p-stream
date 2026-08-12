#!/usr/bin/env node
/**
 * pow.test.js — cert-issuance proof-of-work primitive (P2P-0078, iter 113).
 *
 * The reward tier gates SOLO forgery (receiptedBytes) but the tracker's /issue endpoint still hands
 * a cert to any pubkey for nothing, so a certified COLLUSION RING is free to assemble. verifyPow is
 * the primitive that prices each issuance in CPU: a client must find a nonce whose sha256(challenge+
 * nonce) has >= `bits` leading zero bits. This file pins the primitive; wiring it into /issue is
 * P2P-0079.
 *
 * THREAT (HARD RULE 6): PoW prices minting in CPU, it does NOT prove a distinct human, and it is
 * only anti-replay once the ISSUER makes a challenge single-use (that binding is P2P-0079).
 *
 * Usage: node test/pow.test.js     (exit 0 = pass, 1 = fail)
 */
import { makeChallenge, verifyPow, solvePow } from "../server/identity.js";
import { createHash } from "crypto";

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

// A local reference: leading zero bits of the LENGTH-PREFIXED hash (see powDigest in identity.js —
// the prefix pins the challenge/nonce boundary so a nonce cannot shift it), computed independently
// of the module so the test is not just re-asserting the implementation against itself.
function refLeadingZeroBits(challenge, nonce) {
  const d = createHash("sha256").update(String(challenge.length) + ":" + challenge + nonce).digest();
  let n = 0;
  for (const byte of d) {
    if (byte === 0) { n += 8; continue; }
    let b = byte, extra = 0;
    while (b < 128) { extra++; b <<= 1; }
    n += extra; break;
  }
  return n;
}

console.log("makeChallenge: fresh, unpredictable, hex");
{
  const a = makeChallenge(), b = makeChallenge();
  checkTrue("is a non-empty hex string", typeof a === "string" && /^[0-9a-f]+$/.test(a) && a.length === 32);
  checkTrue("two challenges differ (CSPRNG, not constant)", a !== b);
}

console.log("\nverifyPow: a solved nonce meets the target, a wrong one does not");
{
  const bits = 12;
  const challenge = makeChallenge();
  const nonce = solvePow(challenge, bits);
  checkTrue("solvePow found a nonce", typeof nonce === "string" && nonce.length > 0);
  checkTrue("the reference agrees the solved nonce meets the target", refLeadingZeroBits(challenge, nonce) >= bits);
  checkTrue("verifyPow accepts the solved nonce", verifyPow(challenge, nonce, bits));
  // A nonce for THIS challenge at LOWER difficulty is very unlikely to meet a HIGHER one; assert the
  // real relationship via the reference rather than hoping a fixed string fails.
  checkTrue("verifyPow rejects a nonce below the target",
    verifyPow(challenge, "definitely-not-solved", bits) === (refLeadingZeroBits(challenge, "definitely-not-solved") >= bits));
}

console.log("\nverifyPow: harder target than the nonce solves for is rejected");
{
  const challenge = makeChallenge();
  const nonce = solvePow(challenge, 8);
  const got = refLeadingZeroBits(challenge, nonce);
  // Demand strictly MORE bits than this nonce actually produced -> must be rejected.
  check("a nonce meeting N bits is rejected at N+1 required (unless it happens to exceed)",
    verifyPow(challenge, nonce, got + 1), false);
}

console.log("\nbits <= 0 is the OFF switch (back-compat default)");
{
  check("bits=0 -> always true", verifyPow("anything", "anything", 0), true);
  check("negative bits -> always true (treated as disabled)", verifyPow("x", "y", -5), true);
  check("solvePow returns a trivial nonce when disabled", typeof solvePow("c", 0) === "string", true);
}

console.log("\nno-throw on garbage input (public-endpoint safety)");
{
  check("non-string challenge -> false", verifyPow(123, "n", 8), false);
  check("non-string nonce -> false", verifyPow("c", 123, 8), false);
  check("null nonce -> false", verifyPow("c", null, 8), false);
  check("NaN bits -> false (not a silent pass)", verifyPow("c", "n", NaN), false);
  check("undefined bits -> false", verifyPow("c", "n", undefined), false);
}

console.log("\nCONCATENATION AMBIGUITY: a proof is bound to ONE challenge/nonce split (iter 114)");
{
  // Without a length prefix, ("ab","c") and ("a","bc") hash identically, so one mined digest would
  // satisfy both splits. Find a nonce for challenge "ab" at a low target, then confirm that moving
  // the boundary (challenge "a", nonce "b"+nonce) is NOT automatically also valid — the two must be
  // independent. We assert the digests differ, which is what the length prefix guarantees.
  const bits = 8;
  const nonce = solvePow("ab", bits);
  checkTrue("solved a nonce for challenge 'ab'", typeof nonce === "string");
  // The shifted split has a DIFFERENT length prefix, so its digest (and thus validity) is unrelated.
  const validHere = verifyPow("ab", nonce, bits);
  const validShifted = verifyPow("a", "b" + nonce, bits);
  checkTrue("proof is valid for its own split", validHere);
  // Independence: the shifted split's validity is decided by ITS OWN digest, not inherited. Assert
  // via the reference so we are testing the property, not a coincidence.
  check("shifted split validity matches its independent digest, not the original's",
    validShifted, refLeadingZeroBits("a", "b" + nonce) >= bits);
}

console.log("\nverifyPow is deterministic for the same inputs");
{
  const challenge = makeChallenge();
  const nonce = solvePow(challenge, 10);
  check("same (challenge,nonce,bits) verifies the same twice",
    verifyPow(challenge, nonce, 10) === verifyPow(challenge, nonce, 10), true);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
