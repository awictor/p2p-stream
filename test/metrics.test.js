#!/usr/bin/env node
/**
 * metrics.test.js — unit test for the offload aggregation in server/metrics.js.
 *
 * This is the arithmetic the entire project's claim rests on, so it gets exact
 * assertions rather than smoke checks. Boots the real Express app on an ephemeral
 * port and drives it over HTTP (no mocks) so the JSON contract is covered too.
 *
 * Usage: node test/metrics.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.METRICS_TEST_PORT || 8123);
const BASE = `http://localhost:${PORT}`;
const STALE_MS = 15000;          // must match server/metrics.js
const EVICT_MS = STALE_MS * 20;  // must match server/metrics.js

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}
function checkClose(name, actual, expected, eps = 1e-9) {
  const ok = Math.abs(actual - expected) < eps;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}
function checkTrue(name, actual) {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : " — got falsy"}`);
}

const post = (body) =>
  fetch(`${BASE}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

// Fixed base timestamp — never Date.now(), so the stale-window maths is deterministic.
const T = 1_700_000_000_000;

// The server stamps recency itself, so staleness is driven by advancing THIS clock
// rather than by the `ts` a client sends. Tests move time explicitly; no sleeping.
let clock = T;
const advance = (ms) => { clock += ms; };

(async () => {
  startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  console.log("empty state:");
  {
    const s = await stats();
    check("viewers is 0", s.viewers, 0);
    check("httpBytes is 0", s.httpBytes, 0);
    check("offloadRatio is 0 (no divide-by-zero)", s.offloadRatio, 0);
  }

  console.log("\nrejects a report with no clientId:");
  {
    const r = await post({ httpBytes: 1, p2pBytes: 1, ts: T });
    check("HTTP 400", r.status, 400);
    const s = await stats();
    check("viewers still 0", s.viewers, 0);
  }

  console.log("\ntwo viewers, 300 http + 1700 p2p => 85% offload:");
  {
    await post({ clientId: "a", httpBytes: 100, p2pBytes: 900, uploadBytes: 50, ts: T });
    await post({ clientId: "b", httpBytes: 200, p2pBytes: 800, uploadBytes: 40, ts: T });
    const s = await stats();
    check("viewers", s.viewers, 2);
    check("httpBytes summed", s.httpBytes, 300);
    check("p2pBytes summed", s.p2pBytes, 1700);
    check("uploadBytes summed", s.uploadBytes, 90);
    checkClose("offloadRatio", s.offloadRatio, 0.85);
  }

  console.log("\nreports are cumulative snapshots, NOT deltas (same id overwrites):");
  {
    await post({ clientId: "a", httpBytes: 150, p2pBytes: 950, uploadBytes: 60, ts: T });
    const s = await stats();
    check("viewers unchanged", s.viewers, 2);
    check("httpBytes replaced not added", s.httpBytes, 350);
    check("p2pBytes replaced not added", s.p2pBytes, 1750);
  }

  console.log("\na viewer that goes silent past STALE_MS leaves the active count, keeps its bytes:");
  {
    // Recency is server-stamped, so age it by advancing the clock — not by sending an old ts.
    await post({ clientId: "c", httpBytes: 10, p2pBytes: 90, uploadBytes: 5 });
    advance(STALE_MS + 1);            // now a, b AND c are all silent past the window
    const s = await stats();
    check("all three now stale", s.viewers, 0);
    check("but httpBytes still counted", s.httpBytes, 360);
    check("and p2pBytes still counted", s.p2pBytes, 1840);
    // A fresh report re-activates the same entry rather than adding a second one.
    await post({ clientId: "a", httpBytes: 150, p2pBytes: 950, uploadBytes: 60 });
    const s2 = await stats();
    check("re-reporting revives that viewer", s2.viewers, 1);
    check("and does not double-count it", s2.httpBytes, 360);
  }

  console.log("\nexactly at the stale boundary is still active (<= not <):");
  {
    await post({ clientId: "d", httpBytes: 0, p2pBytes: 0 });
    advance(STALE_MS);                // exactly on the boundary
    const s = await stats();
    check("boundary viewer still active", s.viewers >= 1, true);
  }

  console.log("\nreport with NO ts is still aged out (regression: P2P-0011):");
  {
    // Before the fix, a missing ts gave lastSeen=0 and the `c.lastSeen &&` guards
    // short-circuited on that falsy zero, so this client was never stale and never
    // evicted — a permanent active viewer and a permanent leak.
    await post({ clientId: "no-ts", httpBytes: 1, p2pBytes: 1 });
    const fresh = await stats();
    check("counted active right after reporting", fresh.viewers >= 1, true);
    advance(STALE_MS + 1);
    const s = await stats();
    check("no-ts client goes stale like any other", s.viewers, 0);
    advance(EVICT_MS);
    const s2 = await stats();
    check("and is eventually evicted", s2.tracked, 0);
    check("its bytes survived the eviction", s2.httpBytes, s.httpBytes);
  }

  console.log("\nlong-gone viewer is EVICTED from the Map but its bytes survive:");
  {
    // Beyond EVICT_MS the entry must be reclaimed so the Map cannot grow without bound,
    // WITHOUT subtracting bytes it really served — dropping them would make offloadRatio
    // jump backwards and break the sweep's delta arithmetic.
    const before = await stats();
    await post({ clientId: "ancient", httpBytes: 40, p2pBytes: 60, uploadBytes: 7 });
    advance(EVICT_MS + 1);
    const s = await stats();
    check("evicted, so not tracked in the Map", s.tracked, 0);
    check("its httpBytes still in the total", s.httpBytes, before.httpBytes + 40);
    check("its p2pBytes still in the total", s.p2pBytes, before.p2pBytes + 60);
    check("its uploadBytes still in the total", s.uploadBytes, before.uploadBytes + 7);
    check("not counted as an active viewer", s.viewers, 0);
  }

  console.log("\ntotals never move backwards across an eviction:");
  {
    const a1 = await stats();
    for (let i = 0; i < 3; i++) {
      await post({ clientId: `old${i}`, httpBytes: 5, p2pBytes: 5 });
    }
    advance(EVICT_MS + 1);
    const a2 = await stats();
    check("httpBytes monotonic", a2.httpBytes >= a1.httpBytes, true);
    check("p2pBytes monotonic", a2.p2pBytes >= a1.p2pBytes, true);
    check("Map stayed bounded (all 3 evicted)", a2.tracked, 0);
    check("retired count grew by 3", a2.retiredClients, a1.retiredClients + 3);
  }

  console.log("\n100% and 0% offload edges:");
  {
    const p = Number(process.env.METRICS_TEST_PORT2 || 8124);
    startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b2 = `http://localhost:${p}`;
    const post2 = (body) => fetch(`${b2}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await post2({ clientId: "allp2p", httpBytes: 0, p2pBytes: 500, ts: T });
    let s = await fetch(`${b2}/stats`).then((r) => r.json());
    check("all-p2p is 100%", s.offloadRatio, 1);
    await post2({ clientId: "allhttp", httpBytes: 500, p2pBytes: 0, ts: T });
    s = await fetch(`${b2}/stats`).then((r) => r.json());
    checkClose("half and half is 50%", s.offloadRatio, 0.5);
  }

  console.log("\nmalformed numeric fields coerce to 0 instead of NaN-poisoning the totals:");
  {
    const p = Number(process.env.METRICS_TEST_PORT3 || 8125);
    startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b3 = `http://localhost:${p}`;
    await fetch(`${b3}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "bad", httpBytes: "abc", p2pBytes: null, ts: T }),
    });
    await fetch(`${b3}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "good", httpBytes: 100, p2pBytes: 300, ts: T }),
    });
    const s = await fetch(`${b3}/stats`).then((r) => r.json());
    check("httpBytes not NaN", Number.isFinite(s.httpBytes), true);
    check("httpBytes ignores garbage", s.httpBytes, 100);
    checkClose("offloadRatio still correct", s.offloadRatio, 0.75);
  }

  console.log("\nRECEIVER-ATTESTED upload: credit comes from peers, not from self-claims:");
  {
    const p = Number(process.env.METRICS_TEST_PORT4 || 8126);
    startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b = `http://localhost:${p}`;
    const post = (body) => fetch(`${b}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    // Two viewers: A serves, B receives and attests for A.
    await post({ clientId: "A", peerId: "peer-A", uploadBytes: 1000, p2pBytes: 0 });
    await post({ clientId: "B", peerId: "peer-B", p2pBytes: 1000, attest: { "peer-A": 1000 } });
    let s = await fetch(`${b}/stats`).then((r) => r.json());
    check("A is credited from B's report", s.attestedByClient.A, 1000);
    check("attested total matches", s.attestedUploadBytes, 1000);
    check("self-reported upload still reported separately", s.uploadBytes, 1000);
    check("one attesting client", s.attestingClients, 1);

    // THE POINT: a peer inflating its OWN uploadBytes gains no attested credit.
    await post({ clientId: "A", peerId: "peer-A", uploadBytes: 999999999, p2pBytes: 0 });
    s = await fetch(`${b}/stats`).then((r) => r.json());
    check("self-inflation does NOT move attested credit", s.attestedByClient.A, 1000);
    checkTrue("and the gap between the two is now large",
      s.uploadBytes - s.attestedUploadBytes > 1e8);

    // SELF-ATTESTATION must be dropped — that is exactly the forgery being detected.
    await post({ clientId: "A", peerId: "peer-A", uploadBytes: 0, attest: { "peer-A": 500000 } });
    s = await fetch(`${b}/stats`).then((r) => r.json());
    check("a viewer cannot attest for itself", s.attestedByClient.A, 1000);

    // Reports are cumulative snapshots, so a repeat must REPLACE, not accumulate.
    await post({ clientId: "B", peerId: "peer-B", p2pBytes: 1500, attest: { "peer-A": 1500 } });
    s = await fetch(`${b}/stats`).then((r) => r.json());
    check("repeat attestation replaces rather than sums", s.attestedByClient.A, 1500);

    // An unmapped peerId is still counted, but flagged rather than silently attributed.
    await post({ clientId: "C", peerId: "peer-C", p2pBytes: 700, attest: { "peer-ghost": 700 } });
    s = await fetch(`${b}/stats`).then((r) => r.json());
    check("unmapped peer is labelled", s.attestedByClient["unmapped:peer-ghost"], 700);
    check("and included in the total", s.attestedUploadBytes, 2200);

    // Garbage must not poison the totals.
    await post({ clientId: "D", peerId: "peer-D", attest: { "peer-A": "abc", "": 5, "peer-X": -3 } });
    s = await fetch(`${b}/stats`).then((r) => r.json());
    checkTrue("attested total stays finite", Number.isFinite(s.attestedUploadBytes));
    check("garbage attestations ignored", s.attestedUploadBytes, 2200);
  }

  console.log("\nK-of-N attestation filter: meters collusion, reported ALONGSIDE the raw figure:");
  {
    const p = Number(process.env.METRICS_TEST_PORT6 || 8128);
    const srv = startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b = `http://localhost:${p}`;
    const post = (body) => fetch(`${b}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const stats = () => fetch(`${b}/stats`).then((r) => r.json());
    const MB = 1e6;

    // ONE voucher claiming a lot: raw credits it, the filter does NOT (below MIN_ATTESTERS=2).
    await post({ clientId: "solo", peerId: "p-solo", uploadBytes: 30 * MB });
    await post({ clientId: "w1", peerId: "p-w1", attest: { "p-solo": 30 * MB } });
    let s = await stats();
    check("raw credits a single voucher", s.attestedByClient.solo, 30 * MB);
    check("filtered does NOT (needs >= 2 distinct attesters)", s.attestedFilteredByClient.solo, undefined);
    // Assert the REAL key. An earlier line here checked `attestedFilteredTotal` — a name that does
    // not exist — so it "passed" by comparing undefined to undefined and tested nothing.
    check("filtered total excludes it entirely", s.attestedFilteredUploadBytes, 0);
    check("the threshold is reported so a reader knows why", s.minAttesters, 2);

    // A SECOND distinct voucher crosses the threshold — but each is capped at 20MB.
    await post({ clientId: "w2", peerId: "p-w2", attest: { "p-solo": 30 * MB } });
    s = await stats();
    check("raw sums both vouchers", s.attestedByClient.solo, 60 * MB);
    // 2 vouchers x min(30MB, 20MB cap) = 40MB, NOT 60MB.
    check("filtered caps each voucher at 20MB", s.attestedFilteredByClient.solo, 40 * MB);
    checkTrue("so filtered is strictly less than raw", s.attestedFilteredUploadBytes < s.attestedUploadBytes);
    check("the cap is reported too", s.maxVouchPerAttester, 20e6);

    // An honest run keeps MOST of its credit: many receivers, each vouching a modest amount.
    const p2 = Number(process.env.METRICS_TEST_PORT7 || 8129);
    const srv2 = startMetrics(p2);
    await new Promise((r) => setTimeout(r, 400));
    const post2 = (body) => fetch(`http://localhost:${p2}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await post2({ clientId: "srv", peerId: "p-srv", uploadBytes: 12 * MB });
    for (const w of ["h1", "h2", "h3", "h4"]) {
      await post2({ clientId: w, peerId: `p-${w}`, attest: { "p-srv": 3 * MB } });
    }
    const s2 = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    check("honest: raw credit is 4 x 3MB", s2.attestedByClient.srv, 12 * MB);
    check("honest: filter keeps ALL of it (4 attesters, each under the cap)",
      s2.attestedFilteredByClient.srv, 12 * MB);
    checkTrue("honest runs are not punished by the filter",
      s2.attestedFilteredUploadBytes === s2.attestedUploadBytes);
    srv2.close();

    // THE SYBIL RING from iter 43: 4 identities, each vouched by the other 3. It still gets
    // credit — the filter cannot separate a ring from honest peers — but the per-attester cap
    // means each fake identity is worth at most CAP, so credit no longer scales freely with the
    // claim. Assert the METERING, and do not overclaim that the ring is stopped.
    const p3 = Number(process.env.METRICS_TEST_PORT8 || 8130);
    const srv3 = startMetrics(p3);
    await new Promise((r) => setTimeout(r, 400));
    const post3 = (body) => fetch(`http://localhost:${p3}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const RING = ["s0", "s1", "s2", "s3"];
    for (const me of RING) {
      const attest = {};
      // Each co-conspirator vouches 50MB — far above the 20MB cap.
      for (const other of RING) if (other !== me) attest[`p-${other}`] = 50 * MB;
      await post3({ clientId: me, peerId: `p-${me}`, uploadBytes: 150 * MB, attest });
    }
    const s3 = await fetch(`http://localhost:${p3}/stats`).then((r) => r.json());
    check("ring raw credit per member is 3 x 50MB", s3.attestedByClient.s0, 150 * MB);
    // 3 attesters x 20MB cap = 60MB, so the ring loses 90MB per member to the cap.
    check("filtered caps it to 3 x 20MB", s3.attestedFilteredByClient.s0, 60 * MB);
    checkTrue("the ring loses most of its inflated credit",
      s3.attestedFilteredUploadBytes < s3.attestedUploadBytes * 0.5);
    checkTrue("but it is NOT reduced to zero — the filter meters, it does not stop collusion",
      s3.attestedFilteredByClient.s0 > 0);
    srv3.close();
    srv.close();
  }

  console.log("\npeerId mappings are BOUNDED and stale ones stop resolving (iter 40 defects):");
  {
    // Two real bugs found by reading the attestation code: `peerToClient` had set/get but no
    // delete, so (a) it grew forever and (b) credit kept resolving to clients that had already
    // been evicted — an attacker who learned a retired peerId could aim credit at a departed
    // viewer. Both are regression-guarded here.
    let t = 1000;
    const p = Number(process.env.METRICS_TEST_PORT5 || 8127);
    startMetrics(p, { now: () => t });
    await new Promise((r) => setTimeout(r, 400));
    const b = `http://localhost:${p}`;
    const post = (body) => fetch(`${b}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const stats = () => fetch(`${b}/stats`).then((r) => r.json());

    for (let i = 0; i < 25; i++) await post({ clientId: `c${i}`, peerId: `peer-${i}`, uploadBytes: 10 });
    let s = await stats();
    check("all 25 peerIds tracked while fresh", s.trackedPeerIds, 25);

    // Everyone leaves and time passes well beyond the evict window.
    t += EVICT_MS * 2;
    s = await stats();
    check("clients evicted", s.tracked, 0);
    check("peerId mappings evicted too, so the Map is BOUNDED", s.trackedPeerIds, 0);

    // A fresh viewer attesting for a long-gone peerId must NOT credit the departed client.
    await post({ clientId: "fresh", peerId: "peer-fresh", p2pBytes: 5, attest: { "peer-7": 999 } });
    s = await stats();
    check("credit for a departed peerId is NOT attributed to its old client",
      s.attestedByClient.c7, undefined);
    check("it degrades to unmapped, which is visible and honest",
      s.attestedByClient["unmapped:peer-7"], 999);
    // A live mapping must still resolve — the fix must not break the normal path.
    await post({ clientId: "srv", peerId: "peer-srv", uploadBytes: 100 });
    await post({ clientId: "rcv", peerId: "peer-rcv", p2pBytes: 50, attest: { "peer-srv": 50 } });
    s = await stats();
    check("a live peerId still credits its client", s.attestedByClient.srv, 50);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
