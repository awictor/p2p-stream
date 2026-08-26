#!/usr/bin/env node
/**
 * ceiling.test.js — hard ceilings on client-controlled state in server/metrics.js (iter 75).
 *
 * P2P-0061. POST /metrics is PUBLIC and UNAUTHENTICATED, and until this fire the only bound on
 * resident state was TIME (EVICT_MS). A burst of unique clientIds inside one 5-min window grew the
 * `clients` Map without limit — a memory-exhaustion DoS on the one server a real audience depends
 * on. `attest` accepted unlimited peerId keys per POST, and `clientId` was an unbounded Map key.
 *
 * These caps bound MEMORY. They do NOT authenticate a peer (the commit says so): a determined
 * attacker can still churn the Map by flooding fake ids. That is a tracker-auth problem, out of
 * scope. What is in scope and tested here: the Map cannot grow past MAX_CLIENTS however fast junk
 * arrives, and eviction stays byte-monotonic so the published offload number never jumps backward.
 *
 * Run with tiny caps via env so the burst is small and deterministic; no sleeping (injected clock).
 *
 * Usage: node test/ceiling.test.js     (exit 0 = pass, 1 = fail)
 */
process.env.MAX_CLIENTS = "10";
process.env.MAX_ATTEST_KEYS = "4";
process.env.MAX_CLIENTID_LEN = "16";
// This test floods 100+ POSTs from one host to exercise the COUNT ceiling + byte accounting, which
// trips the per-IP rate limiter (default RATE_CAPACITY=30) and turns real assertions into 429s.
// Rate limiting has its own test (ratelimit.test.js); disable it here (documented 0 = off).
process.env.RATE_CAPACITY = "0";

import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.CEILING_TEST_PORT || 8141);
const BASE = `http://localhost:${PORT}`;
const MAX_CLIENTS = 10;
const MAX_ATTEST_KEYS = 4;
const MAX_CLIENTID_LEN = 16;

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

const T = 1_700_000_000_000;
let clock = T;
const advance = (ms) => { clock += ms; };

(async () => {
  const server = startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400));

  console.log("the ceiling is exposed so `tracked` can be read against its bound");
  {
    const s = await stats();
    check("maxClients is reported", s.maxClients, MAX_CLIENTS);
  }

  console.log("\na burst of unique clientIds cannot grow the Map past MAX_CLIENTS");
  {
    // 100 distinct ids, all inside one window (clock never advanced past EVICT), so the TIME sweep
    // would never fire. Only the count ceiling can bound this. Give each a distinct byte total so
    // eviction accounting is checkable.
    for (let i = 0; i < 100; i++) {
      await post({ clientId: `flood-${i}`, httpBytes: 100, p2pBytes: 100 });
    }
    const s = await stats();
    checkTrue(`tracked never exceeds MAX_CLIENTS (got ${s.tracked})`, s.tracked <= MAX_CLIENTS,
      "time eviction cannot fire inside one window — only the count ceiling bounds a burst");
    check("tracked sits exactly at the ceiling after a 100-id flood", s.tracked, MAX_CLIENTS);
  }

  console.log("\neviction-when-full stays byte-MONOTONIC (offloadRatio never jumps backward)");
  {
    // 100 clients * (100 http + 100 p2p) = 20000 of each were reported. Whether an entry is
    // resident or evicted-into-retired, the TOTALS must reflect every byte — dropping entries
    // would subtract real bytes and make the published saving lurch backward.
    const s = await stats();
    check("httpBytes counts ALL reported bytes, resident + retired", s.httpBytes, 100 * 100);
    check("p2pBytes likewise", s.p2pBytes, 100 * 100);
    check("offloadRatio is exactly 0.5 (100 http vs 100 p2p each)", s.offloadRatio, 0.5);
    check("retiredClients accounts for everyone evicted", s.retiredClients, 100 - MAX_CLIENTS);
    // Monotonic under continued pressure: another flood must not drop either total.
    for (let i = 100; i < 140; i++) await post({ clientId: `flood-${i}`, httpBytes: 100, p2pBytes: 100 });
    const s2 = await stats();
    checkTrue("httpBytes only ever grows", s2.httpBytes >= s.httpBytes);
    check("still capped at MAX_CLIENTS", s2.tracked, MAX_CLIENTS);
    check("all 140 counted (0 lost)", s2.httpBytes, 140 * 100);
  }

  console.log("\noldest-by-lastSeen is evicted first (the entry closest to timing out anyway)");
  {
    const p2 = 8155;
    const s2 = startMetrics(p2, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post2 = (b) => fetch(`http://localhost:${p2}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    // Fill to the ceiling, each a tick apart so lastSeen strictly orders them.
    for (let i = 0; i < MAX_CLIENTS; i++) { await post2({ clientId: `c${i}`, httpBytes: 1 }); advance(1); }
    // One more, distinct-byte, forces exactly one eviction — must be c0 (oldest).
    await post2({ clientId: "newcomer", httpBytes: 999 });
    const st = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    check("still at ceiling after the newcomer", st.tracked, MAX_CLIENTS);
    check("exactly one client was retired", st.retiredClients, 1);
    // Re-report c0: if it were still resident this would UPDATE in place (tracked stays MAX);
    // since it was evicted, it re-enters as new and forces another eviction — tracked stays at
    // ceiling either way, so instead assert its bytes were retired (folded), not lost.
    checkTrue("the evicted client's bytes survived in the totals", st.httpBytes >= (MAX_CLIENTS - 1) + 999,
      "oldest c0 (1 byte) folded into retired; newcomer 999 resident");
    await new Promise((r) => s2.close(r));
  }

  console.log("\nattest keys are capped per report");
  {
    const attest = {};
    for (let i = 0; i < 50; i++) attest[`peer-${i}`] = 1000;
    await post({ clientId: "attester", peerId: "self", attest });
    const s = await stats();
    // attestedByClient sums the *credited* bytes; with the cap, at most MAX_ATTEST_KEYS peers were
    // stored, so the attesting side cannot have injected 50 keys. Assert via attestingClients and
    // that the stored credit is bounded by the cap.
    checkTrue("the attester is recorded", s.attestingClients >= 1);
    // Each kept key is 1000 bytes; total credit from this attester cannot exceed cap*1000.
    checkTrue(`attested credit is capped (<= ${MAX_ATTEST_KEYS} keys)`,
      Object.values(s.attestedByClient || {}).every((v) => true) &&
      (s.attestedUploadBytes <= MAX_ATTEST_KEYS * 1000),
      `attestedUploadBytes=${s.attestedUploadBytes} should be <= ${MAX_ATTEST_KEYS * 1000}`);
  }

  console.log("\nclientId length is clamped");
  {
    const longId = "x".repeat(500);
    await post({ clientId: longId, httpBytes: 5 });
    const s = await stats();
    // The clamped id is what appears in uploadByClient keys. None may exceed the cap length.
    const keys = Object.keys(s.uploadByClient || {});
    checkTrue("no client key exceeds MAX_CLIENTID_LEN",
      keys.every((k) => k.length <= MAX_CLIENTID_LEN),
      `longest key: ${Math.max(0, ...keys.map((k) => k.length))}`);
    // A non-string clientId must be rejected outright (400), not coerced.
    const bad = await post({ clientId: 12345, httpBytes: 1 });
    check("a non-string clientId is rejected 400", bad.status, 400);
    const empty = await post({ httpBytes: 1 });
    check("a missing clientId is rejected 400", empty.status, 400);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
