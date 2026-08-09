#!/usr/bin/env node
/**
 * envlimits.test.js — a misconfigured limit env must fail SAFE, not silently disable a guard
 * (iter 84, HARDEN).
 *
 * The limit envs (MAX_CLIENTS, MAX_ATTEST_KEYS, MAX_CLIENTID_LEN, MAX_REPORT_BYTES) were parsed with
 * `Number(env || default)`. That is a silent footgun:
 *   - `Number("5oo")` is NaN. `clients.size > NaN` is always false, so a TYPO'd MAX_CLIENTS disables
 *     the ceiling entirely and the memory DoS P2P-0061 closed returns, with no signal at all.
 *   - `0` or a negative evicts every client -> /stats permanently empty.
 *   - A typo'd MAX_REPORT_BYTES -> NaN, and `n > NaN` is false in sanitizeBytes, so the byte clamp
 *     vanishes and the P2P-0063 poison (offloadRatio > 1) comes back.
 * A guard that silently turns itself off on a config typo is worse than no guard, because the
 * operator believes they are protected. Now: a limit env is honoured only when it parses to a
 * positive number (integer for the count/length limits); anything else falls back to the default.
 *
 * startMetrics reads env at call time, so each case sets env, boots a fresh server, and asserts.
 *
 * Usage: node test/envlimits.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

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

let clock = 1_700_000_000_000;
let port = 8400;
const servers = [];
// Boot a server with a given MAX_CLIENTS env and return its /stats. Restores env after.
async function bootWith(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const p = port++;
  const s = startMetrics(p, { now: () => clock });
  servers.push(s);
  await new Promise((r) => setTimeout(r, 250));
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  const post = (b) => fetch(`http://localhost:${p}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const stats = () => fetch(`http://localhost:${p}/stats`).then((r) => r.json());
  return { post, stats };
}

(async () => {
  console.log("a typo'd MAX_CLIENTS falls back to the default, does NOT disable the ceiling");
  {
    // "5oo" -> NaN under the old parse. The ceiling must still be a real number (the default).
    const { stats } = await bootWith({ MAX_CLIENTS: "5oo" });
    const s = await stats();
    check("maxClients falls back to default 5000, not NaN", s.maxClients, 5000);
    checkTrue("maxClients is a finite number", Number.isFinite(s.maxClients));
  }

  console.log("\nthe fallback ceiling actually enforces (a flood is still capped)");
  {
    const { post, stats } = await bootWith({ MAX_CLIENTS: "3" }); // valid small ceiling
    for (let i = 0; i < 20; i++) await post({ clientId: `c${i}`, httpBytes: 1 });
    const s = await stats();
    check("a valid small ceiling is honoured", s.maxClients, 3);
    checkTrue("flood capped at the ceiling", s.tracked <= 3, `tracked=${s.tracked}`);
  }

  console.log("\nMAX_CLIENTS=0 / negative does NOT evict everyone (would empty /stats forever)");
  {
    const zero = await bootWith({ MAX_CLIENTS: "0" });
    await zero.post({ clientId: "a", httpBytes: 1 });
    let s = await zero.stats();
    check("MAX_CLIENTS=0 falls back to default, not 0", s.maxClients, 5000);
    checkTrue("the client is retained, not evicted to an empty dashboard", s.tracked === 1,
      "a 0 ceiling would evict every client and /stats would always read empty");

    const neg = await bootWith({ MAX_CLIENTS: "-5" });
    await neg.post({ clientId: "a", httpBytes: 1 });
    s = await neg.stats();
    check("MAX_CLIENTS=-5 falls back to default", s.maxClients, 5000);
    check("negative does not empty the map either", s.tracked, 1);
  }

  console.log("\na typo'd MAX_REPORT_BYTES falls back, so the byte clamp does not vanish");
  {
    // Under the old parse this is NaN and sanitizeBytes stops clamping -> poison returns.
    const { post, stats } = await bootWith({ MAX_REPORT_BYTES: "1eXX" });
    await post({ clientId: "poison", httpBytes: 0, p2pBytes: 1e15 });
    const s = await stats();
    checkTrue("offloadRatio stays within [0,1] despite a garbage MAX_REPORT_BYTES",
      s.offloadRatio >= 0 && s.offloadRatio <= 1,
      "a NaN ceiling would let the 1e15 through and drive offloadRatio impossible");
    checkTrue("the 1e15 was clamped to the fallback ceiling, not stored raw",
      s.p2pBytes <= 1e12, `p2pBytes=${s.p2pBytes}`);
  }

  console.log("\na VALID non-default is still honoured (fallback is not a floor)");
  {
    const { stats } = await bootWith({ MAX_CLIENTS: "42" });
    const s = await stats();
    check("a valid MAX_CLIENTS=42 is used verbatim", s.maxClients, 42);
  }

  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
