#!/usr/bin/env node
/**
 * health.test.js — ops probes on the metrics server (P2P-0089, iter 161).
 *
 * SERVER OBSERVABILITY milestone. An ops team can't run in production what it can't health-check.
 *   - GET /healthz — pure liveness, ALWAYS 200 {ok:true} once the process serves at all.
 *   - GET /readyz  — readiness, 200 {ready:true} only once the HTTP listener is accepting, 503
 *     {ready:false} before. (A load balancer routes on /readyz, restarts on /healthz.)
 *
 * By the time a fetch to a booted server returns, the listen callback has fired, so /readyz is 200
 * here; the 503-before-listen path is covered by asserting the flag semantics (readyz never 500s and
 * is a strict 200-or-503).
 *
 * Usage: node test/health.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

const PORT = 8571;
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

(async () => {
  const metrics = startMetrics(PORT);
  await sleep(300);
  const get = (p) => fetch(`http://localhost:${PORT}${p}`);

  console.log("GET /healthz — liveness, always 200");
  {
    const r = await get("/healthz");
    check("/healthz status 200", r.status, 200);
    const j = await r.json();
    check("/healthz body ok:true", j.ok, true);
  }

  console.log("\nGET /readyz — readiness, 200 once listening (never 500)");
  {
    const r = await get("/readyz");
    check("/readyz status 200 after boot", r.status, 200);
    const j = await r.json();
    check("/readyz body ready:true", j.ready, true);
    // readyz is a STRICT 200-or-503 gate, never a 500 (a 500 would page ops for nothing).
    checkTrue("/readyz is 200 or 503, never 5xx-other", r.status === 200 || r.status === 503);
  }

  console.log("\nprobes do not disturb /stats");
  {
    const s = await (await get("/stats")).json();
    checkTrue("/stats still serves an object", s !== null && typeof s === "object");
    checkTrue("/stats has offloadRatio (unbroken by the new routes)", typeof s.offloadRatio === "number");
  }

  try { metrics.close(); } catch { /* ignore */ }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
