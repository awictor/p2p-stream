#!/usr/bin/env node
/**
 * metrics.test.js — unit test for the offload aggregation in server/metrics.js.
 *
 * This is the arithmetic the entire project's claim rests on, so it gets exact
 * assertions rather than smoke checks. Boots the real Express app on an ephemeral
 * port and drives it over HTTP (no mocks) so the JSON contract is covered too.
 *
 * Usage: node test/metrics.test.js     (exit 0 = pass, 1 = fail)
 */
import { startMetrics } from "../server/metrics.js";

const PORT = Number(process.env.METRICS_TEST_PORT || 8123);
const BASE = `http://localhost:${PORT}`;
const STALE_MS = 15000; // must match server/metrics.js

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}
function checkClose(name, actual, expected, eps = 1e-9) {
  const ok = Math.abs(actual - expected) < eps;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}

const post = (body) =>
  fetch(`${BASE}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const stats = () => fetch(`${BASE}/stats`).then((r) => r.json());

// Fixed base timestamp — never Date.now(), so the stale-window maths is deterministic.
const T = 1_700_000_000_000;

(async () => {
  startMetrics(PORT);
  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  console.log("empty state:");
  {
    const s = await stats();
    check("viewers is 0", s.viewers, 0);
    check("httpBytes is 0", s.httpBytes, 0);
    check("offloadRatio is 0 (no divide-by-zero)", s.offloadRatio, 0);
  }

  console.log("\nrejects a report with no clientId:");
  {
    const r = await post({ httpBytes: 1, p2pBytes: 1, ts: T });
    check("HTTP 400", r.status, 400);
    const s = await stats();
    check("viewers still 0", s.viewers, 0);
  }

  console.log("\ntwo viewers, 300 http + 1700 p2p => 85% offload:");
  {
    await post({ clientId: "a", httpBytes: 100, p2pBytes: 900, uploadBytes: 50, ts: T });
    await post({ clientId: "b", httpBytes: 200, p2pBytes: 800, uploadBytes: 40, ts: T });
    const s = await stats();
    check("viewers", s.viewers, 2);
    check("httpBytes summed", s.httpBytes, 300);
    check("p2pBytes summed", s.p2pBytes, 1700);
    check("uploadBytes summed", s.uploadBytes, 90);
    checkClose("offloadRatio", s.offloadRatio, 0.85);
  }

  console.log("\nreports are cumulative snapshots, NOT deltas (same id overwrites):");
  {
    await post({ clientId: "a", httpBytes: 150, p2pBytes: 950, uploadBytes: 60, ts: T });
    const s = await stats();
    check("viewers unchanged", s.viewers, 2);
    check("httpBytes replaced not added", s.httpBytes, 350);
    check("p2pBytes replaced not added", s.p2pBytes, 1750);
  }

  console.log("\nstale viewer drops out of the active count but keeps contributing bytes:");
  {
    // 'c' reported far in the past; 'a'/'b' are the newest, so c is beyond STALE_MS.
    await post({ clientId: "c", httpBytes: 10, p2pBytes: 90, uploadBytes: 5, ts: T - STALE_MS - 1 });
    const s = await stats();
    check("stale viewer not counted active", s.viewers, 2);
    check("but its httpBytes still counted", s.httpBytes, 360);
    check("and its p2pBytes still counted", s.p2pBytes, 1840);
  }

  console.log("\nexactly at the stale boundary is still active (> not >=):");
  {
    await post({ clientId: "d", httpBytes: 0, p2pBytes: 0, ts: T - STALE_MS });
    const s = await stats();
    check("boundary viewer counted active", s.viewers, 3);
  }

  console.log("\n100% and 0% offload edges:");
  {
    const p = Number(process.env.METRICS_TEST_PORT2 || 8124);
    startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b2 = `http://localhost:${p}`;
    const post2 = (body) => fetch(`${b2}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await post2({ clientId: "allp2p", httpBytes: 0, p2pBytes: 500, ts: T });
    let s = await fetch(`${b2}/stats`).then((r) => r.json());
    check("all-p2p is 100%", s.offloadRatio, 1);
    await post2({ clientId: "allhttp", httpBytes: 500, p2pBytes: 0, ts: T });
    s = await fetch(`${b2}/stats`).then((r) => r.json());
    checkClose("half and half is 50%", s.offloadRatio, 0.5);
  }

  console.log("\nmalformed numeric fields coerce to 0 instead of NaN-poisoning the totals:");
  {
    const p = Number(process.env.METRICS_TEST_PORT3 || 8125);
    startMetrics(p);
    await new Promise((r) => setTimeout(r, 400));
    const b3 = `http://localhost:${p}`;
    await fetch(`${b3}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "bad", httpBytes: "abc", p2pBytes: null, ts: T }),
    });
    await fetch(`${b3}/metrics`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "good", httpBytes: 100, p2pBytes: 300, ts: T }),
    });
    const s = await fetch(`${b3}/stats`).then((r) => r.json());
    check("httpBytes not NaN", Number.isFinite(s.httpBytes), true);
    check("httpBytes ignores garbage", s.httpBytes, 100);
    checkClose("offloadRatio still correct", s.offloadRatio, 0.75);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
