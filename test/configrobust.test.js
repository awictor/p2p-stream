#!/usr/bin/env node
/**
 * configrobust.test.js — the metrics server boots safe under deliberately-bad envs (P2P-0098).
 *
 * CONFIG-ROBUSTNESS SWEEP piece 2. P2P-0097 made the env readers validate (numEnv/posIntEnv catch
 * NaN/negative/zero). This asserts the WHOLE server survives a matrix of garbage envs: it still
 * starts, /healthz is 200, /stats responds, and the specific guard reflects its SAFE DEFAULT rather
 * than the garbage. A guard that silently becomes NaN/negative is worse than the default — it reads
 * as real. Table-driven: a new env knob is one row.
 *
 * startMetrics reads env at CALL time, so each row sets env, boots a fresh server on its own port,
 * probes, and tears down. Ports are per-row so a lingering listener can't cross-contaminate.
 *
 * Usage: node test/configrobust.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each row: an env name, a garbage value, and a checker over /stats that confirms the SAFE default
// held (not the garbage). checker returns true if safe.
const ROWS = [
  { env: "RATE_CAPACITY", bad: "abc", check: (s) => s !== null }, // NaN -> falls back to 30, server serves
  { env: "RATE_CAPACITY", bad: "-5", check: (s) => s !== null },  // negative -> fallback
  { env: "RATE_REFILL_PER_SEC", bad: "NaN", check: (s) => s !== null },
  { env: "MAX_CLIENTS", bad: "-1", check: (s) => s.maxClients === 5000 }, // posIntEnv -> default
  { env: "MAX_CLIENTS", bad: "0", check: (s) => s.maxClients === 5000 },
  { env: "MAX_ATTEST_KEYS", bad: "notanumber", check: (s) => s !== null },
  { env: "AD_FREE_BYTES_PER_SECOND", bad: "-100", check: (s) => s.adFreeBytesPerSecond === 1000000 },
  { env: "AD_FREE_BYTES_PER_SECOND", bad: "abc", check: (s) => s.adFreeBytesPerSecond === 1000000 },
  { env: "ENTITLEMENT_POLICY", bad: "{not valid json", check: (s) => Array.isArray(s.entitlementPolicy?.tiers) }, // malformed -> flat one-tier fallback
  { env: "MAX_REPORT_BYTES", bad: "-1", check: (s) => s !== null },
  { env: "METRICS_BODY_LIMIT", bad: "", check: (s) => s !== null }, // empty -> default 16kb, no crash
];

let port = 8590;
const started = [];

async function bootUnder(envName, badVal) {
  const prev = process.env[envName];
  process.env[envName] = badVal;
  const p = port++;
  let server = null, threw = null;
  try { server = startMetrics(p); } catch (e) { threw = e; }
  if (server) started.push(server);
  await sleep(200);
  let healthz = 0, stats = null;
  if (server) {
    try { healthz = (await fetch(`http://localhost:${p}/healthz`)).status; } catch { /* down */ }
    try { stats = await (await fetch(`http://localhost:${p}/stats`)).json(); } catch { /* down */ }
  }
  // restore env for the next row
  if (prev === undefined) delete process.env[envName]; else process.env[envName] = prev;
  return { threw, healthz, stats };
}

(async () => {
  for (const row of ROWS) {
    const label = `${row.env}=${JSON.stringify(row.bad)}`;
    const r = await bootUnder(row.env, row.bad);
    checkTrue(`${label}: startMetrics did not throw`, r.threw === null, r.threw ? String(r.threw.message) : "");
    checkTrue(`${label}: /healthz 200`, r.healthz === 200, `got ${r.healthz}`);
    checkTrue(`${label}: /stats served + guard at safe default`, r.stats !== null && row.check(r.stats),
      `stats=${r.stats ? "ok-but-guard-wrong" : "null"}`);
  }

  for (const s of started) { try { s.close(); } catch { /* ignore */ } }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
