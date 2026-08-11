#!/usr/bin/env node
/**
 * entitlementstats.test.js — /stats exposes ad-free entitlement per client, from receiptedBytes ONLY
 * (P2P-0075, iter 106).
 *
 * The value-exchange surface: a relaying viewer sees the ad-free seconds it EARNED. Entitlement is
 * computed only from receiptedBytes (per-segment corroborated, certified, non-self) — never from
 * attested/signed/certified-without-receipt, because only receiptedBytes is collusion-resistant
 * enough to owe against. Reports what is OWED, not PAID (no payout rail).
 *
 * THREAT (HARD RULE 6): OWED != PAID; N certified keys can still collude on mutual receipts.
 *
 * Sets TRACKER_PUBKEY + a known policy rate before importing metrics.
 *
 * Usage: node test/entitlementstats.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReceipt, issueCert, signReport } from "../server/identity.js";

const tracker = issueIdentity();
process.env.TRACKER_PUBKEY = tracker.publicKey;
process.env.AD_FREE_BYTES_PER_SECOND = "1000000"; // 1MB per ad-free second
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
let port = 8311;
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
const rx = issueIdentity();
const cert = issueCert(rx.publicKey, tracker.privateKey);
function receipt(segmentId, bytes) {
  const r = { segmentId, bytes, senderPeerId: "peer-A", receiverPeerId: "peer-rcv" };
  return { ...r, sig: signReceipt(r, rx.privateKey) };
}

(async () => {
  console.log("a certified receipted peer earns ad-free entitlement");
  {
    const { post, stats } = await fresh();
    // 5 MB receipted -> 5 ad-free seconds at 1MB/s.
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [receipt("s1", 3_000_000), receipt("s2", 2_000_000)] });
    const s = await stats();
    check("policy rate echoed", s.adFreeBytesPerSecond, 1_000_000);
    check("entitlementByClient['rcv'] = 5 seconds", s.entitlementByClient.rcv, 5);
    check("entitlementSeconds total = 5", s.entitlementSeconds, 5);
  }

  console.log("\nan UNCERTIFIED peer earns 0 entitlement (receiptedBytes gate)");
  {
    const { post, stats } = await fresh();
    const evil = issueIdentity();
    const r = { segmentId: "s1", bytes: 5_000_000, senderPeerId: "peer-A", receiverPeerId: "peer-rcv" };
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: evil.publicKey, /* no cert */
      receipts: [{ ...r, sig: signReceipt(r, evil.privateKey) }] });
    const s = await stats();
    check("no entitlement for an uncertified peer", s.entitlementSeconds, 0);
    checkTrue("entitlementByClient is empty", Object.keys(s.entitlementByClient).length === 0);
  }

  console.log("\nattested/signed WITHOUT receipts earns 0 entitlement (not fed from attested)");
  {
    const { post, stats } = await fresh();
    // A big signed attestation but NO receipts. Entitlement must ignore it.
    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 50e6 });
    const attest = { "peer-srv": 40_000_000 };
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      attest, sig: signReport({ clientId: "rcv", attest }, rx.privateKey) });
    const s = await stats();
    checkTrue("attested credit exists", s.attestedByClient.srv === 40_000_000);
    check("but entitlement is 0 (only receiptedBytes feeds it)", s.entitlementSeconds, 0);
  }

  console.log("\nsub-rate receipts round to 0 entitlement but still count as receiptedBytes");
  {
    const { post, stats } = await fresh();
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [receipt("s1", 500_000)] }); // < 1MB -> 0 seconds
    const s = await stats();
    check("receiptedBytes counts the 500KB", s.receiptedBytes, 500_000);
    check("but entitlement floors to 0", s.entitlementSeconds, 0);
  }

  console.log("\nentitlementSeconds == sum(entitlementByClient), and multi-peer attributes correctly (iter 108)");
  {
    // Two distinct certified receivers. The total must equal the sum of the per-client parts — a
    // dashboard/payout reading either must never disagree with the other.
    const { post, stats } = await fresh();
    const rxB = issueIdentity();
    const certB = issueCert(rxB.publicKey, tracker.privateKey);
    const mkFor = (priv, seg, bytes, receiver) => {
      const r = { segmentId: seg, bytes, senderPeerId: "peer-A", receiverPeerId: receiver };
      return { ...r, sig: signReceipt(r, priv) };
    };
    await post({ clientId: "rcvA", peerId: "peer-rcvA", pubKey: rx.publicKey, cert, receipts: [mkFor(rx.privateKey, "a1", 3_000_000, "peer-rcvA")] });
    await post({ clientId: "rcvB", peerId: "peer-rcvB", pubKey: rxB.publicKey, cert: certB, receipts: [mkFor(rxB.privateKey, "b1", 2_000_000, "peer-rcvB")] });
    const s = await stats();
    check("rcvA earns 3s", s.entitlementByClient.rcvA, 3);
    check("rcvB earns 2s", s.entitlementByClient.rcvB, 2);
    check("total == sum of parts", s.entitlementSeconds, Object.values(s.entitlementByClient).reduce((a, b) => a + b, 0));
    check("...and equals 5", s.entitlementSeconds, 5);
  }

  console.log("\nentitlement is a LIVE snapshot: stale receipts drop it, receiptedBytes stays (iter 108)");
  {
    // Distinct clock so eviction is deterministic. After EVICT the peer's receipts fold into the
    // retired receiptedBytes TOTAL (monotonic) but it can no longer be shown an entitlement — it is
    // gone. This is the documented cumulative-total vs live-snapshot distinction; pin it so a
    // refactor that made entitlement cumulative (double-crediting a returning peer) is caught.
    let clk = 1_700_000_000_000;
    const p = 8318;
    const srv = startMetrics(p, { now: () => clk });
    servers.push(srv);
    await new Promise((r) => setTimeout(r, 250));
    const post = (b) => fetch(`http://localhost:${p}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const st = () => fetch(`http://localhost:${p}/stats`).then((r) => r.json());
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert, receipts: [receipt("s1", 5_000_000)] });
    let s = await st();
    check("live entitlement is 5", s.entitlementSeconds, 5);
    clk += 15000 * 20 + 1; // > EVICT_MS
    await post({ clientId: "poke", httpBytes: 1 }); // trigger the aggregate sweep
    s = await st();
    check("after eviction entitlement drops to 0 (departed peer, no phantom)", s.entitlementSeconds, 0);
    checkTrue("but receiptedBytes stays (retired total is monotonic)", s.receiptedBytes >= 5_000_000);
  }

  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
