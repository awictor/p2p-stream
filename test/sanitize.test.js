#!/usr/bin/env node
/**
 * sanitize.test.js — the published number cannot be poisoned by one malformed report (iter 79).
 *
 * P2P-0063. POST /metrics coerced byte fields with `Number(x) || 0`, which only catches NaN
 * (NaN||0=0) but PASSES negatives and absurd magnitudes. PROVEN live before the fix: one POST of
 * `p2pBytes: -1e12` drove offloadRatio to 1.0000000001 -- a ratio cannot exceed 1 -- and
 * `p2pBytes: 1e15` pushed it to ~0.9999. Because reports fold into `retired` on eviction, a poisoned
 * value is baked in PERMANENTLY. offloadRatio (the -51% claim) is the ONE number the product exists
 * to show, so a single unauthenticated POST could make it unquotable.
 *
 * This bounds the VALUE RANGE of a reported counter. It does NOT authenticate the reporter -- a peer
 * can still lie WITHIN [0, MAX_REPORT_BYTES]. It stops the published figure from going impossible or
 * negative from one malformed report.
 *
 * Usage: node test/sanitize.test.js     (exit 0 = pass, 1 = fail)
 */
process.env.MAX_REPORT_BYTES = "1000000"; // 1MB, tiny so the clamp is easy to assert

import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.SANITIZE_TEST_PORT || 8147);
const BASE = `http://localhost:${PORT}`;
const MAX_REPORT_BYTES = 1_000_000;

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

(async () => {
  const server = startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400));

  console.log("an honest baseline report is untouched");
  {
    await post({ clientId: "honest", httpBytes: 100, p2pBytes: 100 });
    const s = await stats();
    check("offloadRatio is a clean 0.5", s.offloadRatio, 0.5);
    check("p2pBytes is exactly what was reported", s.p2pBytes, 100);
  }

  console.log("\nTHE POISON: a NEGATIVE byte count cannot drive offloadRatio impossible");
  {
    // Before the fix this drove offloadRatio to 1.0000000001 and p2pBytes deeply negative.
    await post({ clientId: "neg", httpBytes: 0, p2pBytes: -1e12 });
    const s = await stats();
    checkTrue("offloadRatio never exceeds 1", s.offloadRatio <= 1,
      "a ratio above 1 is mathematically impossible and unquotable");
    checkTrue("offloadRatio never goes below 0", s.offloadRatio >= 0);
    checkTrue("p2pBytes is never negative", s.p2pBytes >= 0,
      "a negative counter folded into retired would corrupt every future read");
    // The negative report contributes 0, so the swarm total is unchanged from the honest baseline.
    check("the negative report contributed 0 p2p bytes", s.p2pBytes, 100);
  }

  console.log("\nan ABSURDLY LARGE value is clamped to the ceiling, not taken raw");
  {
    await post({ clientId: "huge", httpBytes: 0, p2pBytes: 1e15 });
    const s = await stats();
    checkTrue("offloadRatio still within [0,1]", s.offloadRatio >= 0 && s.offloadRatio <= 1);
    // honest 100 + clamp(1e15)=1e6 ; the 1e15 must NOT appear raw.
    checkTrue("the 1e15 value was clamped, not stored raw", s.p2pBytes <= 100 + MAX_REPORT_BYTES,
      `p2pBytes=${s.p2pBytes} should be <= ${100 + MAX_REPORT_BYTES}`);
    checkTrue("and it did clamp to the ceiling (not drop to 0)", s.p2pBytes === 100 + MAX_REPORT_BYTES,
      "an overshoot should still count its bytes up to the bound, not vanish");
  }

  console.log("\nnon-numeric junk collapses to 0, never NaN in the totals");
  {
    // A fresh server so the junk is the only non-honest input and the assertion is exact.
    const p2 = 8158;
    const s2 = startMetrics(p2, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post2 = (b) => fetch(`http://localhost:${p2}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await post2({ clientId: "h", httpBytes: 50, p2pBytes: 50 });
    await post2({ clientId: "junk", httpBytes: "not-a-number", p2pBytes: NaN, uploadBytes: null });
    await post2({ clientId: "inf", p2pBytes: Infinity, httpBytes: -Infinity });
    const s = await fetch(`http://localhost:${p2}/stats`).then((r) => r.json());
    checkTrue("offloadRatio is a finite number", Number.isFinite(s.offloadRatio));
    checkTrue("no NaN reached httpBytes", Number.isFinite(s.httpBytes) && s.httpBytes >= 0);
    checkTrue("no NaN reached p2pBytes", Number.isFinite(s.p2pBytes) && s.p2pBytes >= 0);
    check("junk contributed nothing: totals are just the honest 50/50", s.offloadRatio, 0.5);
    check("p2pBytes is exactly the honest 50", s.p2pBytes, 50);
    await new Promise((r) => s2.close(r));
  }

  console.log("\npoison SURVIVES eviction: a clamped value cannot corrupt the retired fold");
  {
    // retire() folds a client's bytes into `retired` when it ages out. If a negative had been
    // stored it would subtract from the session total forever. Advance past EVICT and confirm the
    // totals only ever grew.
    const before = await stats();
    clock += 15000 * 20 + 1; // > EVICT_MS
    await post({ clientId: "trigger", httpBytes: 1, p2pBytes: 1 }); // force an aggregate sweep
    const after = await stats();
    checkTrue("httpBytes did not drop across eviction", after.httpBytes >= before.httpBytes,
      "a folded negative would make the session total lurch down");
    checkTrue("p2pBytes did not drop across eviction", after.p2pBytes >= before.p2pBytes);
    checkTrue("offloadRatio still within [0,1] after the fold", after.offloadRatio >= 0 && after.offloadRatio <= 1);
  }

  console.log("\nattested credit is range-clamped too (same poison vector, different field)");
  {
    const p3 = 8159;
    const s3 = startMetrics(p3, { now: () => clock });
    await new Promise((r) => setTimeout(r, 300));
    const post3 = (b) => fetch(`http://localhost:${p3}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    // A receiver attesting a NEGATIVE and an ABSURD credit for two peers.
    await post3({ clientId: "rcv", peerId: "self", attest: { "peer-neg": -1e12, "peer-huge": 1e15, "peer-ok": 500 } });
    const s = await fetch(`http://localhost:${p3}/stats`).then((r) => r.json());
    checkTrue("attestedUploadBytes is never negative", s.attestedUploadBytes >= 0);
    checkTrue("attestedUploadBytes is finite and clamped",
      Number.isFinite(s.attestedUploadBytes) && s.attestedUploadBytes <= 2 * MAX_REPORT_BYTES + 500,
      `attestedUploadBytes=${s.attestedUploadBytes}`);
    await new Promise((r) => s3.close(r));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
