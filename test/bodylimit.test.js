#!/usr/bin/env node
/**
 * bodylimit.test.js — /metrics rejects malformed and oversized bodies quietly (iter 92, HARDEN).
 *
 * /metrics is public and unauthenticated. express.json() was mounted with no limit (100KB default,
 * ~100x any real report) and no error handler, so a malformed or over-limit body dumped a full
 * body-parser stack trace to stderr on EVERY hit — a path leak AND a log-flood vector (an attacker
 * POSTs garbage in a loop). Now: a 16KB limit and a quiet handler that returns the right status
 * with one terse line and no trace, and — critically — the server stays up and honest reports still
 * work after a flood of bad ones.
 *
 * Usage: node test/bodylimit.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.BODYLIMIT_TEST_PORT || 8151);
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

const rawPost = (body) =>
  fetch(`${BASE}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

let clock = 1_700_000_000_000;

(async () => {
  const server = startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400));

  console.log("a malformed JSON body is rejected 400, not a 500 or a hang");
  {
    const r = await rawPost("{not valid json");
    check("malformed body -> 400", r.status, 400);
    const j = await r.json().catch(() => null);
    checkTrue("responds with a JSON error object, not an HTML stack page", j !== null && typeof j.error === "string");
  }

  console.log("\nan over-limit body is rejected 413 (16KB bound, not the 100KB default)");
  {
    // ~64KB valid JSON: over our 16KB bound, under express's old 100KB default. Proves the tightened
    // limit is actually in effect.
    const big = JSON.stringify({ clientId: "x", blob: "A".repeat(64 * 1024) });
    const r = await rawPost(big);
    check("64KB body -> 413 (would have been accepted under the 100KB default)", r.status, 413);
  }

  console.log("\nthe server survives a flood of bad bodies and still serves honest traffic");
  {
    for (let i = 0; i < 25; i++) await rawPost("garbage" + i);
    const s = await stats();
    check("/stats still answers after 25 malformed POSTs", typeof s.offloadRatio, "number");
    // An honest report right after the flood is accepted and counted.
    const ok = await rawPost(JSON.stringify({ clientId: "honest", httpBytes: 100, p2pBytes: 100 }));
    check("an honest report after the flood -> 200", ok.status, 200);
    const s2 = await stats();
    check("and it was counted (1 viewer)", s2.viewers, 1);
    check("offloadRatio reflects the honest report", s2.offloadRatio, 0.5);
  }

  console.log("\na normal-size report is unaffected by the 16KB limit");
  {
    // A realistic report with a full MAX_ATTEST_KEYS-ish attest map is still well under 16KB.
    const attest = {};
    for (let i = 0; i < 200; i++) attest[`peer-${i}-${"x".repeat(20)}`] = 1000 + i;
    const r = await rawPost(JSON.stringify({ clientId: "big-but-legit", peerId: "self", uploadBytes: 5e6, attest }));
    check("a realistic report with 200 attest keys -> 200 (well under 16KB)", r.status, 200);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
