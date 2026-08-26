#!/usr/bin/env node
/**
 * ratelimit.test.js — per-IP token-bucket rate limit (P2P-0093, iter 170).
 *
 * PER-IP RATE LIMITING milestone. Two layers:
 *   1. PURE unit tests on rateLimit()/pruneBuckets() — the mutation target: burst up to capacity,
 *      deny over cap, refill over wall-clock, independent per-key buckets, fail-OPEN on bad config.
 *   2. INTEGRATION: boot metrics with a tiny RATE_CAPACITY, flood POST /metrics from one source,
 *      assert 429 once the bucket empties. (Loopback is one host, so the "second IP passes" case is
 *      proven by the pure independent-keys test, not two sockets that hash to the same fingerprint.)
 *
 * Usage: node test/ratelimit.test.js     (exit 0 = pass, 1 = fail)
 */
import { rateLimit, pruneBuckets } from "../server/ratelimit.js";
import { startMetrics } from "../server/metrics.js";

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}

console.log("pure rateLimit — burst up to capacity, then deny");
{
  const state = {};
  const opts = { capacity: 3, refillPerSec: 1 };
  const r1 = rateLimit(state, "a", 0, opts);
  const r2 = rateLimit(state, "a", 0, opts);
  const r3 = rateLimit(state, "a", 0, opts);
  const r4 = rateLimit(state, "a", 0, opts); // 4th in the same instant -> over cap
  checkTrue("1st allowed", r1.allowed === true);
  checkTrue("2nd allowed", r2.allowed === true);
  checkTrue("3rd allowed (capacity=3)", r3.allowed === true);
  checkTrue("4th denied (bucket empty)", r4.allowed === false, `allowed=${r4.allowed}`);
}

console.log("\npure rateLimit — refills over wall-clock time");
{
  const state = {};
  const opts = { capacity: 2, refillPerSec: 1 };
  rateLimit(state, "a", 0, opts);           // tokens 2 -> 1
  rateLimit(state, "a", 0, opts);           // tokens 1 -> 0
  const denied = rateLimit(state, "a", 0, opts); // 0 -> deny
  checkTrue("denied at empty", denied.allowed === false);
  const afterQuarter = rateLimit(state, "a", 500, opts); // +0.5s @1/s = +0.5 token -> still <1
  checkTrue("still denied after 0.5s (<1 token)", afterQuarter.allowed === false, `tokens=${afterQuarter.tokens}`);
  const afterFull = rateLimit(state, "a", 1500, opts);   // now ~1+ token accrued
  checkTrue("allowed after enough refill", afterFull.allowed === true, `tokens=${afterFull.tokens}`);
}

console.log("\npure rateLimit — distinct keys have INDEPENDENT buckets (the 'second IP passes' case)");
{
  const state = {};
  const opts = { capacity: 1, refillPerSec: 0 };
  const a1 = rateLimit(state, "ipA", 0, opts); // spends ipA's only token
  const a2 = rateLimit(state, "ipA", 0, opts); // ipA now empty -> deny
  const b1 = rateLimit(state, "ipB", 0, opts); // ipB untouched -> allowed
  checkTrue("ipA first allowed", a1.allowed === true);
  checkTrue("ipA second denied", a2.allowed === false);
  checkTrue("ipB allowed despite ipA being throttled", b1.allowed === true);
}

console.log("\npure rateLimit — fail OPEN on disabled/bad config (never silently deny all)");
{
  checkTrue("capacity<=0 disables (always allowed)", rateLimit({}, "a", 0, { capacity: 0, refillPerSec: 1 }).allowed === true);
  checkTrue("NaN capacity fails open", rateLimit({}, "a", 0, { capacity: NaN, refillPerSec: 1 }).allowed === true);
  checkTrue("negative refill fails open", rateLimit({}, "a", 0, { capacity: 5, refillPerSec: -1 }).allowed === true);
}

console.log("\npruneBuckets — drops idle keys, keeps fresh ones");
{
  const state = { old: { tokens: 1, ts: 0 }, fresh: { tokens: 1, ts: 9000 } };
  const pruned = pruneBuckets(state, 10000, 5000); // idle>5s dropped
  checkTrue("pruned the idle bucket", pruned === 1, `pruned=${pruned}`);
  checkTrue("kept the fresh bucket", state.fresh !== undefined && state.old === undefined);
}

// ---- INTEGRATION -------------------------------------------------------------------------------
const PORT = 8579;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\nintegration — POST /metrics floods one IP past cap -> 429");
  // Tiny capacity + zero refill so a short burst deterministically trips the limit within the test.
  process.env.RATE_CAPACITY = "3";
  process.env.RATE_REFILL_PER_SEC = "0";
  const server = startMetrics(PORT);
  await sleep(250);
  const post = () => fetch(`http://localhost:${PORT}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "flood", httpBytes: 1, p2pBytes: 1 }),
  }).then((r) => r.status);

  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await post());
  const ok = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  checkTrue("first requests within cap returned 200", ok === 3, `200-count=${ok} statuses=${statuses}`);
  checkTrue("over-cap requests returned 429", limited === 3, `429-count=${limited} statuses=${statuses}`);

  // Await the close callback before leaving. process.exit() while the listener handle is still
  // closing trips Windows libuv UV_HANDLE_CLOSING and exits 127 AFTER success (patterns.md). Set
  // exitCode and let the drained loop end on its own instead.
  await new Promise((r) => { try { server.close(r); } catch { r(); } });
  delete process.env.RATE_CAPACITY;
  delete process.env.RATE_REFILL_PER_SEC;
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
