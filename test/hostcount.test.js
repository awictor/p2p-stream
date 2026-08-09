#!/usr/bin/env node
/**
 * hostcount.test.js — the server-side host-counting path, against the REAL server (iter 73).
 *
 * iter 70 shipped `distinctHosts` / `loopbackClients` in aggregate() as the LOAD-BEARING half of
 * `verify:remote`: they are what lets it refuse to certify a loopback run wearing a LAN URL, which
 * is the one claim HARD RULE 2 forbids. But nothing tested that path against the real Express
 * server. `remote.test.js` covers `remoteVerdict()` and `hostFingerprint()` with hand-built
 * objects; it never drives a real POST -> `req.socket.remoteAddress` -> `aggregate()`. An untested
 * guard whose failure mode is a WRONG PASS (not a crash) is exactly the segment.sh profile of iter
 * 48: small, load-bearing, and silent when broken.
 *
 * WHAT ONE BOX CAN PROVE. Every socket to localhost is loopback, so `distinctHosts` can only ever
 * be 0 or 1 here — which is precisely the REFUSAL path. That is the CI-verifiable half. The literal
 * >=2-distinct-hosts PASS genuinely needs two machines (one box cannot originate two sockets from
 * two addresses) and stays a `manual-qa.md` box.
 *
 * The assertions are written to be mutation-RESISTANT despite that ceiling:
 *   - distinctHosts===1 while tracked===3 proves the code DEDUPES BY HOST, not `clients.size`.
 *   - loopbackClients===3 with distinctHosts===1 proves the two counts are independent.
 *   - after STALE_MS both drop to 0 while tracked stays 3 (pre-EVICT), proving the counts gate on
 *     the ACTIVE window — a departed host contributes nothing, so two SEQUENTIAL single-host runs
 *     cannot sum to "2 hosts" and fake the milestone. A `clients.size` mutation fails all of these.
 *
 * Usage: node test/hostcount.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.HOSTCOUNT_TEST_PORT || 8137);
const BASE = `http://localhost:${PORT}`;
const STALE_MS = 15000;          // must match server/metrics.js
const EVICT_MS = STALE_MS * 20;  // must match server/metrics.js

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
  fetch(`${BASE}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

// Fixed base clock — never Date.now(), so the stale window is deterministic (same idiom as
// metrics.test.js). The server stamps recency itself from this injected clock.
const T = 1_700_000_000_000;
let clock = T;
const advance = (ms) => { clock += ms; };

(async () => {
  const server = startMetrics(PORT, { now: () => clock });
  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  console.log("three real POSTs from this box — all loopback, so ONE host, THREE clients");
  {
    await post({ clientId: "A", httpBytes: 10, p2pBytes: 5 });
    await post({ clientId: "B", httpBytes: 10, p2pBytes: 5 });
    await post({ clientId: "C", httpBytes: 10, p2pBytes: 5 });
    const s = await stats();

    check("three viewers are active", s.viewers, 3);
    check("tracked is 3 (all held in the Map)", s.tracked, 3);
    // THE ASSERTION THAT MATTERS: three clients, ONE host. If distinctHosts were `clients.size`
    // (the obvious wrong implementation) this would read 3 and verify:remote would certify a
    // single-box run as cross-network — the exact HARD RULE 2 violation this guard prevents.
    check("distinctHosts is 1 — deduped by host, NOT client count", s.distinctHosts, 1);
    check("loopbackClients is 3 — every socket to this box is loopback", s.loopbackClients, 3);
    checkTrue("distinctHosts and loopbackClients are independent counts, not the same number",
      s.distinctHosts !== s.loopbackClients,
      "if they always match, one is just aliasing the other");
    // The field must exist as a NUMBER, not undefined — remoteVerdict treats a missing
    // distinctHosts as unjudgeable (exit 2), so a server that forgot to emit it would make every
    // real run unverifiable.
    checkTrue("distinctHosts is a number the verdict can read", typeof s.distinctHosts === "number");
  }

  console.log("\nthe verdict this feeds: one host is a REFUSAL even with real P2P bytes");
  {
    // Prove the loopback numbers reach the SAME verdict verify:remote prints, end to end from a
    // real server rather than a fixture. This is what the milestone check actually consumes.
    const { remoteVerdict } = await import("./verify-offload.js");
    const s = await stats();
    const v = remoteVerdict(s);
    check("real single-box /stats -> exit 2 (REFUSED)", v.code, 2);
    checkTrue("...and it is worded as a loopback refusal", /loopback|one host|share/i.test(v.reason));
  }

  console.log("\nprivacy: /stats never leaks a raw address, only a hash and counts");
  {
    const raw = JSON.stringify(await stats());
    checkTrue("no 127.0.0.1 anywhere in /stats", !raw.includes("127.0.0.1"),
      "/stats is world-readable to the whole swarm");
    checkTrue("no ::1 loopback literal either", !/(^|[^\d.])::1(?![\d])/.test(raw) && !raw.includes('"::1"'));
    checkTrue("distinctHosts is exposed as a COUNT, not a list of hosts", typeof (await stats()).distinctHosts === "number");
  }

  console.log("\nSTALE drop: a host silent past STALE_MS stops counting (no sequential-run summing)");
  {
    // All three clients go quiet. Past STALE_MS they must leave the ACTIVE host set even though
    // they are still tracked (not yet EVICT_MS old). If distinctHosts kept counting them, two
    // single-machine sessions run back to back would add up to "2 hosts" and fake a cross-network
    // pass. This is the assertion that forbids that.
    advance(STALE_MS + 1);
    const s = await stats();
    check("no active viewers after the stale window", s.viewers, 0);
    check("but they are STILL tracked (pre-eviction)", s.tracked, 3);
    check("distinctHosts drops to 0 — counts only ACTIVE hosts", s.distinctHosts, 0);
    check("loopbackClients drops to 0 for the same reason", s.loopbackClients, 0);

    // A fresh report refills the active set — the count is rebuilt each aggregate() call, not
    // accumulated. Back to exactly one host, one loopback client.
    await post({ clientId: "D", httpBytes: 10, p2pBytes: 5 });
    const s2 = await stats();
    check("a new active client brings distinctHosts back to 1, not 2", s2.distinctHosts, 1);
    check("loopbackClients back to 1", s2.loopbackClients, 1);
    checkTrue("the stale ones did NOT sum in (would be a fake 2-host run)", s2.distinctHosts === 1,
      "sequential single-host runs must never total more than one host");
  }

  console.log("\neviction: past EVICT_MS the stale entries are reclaimed, counts unaffected");
  {
    // D stays active; A/B/C age past EVICT and are removed from the Map. distinctHosts/
    // loopbackClients are about ACTIVE clients, so they were already 1 — eviction must not disturb
    // them. Guards that host-counting reads live entries, not retired totals.
    advance(EVICT_MS + 1);
    await post({ clientId: "D", httpBytes: 20, p2pBytes: 10 }); // keep D fresh across the advance
    const s = await stats();
    check("only D remains tracked", s.tracked, 1);
    check("distinctHosts still 1", s.distinctHosts, 1);
    check("loopbackClients still 1", s.loopbackClients, 1);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  // CLOSE the listener before exiting. `process.exit()` while the server handle is still open
  // trips Windows libuv `Assertion !(handle->flags & UV_HANDLE_CLOSING)` and exits 127 AFTER all
  // assertions passed — a green run reported as a hard failure. Setting exitCode and letting the
  // closed loop drain avoids it.
  server.close(() => { process.exitCode = failures === 0 ? 0 : 1; });
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
