#!/usr/bin/env node
/**
 * entitlementpolicystats.test.js — /stats exposes the TIERED entitlement policy + earned seconds
 * computed by applyPolicy (P2P-0096, iter 175).
 *
 * P2P-0095 made applyPolicy pure; this wires it into the metrics server: ENTITLEMENT_POLICY (JSON)
 * resolves at boot, /stats echoes it as `entitlementPolicy`, and entitlementSeconds is applyPolicy
 * over each client's receiptedBytes (not the flat earnedEntitlement). Still OWED, never PAID.
 *
 * Sets TRACKER_PUBKEY + a 2-tier ENTITLEMENT_POLICY before importing metrics, then proves /stats'
 * earned seconds equal applyPolicy for that policy — a hardcoded number would drift from applyPolicy.
 *
 * Usage: node test/entitlementpolicystats.test.js     (exit 0 = pass, 1 = fail)
 */
import { issueIdentity, signReceipt, issueCert } from "../server/identity.js";
import { applyPolicy } from "../server/entitlement.js";

const tracker = issueIdentity();
process.env.TRACKER_PUBKEY = tracker.publicKey;
// 2-tier marginal policy: first 10MB @1MB/s (1s per MB), above @2MB/s (0.5s per MB).
const POLICY = { tiers: [
  { uptoBytes: 10_000_000, bytesPerSecond: 1_000_000 },
  { bytesPerSecond: 2_000_000 },
] };
process.env.ENTITLEMENT_POLICY = JSON.stringify(POLICY);
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}

let clock = 1_700_000_000_000;
let port = 8321;
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
  console.log("/stats echoes the resolved tiered policy");
  {
    const { stats } = await fresh();
    const s = await stats();
    checkTrue("entitlementPolicy present with tiers", Array.isArray(s.entitlementPolicy?.tiers) && s.entitlementPolicy.tiers.length === 2,
      `got ${JSON.stringify(s.entitlementPolicy)}`);
    check("tier-1 rate echoed", s.entitlementPolicy.tiers[0].bytesPerSecond, 1_000_000);
  }

  console.log("\nearned seconds on /stats == applyPolicy over receiptedBytes (marginal, not flat)");
  {
    const { post, stats } = await fresh();
    // 14MB receipted: applyPolicy = 10s (first 10MB @1MB/s) + 2s (4MB @2MB/s) = 12s. Flat @1MB/s would be 14.
    await post({ clientId: "rcv", peerId: "peer-rcv", pubKey: rx.publicKey, cert,
      receipts: [receipt("s1", 8_000_000), receipt("s2", 6_000_000)] });
    const s = await stats();
    const expected = applyPolicy(14_000_000, POLICY);
    check("applyPolicy(14MB) is the marginal 12s", expected, 12);
    check("entitlementByClient['rcv'] matches applyPolicy", s.entitlementByClient.rcv, expected);
    check("entitlementSeconds total matches applyPolicy", s.entitlementSeconds, expected);
    // Guard against a regression to the flat rate: 12 != 14.
    checkTrue("NOT the flat-rate 14 (proves tiered path is live)", s.entitlementSeconds !== 14);
  }

  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  delete process.env.TRACKER_PUBKEY;
  delete process.env.ENTITLEMENT_POLICY;
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
