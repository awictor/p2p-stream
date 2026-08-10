#!/usr/bin/env node
/**
 * receipt.test.js — proof-of-delivery receipt crypto (P2P-0072, iter 101).
 *
 * A receipt is a receiver's signature over ONE segment transfer — {segmentId, bytes, senderPeerId,
 * receiverPeerId} — not a bulk self-attestation. It is the primitive that lets upload credit
 * reflect a transfer two parties corroborate at the segment level. The crypto reuses the ed25519
 * core (strict base64, exact lengths, canonical sign); this file pins the receipt SHAPE and the
 * forgery/tamper properties.
 *
 * SCOPE: crypto only. Whether the signer is a CERTIFIED peer, and crediting receiptedBytes, is
 * P2P-0073 (metrics wiring).
 *
 * Usage: node test/receipt.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReceipt, verifyReceipt } from "../server/identity.js";

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

const RECEIPT = { segmentId: "seg-0042", bytes: 262144, senderPeerId: "peer-A", receiverPeerId: "peer-B" };

console.log("a valid receipt verifies");
{
  const { publicKey, privateKey } = issueIdentity();
  const sig = signReceipt(RECEIPT, privateKey);
  checkTrue("signReceipt returns a base64 sig", typeof sig === "string" && sig.length > 0);
  checkTrue("verifyReceipt accepts the matching key", verifyReceipt(RECEIPT, sig, publicKey));
}

console.log("\nFORGERY: a receipt signed by key B does not verify under key A");
{
  const a = issueIdentity(), b = issueIdentity();
  const sigB = signReceipt(RECEIPT, b.privateKey);
  checkTrue("verifies under B", verifyReceipt(RECEIPT, sigB, b.publicKey));
  check("does NOT verify under A", verifyReceipt(RECEIPT, sigB, a.publicKey), false);
}

console.log("\nTAMPER: changing ANY receipt field fails verify");
{
  const { publicKey, privateKey } = issueIdentity();
  const sig = signReceipt(RECEIPT, privateKey);
  for (const [field, val] of [["segmentId", "seg-9999"], ["bytes", 262145], ["senderPeerId", "peer-EVIL"], ["receiverPeerId", "peer-EVIL"]]) {
    check(`tampering ${field} fails`, verifyReceipt({ ...RECEIPT, [field]: val }, sig, publicKey), false);
  }
  // bytes is the payout-relevant field — inflating it must not verify.
  check("inflating bytes 10x fails", verifyReceipt({ ...RECEIPT, bytes: RECEIPT.bytes * 10 }, sig, publicKey), false);
}

console.log("\nSHAPE: a non-receipt is not signable and not verifiable");
{
  const { publicKey, privateKey } = issueIdentity();
  // Missing a field.
  check("missing receiverPeerId -> not signable (null)", signReceipt({ segmentId: "s", bytes: 1, senderPeerId: "a" }, privateKey), null);
  // Extra field (would ride along).
  check("extra field -> not signable (null)", signReceipt({ ...RECEIPT, extra: 1 }, privateKey), null);
  // Wrong types.
  check("string bytes -> not signable", signReceipt({ ...RECEIPT, bytes: "262144" }, privateKey), null);
  check("zero/negative bytes -> not signable", signReceipt({ ...RECEIPT, bytes: 0 }, privateKey), null);
  check("empty segmentId -> not signable", signReceipt({ ...RECEIPT, segmentId: "" }, privateKey), null);
  check("array -> not signable", signReceipt([1, 2, 3, 4], privateKey), null);
  // A validly-signed generic REPORT must not verify as a receipt (shape guard on the verify side).
  const sig = signReceipt(RECEIPT, privateKey);
  check("a shape-invalid object never verifies even with a real sig",
    verifyReceipt({ segmentId: "s", bytes: 1, senderPeerId: "a" }, sig, publicKey), false);
}

console.log("\nmalformed sig/key inputs return false, never throw");
{
  const { publicKey } = issueIdentity();
  check("empty sig -> false", verifyReceipt(RECEIPT, "", publicKey), false);
  check("garbage sig -> false", verifyReceipt(RECEIPT, "!!!", publicKey), false);
  check("sig + junk (malleability) -> false", verifyReceipt(RECEIPT, signReceipt(RECEIPT, issueIdentity().privateKey) + "AA", publicKey), false);
  check("empty key -> false", verifyReceipt(RECEIPT, "x", ""), false);
  check("sign with bad key -> null", signReceipt(RECEIPT, "not-a-key"), null);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
