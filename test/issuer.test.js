#!/usr/bin/env node
/**
 * issuer.test.js — LIVE cert issuance end to end: issuer -> metrics (P2P-0071, iter 98).
 *
 * P2P-0070 built the metrics ENFORCEMENT (certifiedAttestedBytes counts only tracker-issued keys).
 * This wires the LIVE issuer: the tracker holds an ed25519 identity and hands each peer a cert over
 * its pubKey via POST /issue. The metrics server is configured with only the tracker's PUBLIC key.
 * A viewer that (1) gets a cert from the issuer and (2) attaches it to a signed attestation earns
 * certified credit — without any hardcoded cert in this test; the cert is minted at runtime.
 *
 * THREAT (HARD RULE 6): issuance binds a key to an issuance event and lets metrics reject un-issued
 * keys. There is NO rate limit / PoW at /issue, so N browsers => N certs. Certified != distinct
 * human. Browser-side SubtleCrypto keygen/sign is a manual-qa box; this covers the server path.
 *
 * Usage: node test/issuer.test.js     (exit 0 = pass, 1 = fail)
 */
import { startIssuer, issueTrackerCert, loadTrackerIdentity } from "../server/tracker.js";
import { issueIdentity, signReport, verifyCert, solvePow } from "../server/identity.js";

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

const servers = [];
let clock = 1_700_000_000_000;

(async () => {
  console.log("loadTrackerIdentity: env pair honoured, else generated");
  {
    const fixed = issueIdentity();
    const fromEnv = loadTrackerIdentity({ TRACKER_PRIVKEY: fixed.privateKey, TRACKER_PUBKEY: fixed.publicKey });
    check("uses the env keypair when both set", fromEnv.publicKey, fixed.publicKey);
    check("...and marks it not-generated", fromEnv.generated, false);
    const gen = loadTrackerIdentity({});
    checkTrue("generates a keypair when env is absent", typeof gen.publicKey === "string" && gen.generated === true);
  }

  console.log("\nissueTrackerCert is a verifiable cert over the submitted pubKey");
  {
    const id = loadTrackerIdentity({});
    const peer = issueIdentity();
    const cert = issueTrackerCert(peer.publicKey, id);
    checkTrue("cert verifies under the tracker public key", verifyCert(peer.publicKey, cert, id.publicKey));
    check("a cert for peer A does not verify for peer B", verifyCert(issueIdentity().publicKey, cert, id.publicKey), false);
    check("bad input -> null", issueTrackerCert("", id), null);
  }

  console.log("\nthe /issue HTTP endpoint mints a live, verifiable cert");
  const identity = loadTrackerIdentity({});
  const IPORT = 8202;
  const issuer = startIssuer(IPORT, identity);
  servers.push(issuer);
  await new Promise((r) => setTimeout(r, 300));
  const peer = issueIdentity();
  let liveCert;
  {
    // GET /pubkey exposes the key an operator sets as metrics' TRACKER_PUBKEY.
    const pk = await fetch(`http://localhost:${IPORT}/pubkey`).then((r) => r.json());
    check("GET /pubkey returns the tracker public key", pk.trackerPubKey, identity.publicKey);
    // POST /issue mints a cert for a submitted pubKey.
    const res = await fetch(`http://localhost:${IPORT}/issue`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubKey: peer.publicKey }),
    });
    const body = await res.json();
    liveCert = body.cert;
    checkTrue("POST /issue returns a cert", typeof liveCert === "string" && liveCert.length > 0);
    checkTrue("the minted cert verifies under the tracker key (not hardcoded)",
      verifyCert(peer.publicKey, liveCert, identity.publicKey));
    // Malformed POST -> 400, not a crash.
    const bad = await fetch(`http://localhost:${IPORT}/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    check("malformed /issue body -> 400", bad.status, 400);
  }

  console.log("\nEND TO END: issuer-minted cert earns CERTIFIED credit at metrics");
  {
    // Configure metrics with the tracker's public key (as an operator would from GET /pubkey).
    // startMetrics reads TRACKER_PUBKEY at CALL time, so setting it before startMetrics() suffices.
    process.env.TRACKER_PUBKEY = identity.publicKey;
    const { startMetrics } = await import("../server/metrics.js");
    const MPORT = 8203;
    const metrics = startMetrics(MPORT, { now: () => clock });
    servers.push(metrics);
    await new Promise((r) => setTimeout(r, 300));
    const post = (b) => fetch(`http://localhost:${MPORT}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 5e6 });
    const attest = { "peer-srv": 4_000_000 };
    // The viewer signs with ITS key and attaches the issuer-minted cert.
    const sig = signReport({ clientId: "rcv", attest }, peer.privateKey);
    await post({ clientId: "rcv", peerId: "peer-rcv", attest, pubKey: peer.publicKey, sig, cert: liveCert });
    const s = await fetch(`http://localhost:${MPORT}/stats`).then((r) => r.json());
    check("signed credit counts", s.signedAttestedBytes, 4_000_000);
    check("certified credit counts — full issuer->metrics chain, no hardcoded cert", s.certifiedAttestedBytes, 4_000_000);
  }

  console.log("\nPoW-GATED issuance (P2P-0079): bits>0 needs a solved challenge");
  {
    // A separate issuer with PoW ON (bits passed explicitly, independent of the env default).
    const powId = loadTrackerIdentity({});
    const PPORT = 8204;
    const POW_BITS = 12; // small enough to solve in <1s, big enough that a wrong nonce fails
    const powIssuer = startIssuer(PPORT, powId, POW_BITS);
    servers.push(powIssuer);
    await new Promise((r) => setTimeout(r, 300));
    const peerP = issueIdentity();
    const base = `http://localhost:${PPORT}`;
    const postIssue = (b) => fetch(`${base}/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

    // GET /issue/challenge advertises the difficulty and hands out a challenge.
    const ch = await fetch(`${base}/issue/challenge`).then((r) => r.json());
    check("challenge endpoint reports the difficulty", ch.bits, POW_BITS);
    checkTrue("challenge endpoint returns a challenge string", typeof ch.challenge === "string" && ch.challenge.length > 0);

    // POST /issue WITHOUT a proof is rejected 400, no cert.
    const noProof = await postIssue({ pubKey: peerP.publicKey });
    check("POST /issue without a proof -> 400", noProof.status, 400);
    checkTrue("...and no cert in the body", (await noProof.json()).cert === undefined);

    // POST /issue WITH a solved nonce mints a verifiable cert.
    const nonce = solvePow(ch.challenge, POW_BITS);
    const withProof = await postIssue({ pubKey: peerP.publicKey, challenge: ch.challenge, nonce });
    check("POST /issue with a valid proof -> 200", withProof.status, 200);
    checkTrue("...mints a cert that verifies", verifyCert(peerP.publicKey, (await withProof.json()).cert, powId.publicKey));

    // REPLAY: the same solved challenge cannot mint a SECOND cert (single-use).
    const replay = await postIssue({ pubKey: peerP.publicKey, challenge: ch.challenge, nonce });
    check("a consumed challenge is single-use (replay -> 400)", replay.status, 400);

    // A challenge we never issued is not honoured even with a 'valid' nonce for it.
    const forged = "deadbeefdeadbeefdeadbeefdeadbeef";
    const forgedNonce = solvePow(forged, POW_BITS);
    const unknown = await postIssue({ pubKey: peerP.publicKey, challenge: forged, nonce: forgedNonce });
    check("an unknown (never-issued) challenge -> 400", unknown.status, 400);
  }

  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
