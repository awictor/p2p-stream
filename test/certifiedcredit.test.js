#!/usr/bin/env node
/**
 * certifiedcredit.test.js — metrics counts CERTIFIED credit only for a TRACKER-ISSUED pubKey
 * (P2P-0070, iter 97).
 *
 * P2P-0069 made credit "signed" (key possession proven). That does NOT distinguish one real peer
 * from N self-minted keys, so signed credit alone cannot close COLLUSION. P2P-0070 adds a stricter
 * tier: the tracker signs a peer's pubKey (a cert), and metrics counts `certifiedAttestedBytes` only
 * when the report carries a cert that verifies under the tracker's public key. A self-minted key has
 * no such cert, so it can be signed but never certified.
 *
 * THREAT (HARD RULE 6): certification binds a key to a tracker-vouched announce. It does NOT stop a
 * determined attacker who drives N real browsers from getting N certs — that needs rate/PoW at
 * issuance (a later step). It moves a sybil from FREE to one tracker round-trip per identity and
 * lets the server REJECT keys it never issued. LIVE issuance at WS-announce is P2P-0071; this
 * iteration builds + gates the ENFORCEMENT, configured via the TRACKER_PUBKEY env.
 *
 * Sets TRACKER_PUBKEY before importing metrics (read at startMetrics time).
 *
 * Usage: node test/certifiedcredit.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReport, issueCert } from "../server/identity.js";

// The tracker's keypair. Metrics is configured with only its PUBLIC key (it never holds the private
// key). Set the env BEFORE importing metrics so startMetrics picks it up.
const tracker = issueIdentity();
process.env.TRACKER_PUBKEY = tracker.publicKey;

const { startMetrics } = await import("../server/metrics.js");

const PORT = Number(process.env.CERTIFIEDCREDIT_TEST_PORT || 8171);
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

  const rx = issueIdentity();                       // the receiver/attester identity
  const cert = issueCert(rx.publicKey, tracker.privateKey); // tracker issued it

  console.log("trackerCertRequired is advertised when TRACKER_PUBKEY is set");
  {
    const s = await stats();
    check("trackerCertRequired true", s.trackerCertRequired, true);
    checkTrue("certifiedAttestedBytes field exists", typeof s.certifiedAttestedBytes === "number");
  }

  console.log("\na tracker-CERTIFIED attestation earns certified credit");
  {
    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    const sig = signReport({ clientId: "rcv", attest }, rx.privateKey);
    await post({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig, cert });
    const s = await stats();
    check("signed credit counts", s.signedAttestedBytes, 4_000_000);
    check("certified credit counts (tracker-issued key)", s.certifiedAttestedBytes, 4_000_000);
  }

  console.log("\nTHE COLLUSION GUARD: a self-minted key is signed but NOT certified");
  {
    const p2 = 8172;
    const s2srv = startMetrics(p2, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post2 = (b) => fetch(`http://localhost:${p2}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post2({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    // A self-minted identity the tracker never issued: valid self-signature, NO cert.
    const evil = issueIdentity();
    const sig = signReport({ clientId: "rcv", attest }, evil.privateKey);
    await post2({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: evil.publicKey, sig }); // no cert
    let s = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    check("self-minted key IS signed (possession proven)", s.signedAttestedBytes, 4_000_000);
    check("but earns 0 certified credit (tracker never issued it)", s.certifiedAttestedBytes, 0);

    // Even WITH a self-signed cert (evil signs its own key), certification fails — it is not the
    // tracker's signature.
    const selfCert = issueCert(evil.publicKey, evil.privateKey);
    await post2({ clientId: "rcv2", peerId: "peer-rcv2", attest: { "peer-srv": 9_000_000 }, pubKey: evil.publicKey, sig: signReport({ clientId: "rcv2", attest: { "peer-srv": 9_000_000 } }, evil.privateKey), cert: selfCert });
    s = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    check("a self-signed cert earns 0 certified credit", s.certifiedAttestedBytes, 0);
    await new Promise((r) => s2srv.close(r));
  }

  console.log("\na cert for a DIFFERENT key does not certify this key");
  {
    const p3 = 8173;
    const s3 = startMetrics(p3, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post3 = (b) => fetch(`http://localhost:${p3}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post3({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    // rx signs, but presents a cert issued for a DIFFERENT tracker-issued key.
    const otherKey = issueIdentity();
    const certForOther = issueCert(otherKey.publicKey, tracker.privateKey);
    const sig = signReport({ clientId: "rcv", attest }, rx.privateKey);
    await post3({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig, cert: certForOther });
    const s = await fetch(`http://localhost:${p3}/stats`).then((r) => r.json());
    check("signed still counts", s.signedAttestedBytes, 4_000_000);
    check("but a mismatched cert earns 0 certified", s.certifiedAttestedBytes, 0);
    await new Promise((r) => s3.close(r));
  }

  console.log("\ncertified status does NOT persist: an uncertified update drops certified credit (iter 100)");
  {
    // Same class as the iter-96 signed-flag guard: attestations.set REPLACES per clientId, so the
    // latest report governs. A peer that presents a cert once then drops it (or an attacker strips
    // the cert) must NOT keep certified credit from a stale flag.
    const p4 = 8174;
    const s4 = startMetrics(p4, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post4 = (b) => fetch(`http://localhost:${p4}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post4({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    await post4({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: rx.publicKey, sig: signReport({ clientId: "rcv", attest }, rx.privateKey), cert });
    let s = await fetch(`http://localhost:${p4}/stats`).then((r) => r.json());
    check("certified after the certified report", s.certifiedAttestedBytes, 4_000_000);
    // Uncertified update (same signed key, NO cert): certified must reset to 0, signed follows latest.
    const attest2 = { "peer-srv": 9_000_000 };
    await post4({ clientId: "rcv", peerId: "peer-rcv", attest: attest2, pubKey: rx.publicKey, sig: signReport({ clientId: "rcv", attest: attest2 }, rx.privateKey) });
    s = await fetch(`http://localhost:${p4}/stats`).then((r) => r.json());
    check("an uncertified update DROPS certified credit to 0 (no sticky certified flag)", s.certifiedAttestedBytes, 0);
    check("...while signed follows the latest report", s.signedAttestedBytes, 9_000_000);
    await new Promise((r) => s4.close(r));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
