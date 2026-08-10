#!/usr/bin/env node
/**
 * identity.test.js — the crypto core of authenticated peer identity (P2P-0068, iter 93).
 *
 * This is the primitive SECURITY.md says every payable number must rest on: if a report can be
 * signed and the signature verified, then an upload figure can be BOUND to a key instead of to a
 * free `prefix + Math.random()` peerId. The whole reward tier depends on this being sound.
 *
 * The assertions that matter: a sig from key B must NOT verify under key A (forgery), and mutating
 * ANY field after signing must fail (tamper) — that second one is why canonicalize() exists: the
 * signature covers bytes, so if field order could change the bytes, tamper detection would be
 * bypassable by reordering.
 *
 * SCOPE: this file tests only the crypto. It does NOT test that a key belongs to a distinct
 * tracker-vouched peer (that is P2P-0070) — signing closes SOLO forgery of a report, not collusion.
 *
 * Usage: node test/identity.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReport, verifyReport, canonicalize } from "../server/identity.js";

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

const REPORT = { clientId: "c1", peerId: "p1", httpBytes: 100, p2pBytes: 300, uploadBytes: 300, ts: 1700000000000 };

console.log("issueIdentity yields a usable ed25519 keypair");
{
  const id = issueIdentity();
  checkTrue("returns publicKey + privateKey strings", typeof id.publicKey === "string" && typeof id.privateKey === "string");
  checkTrue("keys are non-empty base64", id.publicKey.length > 0 && id.privateKey.length > 0);
  const id2 = issueIdentity();
  checkTrue("two issuances differ (real keygen, not a constant)", id.publicKey !== id2.publicKey);
}

console.log("\na valid signature verifies");
{
  const { publicKey, privateKey } = issueIdentity();
  const sig = signReport(REPORT, privateKey);
  checkTrue("signReport returns a base64 sig", typeof sig === "string" && sig.length > 0);
  checkTrue("verifyReport accepts the matching key", verifyReport(REPORT, sig, publicKey));
}

console.log("\nTHE FORGERY CASE: a sig from key B does NOT verify under key A");
{
  const a = issueIdentity();
  const b = issueIdentity();
  const sigB = signReport(REPORT, b.privateKey);
  checkTrue("B's signature verifies under B", verifyReport(REPORT, sigB, b.publicKey));
  check("B's signature does NOT verify under A", verifyReport(REPORT, sigB, a.publicKey), false);
}

console.log("\nTHE TAMPER CASE: mutating ANY field after signing fails verify");
{
  const { publicKey, privateKey } = issueIdentity();
  const sig = signReport(REPORT, privateKey);
  for (const field of ["httpBytes", "p2pBytes", "uploadBytes", "peerId", "clientId", "ts"]) {
    const tampered = { ...REPORT, [field]: (typeof REPORT[field] === "number" ? REPORT[field] + 1 : REPORT[field] + "X") };
    check(`tampering ${field} fails verify`, verifyReport(tampered, sig, publicKey), false);
  }
  // Removing a field also fails.
  const { ts, ...noTs } = REPORT;
  check("removing a field fails verify", verifyReport(noTs, sig, publicKey), false);
  // Adding a field fails.
  check("adding a field fails verify", verifyReport({ ...REPORT, extra: 1 }, sig, publicKey), false);
}

console.log("\nCANONICAL: field ORDER must not change the signed bytes (why tamper-detection is sound)");
{
  const { publicKey, privateKey } = issueIdentity();
  // Sign an object built in one key order; verify an equal object built in a DIFFERENT order.
  const ordered1 = { a: 1, b: 2, c: { z: 9, y: 8 } };
  const ordered2 = { c: { y: 8, z: 9 }, b: 2, a: 1 };
  check("canonicalize is order-independent", canonicalize(ordered1), canonicalize(ordered2));
  const sig = signReport(ordered1, privateKey);
  checkTrue("a reordered-but-equal object still verifies", verifyReport(ordered2, sig, publicKey),
    "if this fails, an honest JSON re-encode would spuriously reject; if order MATTERED, tamper-by-reorder would pass");
  // But a genuinely different value under the same keys must still fail.
  check("a changed nested value fails", verifyReport({ a: 1, b: 2, c: { z: 9, y: 7 } }, sig, publicKey), false);
}

console.log("\nkey reuse across reports is fine (one identity signs many reports)");
{
  const { publicKey, privateKey } = issueIdentity();
  const r1 = { ...REPORT, ts: 1 }, r2 = { ...REPORT, ts: 2 };
  const s1 = signReport(r1, privateKey), s2 = signReport(r2, privateKey);
  checkTrue("both reports verify under the same key", verifyReport(r1, s1, publicKey) && verifyReport(r2, s2, publicKey));
  check("but s1 does not verify r2 (sig is bound to content)", verifyReport(r2, s1, publicKey), false);
}

console.log("\nSIGNATURE MALLEABILITY: base64 junk appended to a valid sig must NOT verify (iter 94)");
{
  // Node's base64 decoder stops at the last complete quad and drops trailing bytes, so `sig+"AA"`
  // decoded to the same 64 bytes and USED to verify. An ed25519 sig is exactly 64 bytes; enforce it.
  const { publicKey, privateKey } = issueIdentity();
  const sig = signReport(REPORT, privateKey);
  checkTrue("the clean sig verifies", verifyReport(REPORT, sig, publicKey));
  for (const suffix of ["A", "AA", "AAAA", "==", "garbage"]) {
    check(`sig + ${JSON.stringify(suffix)} is REJECTED`, verifyReport(REPORT, sig + suffix, publicKey), false);
  }
  // A truncated sig (fewer than 64 bytes) is also rejected.
  check("a truncated sig is rejected", verifyReport(REPORT, sig.slice(0, 40), publicKey), false);
  // A garbage-suffixed PUBLIC KEY is rejected too (spki ed25519 is exactly 44 bytes).
  check("pubkey + garbage is rejected", verifyReport(REPORT, sig, publicKey + "garbage"), false);
}

console.log("\nSHAPE: an array report is not a valid report (confusable with a keyed object)");
{
  const { publicKey, privateKey } = issueIdentity();
  check("signing an array returns null", signReport([1, 2, 3], privateKey), null);
  check("signing a scalar returns null", signReport(42, privateKey), null);
  // Even if some other path produced a sig, verifying an array report is false.
  const objSig = signReport({ a: 1 }, privateKey);
  check("verifying an array report -> false", verifyReport([1, 2, 3], objSig, publicKey), false);
}

console.log("\nmalformed / empty inputs return false or null, never throw");
{
  check("verify with empty sig -> false", verifyReport(REPORT, "", "x"), false);
  check("verify with empty pubkey -> false", verifyReport(REPORT, "x", ""), false);
  check("verify with non-string sig -> false", verifyReport(REPORT, null, "x"), false);
  check("verify with garbage base64 key -> false", verifyReport(REPORT, "!!!", "!!!"), false);
  check("verify with non-object report -> false", verifyReport("not-an-object", "x", "x"), false);
  check("sign with bad private key -> null", signReport(REPORT, "not-a-key"), null);
  check("sign with empty private key -> null", signReport(REPORT, ""), null);
  check("sign with non-string key -> null", signReport(REPORT, 12345), null);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
