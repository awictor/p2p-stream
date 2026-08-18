#!/usr/bin/env node
/**
 * verify-swarm-flood.js — SWARM-SCALE piece 3 (P2P-0088, iter 159): graceful ceiling degradation
 * under a REAL CONCURRENT flood past MAX_CLIENTS.
 *
 * ceiling.test.js already proves the MAX_CLIENTS cap + byte-monotonic eviction with SEQUENTIAL
 * synthetic POSTs (injected clock). This proves the SAME invariants survive the actual overload
 * shape: N clientIds POSTed CONCURRENTLY, N well above a small MAX_CLIENTS. The question a platform
 * asks — "at the cap, does it shed load gracefully or fall over?" — is answered here.
 *
 * SERVER LOAD on loopback, N synthetic /metrics reports. NOT a WebRTC mesh, NOT an offload/browser/
 * cross-network number (HARD RULE 2).
 *
 * Asserts under the flood:
 *   - /stats.tracked is CAPPED at MAX_CLIENTS (equals it, never N, never exceeds maxClients),
 *   - eviction actually engaged (retiredClients > 0),
 *   - published byte totals are monotonic — >= the bytes injected by every accepted report, with no
 *     backward jump (retired folds departed peers in; the offload number never regresses).
 *
 * Usage: node test/verify-swarm-flood.js [N] [MAX_CLIENTS]   (defaults N=100, cap=20; exit 0 = pass)
 */
const N = Number(process.argv[2]) || 100;
const CAP = Number(process.argv[3]) || 20;
// startMetrics reads MAX_CLIENTS from env at call-time (server/metrics.js:95). Set BEFORE import.
process.env.MAX_CLIENTS = String(CAP);

const { startMetrics } = await import("../server/metrics.js");

const M_PORT = 8562;
const HTTP_PER = 1000;
const P2P_PER = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const post = (body) => fetch(`http://localhost:${M_PORT}/metrics`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const stats = () => fetch(`http://localhost:${M_PORT}/stats`).then((r) => r.json());

(async () => {
  console.log(`SWARM FLOOD — N=${N} concurrent reports vs MAX_CLIENTS=${CAP} (SERVER LOAD, loopback; NOT an offload/mesh/cross-network number)`);

  const metrics = startMetrics(M_PORT);
  await sleep(300);

  // Flood: N distinct clientIds POSTed concurrently — N >> CAP, so the Map must evict, not grow.
  let accepted = 0;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    post({ clientId: `flood-${i}`, peerId: `peer-flood-${i}`, httpBytes: HTTP_PER, p2pBytes: P2P_PER, uploadBytes: 0 })
      .then((r) => { if (r.ok) accepted++; }).catch(() => {})));
  await sleep(500);

  const s = await stats();
  console.log(`\ntracked=${s.tracked} maxClients=${s.maxClients} retiredClients=${s.retiredClients} httpBytes=${s.httpBytes} p2pBytes=${s.p2pBytes} (accepted ${accepted}/${N})`);

  checkTrue(`the tracker/metrics accepted the flood (>=CAP reports)`, accepted >= CAP, `only ${accepted} accepted`);
  check(`/stats.tracked CAPPED at MAX_CLIENTS (${CAP}), not N (${N})`, s.tracked, CAP);
  checkTrue("tracked never exceeds maxClients", s.tracked <= s.maxClients);
  checkTrue("eviction ENGAGED (retiredClients > 0)", s.retiredClients > 0);
  // Monotonic: every accepted report's bytes are counted (live OR retired), so totals >= accepted*per.
  checkTrue(`byte totals monotonic — httpBytes >= accepted*${HTTP_PER}`, s.httpBytes >= accepted * HTTP_PER,
    `httpBytes ${s.httpBytes} < ${accepted * HTTP_PER}`);
  checkTrue(`byte totals monotonic — p2pBytes >= accepted*${P2P_PER}`, s.p2pBytes >= accepted * P2P_PER);
  // And a second /stats read never shows a LOWER total (no backward jump under continued eviction).
  const s2 = await stats();
  checkTrue("httpBytes never regresses on a re-read", s2.httpBytes >= s.httpBytes);

  try { metrics.close(); } catch { /* ignore */ }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
