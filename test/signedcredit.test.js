#!/usr/bin/env node
/**
 * signedcredit.test.js — /metrics counts SIGNED attested credit only when the signature verifies
 * (P2P-0069, iter 95).
 *
 * The reward tier is unpayable while upload credit rests on a free `prefix + Math.random()` peerId.
 * This wires the ed25519 identity core (P2P-0068) into the attest path: a report may carry
 * pubKey + sig over its canonical {clientId, attest}; only a verifying signature makes its credit
 * eligible for the `signedAttestedBytes` figure a payable tier would use. Unsigned/forged reports
 * still count toward the legacy attestedUploadBytes cross-check (backward compatible) and still move
 * offloadRatio — they just earn ZERO signed credit.
 *
 * THREAT (HARD RULE 6): this authenticates that the KEY HOLDER produced these bytes. It does NOT
 * prove the key is a distinct tracker-vouched peer (P2P-0070), so it does NOT close collusion.
 *
 * Usage: node test/signedcredit.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";
import { issueIdentity, signReport } from "../server/identity.js";

const PORT = Number(process.env.SIGNEDCREDIT_TEST_PORT || 8161);
const BASE = `http://localhost:${PORT}`;

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

const post = (body) =>
  fetch(`${BASE}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

let clock = 1_700_000_000_000;

(async () => {
  const server = startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400));

  // Two viewers: a server (relays) and a receiver (attests it received). The receiver signs its
  // attestation. Map the served peerId to the server client so credit attributes.
  const rx = issueIdentity();

  console.log("a correctly-signed attestation earns SIGNED credit");
  {
    // srv announces its peerId; rcv attests srv served it, and SIGNS the {clientId, attest}.
    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    const sig = signReport({ clientId: "rcv", attest }, rx.privateKey);
    await post({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig });
    const s = await stats();
    check("attestedUploadBytes counts the credit", s.attestedByClient.srv, 4_000_000);
    check("signedAttestedBytes equals it (the report was signed)", s.signedAttestedBytes, 4_000_000);
    checkTrue("signedAttestedBytes field exists", typeof s.signedAttestedBytes === "number");
  }

  console.log("\nthe SAME attestation with NO signature earns 0 signed credit (but still cross-checks)");
  {
    const p2 = 8162;
    const s2 = startMetrics(p2, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post2 = (b) => fetch(`http://localhost:${p2}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post2({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    await post2({ clientId: "rcv", peerId: "peer-rcv", attest: { "peer-srv": 4_000_000 } }); // NO sig
    const s = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    check("unsigned still counts toward the raw cross-check", s.attestedByClient.srv, 4_000_000);
    check("but signedAttestedBytes is 0", s.signedAttestedBytes, 0);
    checkTrue("attestedUploadBytes > signedAttestedBytes (the gap is the unauthenticated credit)",
      s.attestedUploadBytes > s.signedAttestedBytes);
    await new Promise((r) => s2.close(r));
  }

  console.log("\nTHE FORGERY CASE: a signature from a DIFFERENT key earns 0 signed credit");
  {
    const p3 = 8163;
    const s3 = startMetrics(p3, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post3 = (b) => fetch(`http://localhost:${p3}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post3({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    const attacker = issueIdentity();
    // Sign with attacker's key but PRESENT rx's public key — verify must fail.
    const forgedSig = signReport({ clientId: "rcv", attest }, attacker.privateKey);
    await post3({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig: forgedSig });
    const s = await fetch(`http://localhost:${p3}/stats`).then((r) => r.json());
    check("forged sig earns 0 signed credit", s.signedAttestedBytes, 0);
    check("...but the raw cross-check still sees the bytes", s.attestedByClient.srv, 4_000_000);

    // And a sig over DIFFERENT attest content (tamper) also fails.
    const sigOverOther = signReport({ clientId: "rcv", attest: { "peer-srv": 1 } }, rx.privateKey);
    await post3({ clientId: "rcv2", peerId: "peer-rcv2", attest: { "peer-srv": 9_000_000 }, pubKey: rx.publicKey, sig: sigOverOther });
    const s2 = await fetch(`http://localhost:${p3}/stats`).then((r) => r.json());
    check("a sig over different content earns no signed credit for the inflated attest",
      s2.signedAttestedBytes, 0);
    await new Promise((r) => s3.close(r));
  }

  console.log("\nthe signature is BOUND to clientId — a valid sig replayed under another clientId fails (iter 96)");
  {
    const p4 = 8164;
    const s4 = startMetrics(p4, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post4 = (b) => fetch(`http://localhost:${p4}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post4({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    // rcv signs {clientId:"rcv", attest}. An attacker REPLAYS that sig under clientId "evil".
    const rcvSig = signReport({ clientId: "rcv", attest }, rx.privateKey);
    await post4({ clientId: "evil", peerId: "peer-evil", attest, pubKey: rx.publicKey, sig: rcvSig });
    const s = await fetch(`http://localhost:${p4}/stats`).then((r) => r.json());
    check("a sig bound to clientId 'rcv' earns 0 signed credit when POSTed as 'evil'", s.signedAttestedBytes, 0);
    await new Promise((r) => s4.close(r));
  }

  console.log("\nsigned status does NOT persist: an UNSIGNED update after a signed report drops signed credit (iter 96)");
  {
    const p5 = 8165;
    const s5 = startMetrics(p5, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post5 = (b) => fetch(`http://localhost:${p5}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post5({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    const sig = signReport({ clientId: "rcv", attest }, rx.privateKey);
    await post5({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig });
    let s = await fetch(`http://localhost:${p5}/stats`).then((r) => r.json());
    check("signed after the signed report", s.signedAttestedBytes, 4_000_000);
    // rcv now sends an UNSIGNED update (a peer that stops signing, or an attacker stripping the sig).
    // The latest snapshot replaces the prior one; a stale signed flag must NOT keep crediting.
    await post5({ clientId: "rcv", peerId: "peer-rcv", attest: { "peer-srv": 9_000_000 } });
    s = await fetch(`http://localhost:${p5}/stats`).then((r) => r.json());
    check("an unsigned update DROPS signed credit to 0 (no sticky signed flag)", s.signedAttestedBytes, 0);
    check("...while the raw cross-check follows the latest report", s.attestedByClient.srv, 9_000_000);
    await new Promise((r) => s5.close(r));
  }

  console.log("\nsigned credit survives eviction monotonically (folded into retired)");
  {
    const before = await stats();
    clock += 15000 * 20 + 1; // > EVICT_MS
    await post({ clientId: "poke", httpBytes: 1 }); // trigger aggregate sweep
    const after = await stats();
    checkTrue("signedAttestedBytes did not drop across eviction", after.signedAttestedBytes >= before.signedAttestedBytes);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
