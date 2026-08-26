#!/usr/bin/env node
/**
 * trackerratelimit.test.js — per-IP WS connection rate limit on the tracker (P2P-0094, iter 171).
 *
 * PER-IP RATE LIMITING milestone, piece 2. Reuses the SAME token-bucket (server/ratelimit.js) as the
 * /metrics limiter (P2P-0093), applied to the tracker's public WS signaling 'connection' event: one
 * IP opening connections past WS_RATE_CAPACITY has the over-cap sockets closed with 1013 ("try again
 * later") before any announce is processed. Unlike /metrics, WS connections from loopback are all the
 * same source IP, so the flood + throttle is directly testable on ONE box.
 *
 * Boots the tracker with a tiny capacity, opens N WS connections in sequence, and counts how many the
 * server closes vs keeps open — the first `capacity` stay open, the rest are closed 1013.
 *
 * Usage: node test/trackerratelimit.test.js     (exit 0 = pass, 1 = fail)
 */
import { WebSocket } from "ws";
import { startTracker } from "../server/tracker.js";
// tracker.js reads WS_RATE_* at startTracker() CALL time (not module load), so setting the env here —
// before the call below — takes effect even though the module is import-cached across the suite.
process.env.WS_RATE_CAPACITY = "3";
process.env.WS_RATE_REFILL_PER_SEC = "0"; // no refill during the short test window

const TRK = 8580, MET = 8581;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}

// Open one WS, resolve with how it ended: "closed" (server shut it, incl. 1013) or "open" (still up).
function openWs() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${TRK}`);
    let settled = false;
    const done = (how, code) => { if (!settled) { settled = true; resolve({ how, code }); } };
    ws.on("open", () => {
      // Give the server a beat to close it if over cap, else treat as open.
      setTimeout(() => { if (!settled) { try { ws.close(); } catch { /* ignore */ } done("open"); } }, 300);
    });
    ws.on("close", (code) => done("closed", code));
    ws.on("error", () => done("closed"));
  });
}

(async () => {
  const { tracker, metrics, issuer } = startTracker(TRK, MET);
  await sleep(300);

  console.log("WS connection flood from one IP past cap -> over-cap sockets closed (1013)");
  // Open 6 connections one at a time; first 3 within cap should stay open, next 3 get closed.
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await openWs());
  const closed = results.filter((r) => r.how === "closed").length;
  const opened = results.filter((r) => r.how === "open").length;
  const with1013 = results.filter((r) => r.code === 1013).length;
  checkTrue("some connections stayed open (within cap)", opened >= 1, `opened=${opened} results=${JSON.stringify(results)}`);
  checkTrue("over-cap connections were closed", closed >= 2, `closed=${closed} results=${JSON.stringify(results)}`);
  checkTrue("at least one close used code 1013 (rate limit)", with1013 >= 1, `1013-count=${with1013}`);
  // Bucket store is exposed for inspection; the single loopback IP should have one bucket.
  checkTrue("tracker exposes a wsRateBuckets store with the flooding IP", Object.keys(tracker.wsRateBuckets).length >= 1,
    `keys=${Object.keys(tracker.wsRateBuckets).length}`);

  try { tracker.close(); metrics.close(); issuer.close(); } catch { /* ignore */ }
  delete process.env.WS_RATE_CAPACITY;
  delete process.env.WS_RATE_REFILL_PER_SEC;
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
