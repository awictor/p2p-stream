#!/usr/bin/env node
/**
 * receiptedcredit.test.js — metrics counts receiptedBytes only for a verified receipt from a
 * CERTIFIED key (P2P-0073, iter 102).
 *
 * The proof-of-delivery tier, one step above certifiedAttestedBytes: instead of a bulk self-attest,
 * a receiver signs a per-SEGMENT receipt {segmentId, bytes, senderPeerId, receiverPeerId}. Metrics
 * credits receiptedBytes only when the receipt verifies under the report's pubKey AND that key is
 * tracker-certified. A forged/absent/uncertified receipt earns 0 receipted, and attested/signed
 * totals are unaffected (backward compatible).
 *
 * THREAT (HARD RULE 6): a verified receipt proves a receiver corroborated a specific transfer; it
 * does NOT prove the bytes were played (not QoE), and N certified keys can still collude.
 *
 * Sets TRACKER_PUBKEY before importing metrics.
 *
 * Usage: node test/receiptedcredit.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReceipt, issueCert } from "../server/identity.js";

const tracker = issueIdentity();
process.env.TRACKER_PUBKEY = tracker.publicKey;
const { startMetrics } = await import("../server/metrics.js");

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

let clock = 1_700_000_000_000;
let port = 8301;
const servers = [];
async function fresh() {
  const p = port++;
  const s = startMetrics(p, { now: () => clock });
  servers.push(s);
  await new Promise((r) => setTimeout(r, 250));
  const base = `http://localhost:${p}`;
  return {
    post: (b) => fetch(`${base}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }),
    stats: () => fetch(`${base}/stats`).then((r) => r.json()),
  };
}
// A receiver identity certified by the tracker, and a helper to build a signed receipt payload.
const rx = issueIdentity();
const cert = issueCert(rx.publicKey, tracker.privateKey);
function receipt(segmentId, bytes, key = rx.privateKey) {
  const r = { segmentId, bytes, senderPeerId: "peer-srv", receiverPeerId: "peer-rcv" };
  return { ...r, sig: signReceipt(r, key) };
}

(async () => {
  console.log("a certified receiver's verified receipts earn receiptedBytes");
  {
    const { post, stats } = await fresh();
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [receipt("seg-1", 200000), receipt("seg-2", 300000)] });
    const s = await stats();
    check("receiptedBytes = sum of the two verified receipts", s.receiptedBytes, 500000);
    checkTrue("receiptedBytes field exists", typeof s.receiptedBytes === "number");
  }

  console.log("\nan UNCERTIFIED key earns 0 receipted (even with valid self-signatures)");
  {
    const { post, stats } = await fresh();
    const evil = issueIdentity(); // never certified by the tracker
    const r = { segmentId: "seg-1", bytes: 200000, senderPeerId: "peer-srv", receiverPeerId: "peer-rcv" };
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: evil.publicKey, /* no cert */
      receipts: [{ ...r, sig: signReceipt(r, evil.privateKey) }] });
    const s = await stats();
    check("uncertified receipts earn 0 receipted", s.receiptedBytes, 0);
  }

  console.log("\na FORGED receipt (sig from another key) earns 0 receipted");
  {
    const { post, stats } = await fresh();
    const other = issueIdentity();
    const r = { segmentId: "seg-1", bytes: 200000, senderPeerId: "peer-srv", receiverPeerId: "peer-rcv" };
    // Certified key rx presented, but the receipt is signed by `other`.
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [{ ...r, sig: signReceipt(r, other.privateKey) }] });
    const s = await stats();
    check("forged-sig receipt earns 0 receipted", s.receiptedBytes, 0);
  }

  console.log("\na TAMPERED receipt (bytes inflated after signing) earns 0 receipted");
  {
    const { post, stats } = await fresh();
    const rec = receipt("seg-1", 200000);
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [{ ...rec, bytes: 9_000_000 }] }); // sig is over 200000, bytes now 9e6
    const s = await stats();
    check("tampered-bytes receipt earns 0 receipted", s.receiptedBytes, 0);
  }

  console.log("\nreceipts do NOT disturb attested/signed totals (backward compatible)");
  {
    const { post, stats } = await fresh();
    // A plain attest + a receipt in the same report.
    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      attest: { "peer-srv": 4_000_000 }, receipts: [receipt("seg-1", 200000)] });
    const s = await stats();
    check("attested cross-check still sees the attest bytes", s.attestedByClient.srv, 4_000_000);
    check("receiptedBytes is independent of attest", s.receiptedBytes, 200000);
  }

  console.log("\nSELF-RECEIPT: sender==receiver earns 0 (receipt analog of self-attestation, iter 104)");
  {
    const { post, stats } = await fresh();
    // A certified peer signs a receipt where it served ITSELF — a peer minting credit for nobody.
    const r = { segmentId: "seg-self", bytes: 500000, senderPeerId: "peer-me", receiverPeerId: "peer-me" };
    await post({ clientId: "me", peerId: "peer-me", pubKey: rx.publicKey, cert,
      receipts: [{ ...r, sig: signReceipt(r, rx.privateKey) }] });
    const s = await stats();
    check("self-receipt (sender==receiver) earns 0 receipted", s.receiptedBytes, 0);
    // A DISTINCT sender/receiver on the same certified key still earns — confirms the guard is the
    // self-equality, not the key.
    const { post: p2, stats: s2 } = await fresh();
    const r2 = { segmentId: "seg-x", bytes: 500000, senderPeerId: "peer-A", receiverPeerId: "peer-B" };
    await p2({ clientId: "rcv", peerId: "peer-B", pubKey: rx.publicKey, cert, receipts: [{ ...r2, sig: signReceipt(r2, rx.privateKey) }] });
    check("distinct sender/receiver still earns", (await s2()).receiptedBytes, 500000);
  }

  console.log("\ndedup: the same segmentId listed twice counts once");
  {
    const { post, stats } = await fresh();
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [receipt("seg-dup", 200000), receipt("seg-dup", 200000)] });
    const s = await stats();
    check("duplicate segmentId credited once", s.receiptedBytes, 200000);
  }

  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
