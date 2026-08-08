#!/usr/bin/env node
/**
 * sybil.test.js — ATTACK our own forgery detector, and prove it is blind.
 *
 * This test asserts that a tool we shipped FAILS. That is deliberate. Iter 39 added receiver
 * attestation (peers report what OTHERS served them, so a peer inflating its own uploadBytes earns
 * no credit) and iter 41 added a detector that flags any viewer whose claim exceeds what receivers
 * confirm. Both work against a LONE liar. Neither works against a ring.
 *
 * The reason is in the vendored engine: a peerId is
 *     prefix + Math.random()-derived characters        (`function Rr(e)` in p2pml-hlsjs.iife.min.js)
 * with no proof of work, possession, or uniqueness behind it, and the peerId -> clientId mapping is
 * self-declared by the client. So identities are FREE. N browser tabs can mint N identities and
 * attest for each other, producing perfect mutual corroboration and a clean ~1.0 ratio.
 *
 * Why this is measurable here despite everything else being loopback: a sybil attack is BY
 * DEFINITION one machine presenting many identities. The two-machine gap limits claims about
 * offload over real networks; it does not limit a demonstration that identity is free.
 *
 * The attack runs against a REAL metrics server over HTTP — the same endpoint a browser posts to —
 * and is judged by the REAL detector imported from the harness. Nothing is simulated.
 *
 * Usage: node test/sybil.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";
import { forgerySignals } from "./verify-offload.js";

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

const MB = 1e6;
const PORT = Number(process.env.SYBIL_TEST_PORT || 8131);
const BASE = `http://localhost:${PORT}`;

const srv1 = startMetrics(PORT);
await new Promise((r) => setTimeout(r, 400));

const post = (body) => fetch(`${BASE}/metrics`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

console.log("baseline: a LONE liar IS caught (what attestation does defend against):");
{
  // One peer claims 100MB; nobody attests for it. This is the case the detector was built for.
  // The "honest" pair must ACTUALLY corroborate each other, or it is just a second lone liar —
  // my first version had `honest` claiming 10MB while attesting for a non-existent partner, so
  // it was flagged too, correctly. A baseline has to be genuinely honest to mean anything.
  await post({ clientId: "liar", peerId: "p-liar", uploadBytes: 100 * MB });
  await post({ clientId: "hA", peerId: "p-hA", uploadBytes: 10 * MB, p2pBytes: 10 * MB,
    attest: { "p-hB": 10 * MB } });
  await post({ clientId: "hB", peerId: "p-hB", uploadBytes: 10 * MB, p2pBytes: 10 * MB,
    attest: { "p-hA": 10 * MB } });
  const s = await stats();
  const sig = forgerySignals(s.uploadByClient, s.attestedByClient);
  const liar = sig.rows.find((r) => r.id === "liar");
  checkTrue("the lone liar is flagged", liar.overClaim);
  check("and is the only suspect", sig.suspects.length, 1);
  check("with zero attested credit", liar.attested, 0);
  checkTrue("the mutually-corroborating pair is clean", sig.rows
    .filter((r) => r.id === "hA" || r.id === "hB").every((r) => !r.overClaim));
  // Note what that pair actually is: a 2-member ring. There is NO signal distinguishing it from
  // two honest peers who really served each other — the data is identical. That is the crux of
  // why this detector cannot be fixed by tuning, only by making identities cost something.
}

console.log("\nTHE ATTACK: a 4-identity ring attesting for each other");
{
  // Fresh server so the lone-liar rows above don't muddy the ring's numbers.
  const p2 = PORT + 1;
  const srv2 = startMetrics(p2);
  await new Promise((r) => setTimeout(r, 400));
  const post2 = (b) => fetch(`http://localhost:${p2}/metrics`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  });
  const stats2 = () => fetch(`http://localhost:${p2}/stats`).then((r) => r.json());

  // Each ring member claims 30MB uploaded and is vouched for by the OTHER three (10MB each).
  // No real bytes need move — every number here is asserted by a colluding party.
  const RING = ["s0", "s1", "s2", "s3"];
  const CLAIM = 30 * MB;
  for (const me of RING) {
    const attest = {};
    for (const other of RING) if (other !== me) attest[`p-${other}`] = 10 * MB;
    await post2({ clientId: me, peerId: `p-${me}`, uploadBytes: CLAIM, p2pBytes: 30 * MB, attest });
  }
  const s = await stats2();
  const sig = forgerySignals(s.uploadByClient, s.attestedByClient);

  check("all 4 identities are tracked", s.tracked, 4);
  check("all 4 are credited by their co-conspirators", Object.keys(s.attestedByClient).length, 4);
  for (const me of RING) {
    // 3 partners x 10MB = 30MB attested against a 30MB claim.
    check(`${me} attested exactly its claim`, s.attestedByClient[me], CLAIM);
  }

  // THE POINT OF THIS FILE. The detector reports a perfectly healthy swarm.
  console.log("\n  => and now the verdict from our OWN detector:");
  check("ZERO suspects — the ring is invisible", sig.suspects.length, 0);
  for (const r of sig.rows) {
    check(`${r.id} ratio is a clean 1.00`, r.ratio, 1);
    checkTrue(`${r.id} is judged (well above the 1MB floor)`, r.judged);
    checkTrue(`${r.id} is NOT flagged`, !r.overClaim);
  }
  // Self-attestation IS still blocked — the ring works precisely because nobody vouches for
  // themselves. That guard is not useless, it just doesn't reach this attack.
  checkTrue("no member vouched for itself", RING.every((me) => {
    return s.attestedByClient[me] === CLAIM;   // 3x10MB from others, not 30MB from self
  }));
  // 120MB of credit conjured from 0 bytes of real relay.
  check("total attested credit conjured", s.attestedUploadBytes, 4 * CLAIM);
  srv2.close();
}

console.log("\nthe attack SCALES: credit is linear in identities, and cheap");
{
  const p3 = PORT + 2;
  const srv3 = startMetrics(p3);
  await new Promise((r) => setTimeout(r, 400));
  const post3 = (b) => fetch(`http://localhost:${p3}/metrics`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  });
  const stats3 = () => fetch(`http://localhost:${p3}/stats`).then((r) => r.json());

  // 10 identities, each claiming 50MB, each vouched by the other 9. Cost: one browser.
  const N = 10, CLAIM = 50 * MB;
  const ring = Array.from({ length: N }, (_, i) => `z${i}`);
  for (const me of ring) {
    const attest = {};
    for (const other of ring) if (other !== me) attest[`p-${other}`] = CLAIM / (N - 1);
    await post3({ clientId: me, peerId: `p-${me}`, uploadBytes: CLAIM, attest });
  }
  const s = await stats3();
  const sig = forgerySignals(s.uploadByClient, s.attestedByClient);
  check("no suspects at N=10 either", sig.suspects.length, 0);
  check("credit scales linearly with identity count", Math.round(s.attestedUploadBytes), N * CLAIM);
  checkTrue("500MB of credit from zero relayed bytes", s.attestedUploadBytes >= 500 * MB);
  // The cost of the attack is what a reward must be priced under: N identities and N POSTs.
  console.log(`  => ${N} identities produced ${(s.attestedUploadBytes / MB).toFixed(0)}MB of attested credit,`);
  console.log(`     from one process, with no video relayed and no suspects raised.`);
  srv3.close();
}

console.log("\nwhat WOULD catch it: requiring K distinct attesters is not enough on its own");
{
  // Documents why P2P-0038's mitigation must ALSO cap per-attester vouching. A ring of K+1
  // members satisfies any "K distinct attesters" rule for free, since every member has K peers.
  const RING = 6, K = 3;
  const attestersPerMember = RING - 1;
  checkTrue(`a ring of ${RING} gives every member ${attestersPerMember} distinct attesters`,
    attestersPerMember >= K,
    "so a bare K-distinct rule is satisfied by making the ring bigger");
}

// Close the last listener or the process never exits and `npm test` stalls forever.
srv1.close();

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
console.log("NOTE: passing this file means the detector IS blind to collusion. That is the finding.");
process.exitCode = failures === 0 ? 0 : 1;
