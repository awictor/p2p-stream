#!/usr/bin/env node
/**
 * verify-swarm.js — synthetic N-peer LOAD generator (P2P-0086, iter 155).
 *
 * SWARM-SCALE RESILIENCE milestone. Drives N simulated peers in ONE node process against a booted
 * tracker (WS signaling) + metrics (:POST /metrics, GET /stats): N WS announces + N distinct
 * /metrics reports, then reads /stats and asserts the stack held.
 *
 * THIS IS SERVER LOAD ON ONE BOX — NOT a WebRTC mesh, NOT an offload % claim, NOT a cross-network
 * result (HARD RULE 2). It measures whether the SERVERS survive N clients and aggregate correctly;
 * it says nothing about real P2P byte transfer. Every figure here is loopback server-load only.
 *
 * Asserts:
 *   - the tracker still answers an announce AFTER the flood (not crashed/hung),
 *   - /stats.tracked reflects the injected clients (up to MAX_CLIENTS),
 *   - /stats byte sums equal exactly what was injected.
 *
 * Usage: node test/verify-swarm.js [N]     (default N=100; exit 0 = pass, 1 = fail)
 */
import { WebSocket } from "ws";
import { Server } from "bittorrent-tracker";
import { startMetrics } from "../server/metrics.js";

const N = Number(process.argv[2]) || 100;
const T_PORT = 8551;
const M_PORT = 8552;
const INFO_HASH = "swarmloadhash0000000"; // must be exactly 20 chars (bittorrent-tracker wants 20 bytes)
const HTTP_PER = 1000;   // injected httpBytes per synthetic peer
const P2P_PER = 3000;    // injected p2pBytes per synthetic peer
const ANNOUNCE_TIMEOUT_MS = 10000; // a peer that never gets a response by now counts as failed, not hung

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

// One synthetic tracker announce (a seeder: left:0, no offers). Resolves {ws, ok} where ok=true
// once the tracker returns a valid announce response (not a failure frame) — so a bad-hash / hung
// tracker under load is caught, not silently passed as "socket opened".
function announce(peerId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${T_PORT}`);
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ws, ok }); };
    // A HANG is exactly the load failure this harness exists to catch — but it must FAIL the run,
    // not hang it. Under N slow announces a response can lag, so the ceiling is generous; a peer
    // that produces neither an announce nor a failure frame in time counts as ok=false (not hung).
    // Never rejects: a rejected promise in Promise.all would abort the whole flood on one bad socket.
    const timer = setTimeout(() => done(false), ANNOUNCE_TIMEOUT_MS);
    ws.on("error", () => done(false));
    ws.on("message", (m) => {
      try {
        const j = JSON.parse(m.toString());
        if (j["failure reason"]) done(false);
        else if (j.action === "announce") done(true);
      } catch { /* ignore non-JSON */ }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({
        action: "announce", info_hash: INFO_HASH, peer_id: peerId,
        numwant: 0, uploaded: 0, downloaded: 0, left: 0, event: "started", offers: [],
      }));
    });
  });
}

const post = (body) => fetch(`http://localhost:${M_PORT}/metrics`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const stats = () => fetch(`http://localhost:${M_PORT}/stats`).then((r) => r.json());

(async () => {
  console.log(`SWARM LOAD — N=${N} synthetic peers (SERVER LOAD, loopback; NOT an offload/mesh/cross-network number)`);

  const tracker = new Server({ udp: false, http: false, ws: true, stats: false });
  await new Promise((r) => tracker.listen(T_PORT, r));
  const metrics = startMetrics(M_PORT);
  await sleep(300);

  const rssStart = process.memoryUsage().rss;

  // FLOOD: N tracker announces + N metrics reports, concurrently. Each /metrics POST is timed
  // individually (P2P-0087) so we can report a mean per-report latency alongside peak memory.
  const sockets = [];
  let announceOk = 0;
  const announces = [];
  const posts = [];
  const latencies = [];
  for (let i = 0; i < N; i++) {
    const pid = `swarm-peer-${i.toString(16).padStart(16, "0")}`.slice(0, 20);
    announces.push(announce(pid).then(({ ws, ok }) => { sockets.push(ws); if (ok) announceOk++; }).catch(() => { /* dropped WS caught by the count below */ }));
    const t0 = performance.now();
    posts.push(post({ clientId: `swarm-${i}`, peerId: pid, httpBytes: HTTP_PER, p2pBytes: P2P_PER, uploadBytes: 0 })
      .then(() => { latencies.push(performance.now() - t0); }).catch(() => {}));
  }
  await Promise.all([...announces, ...posts]);
  await sleep(500); // let the tracker + aggregator settle

  // MEASUREMENT (P2P-0087). Peak RSS delta over the flood + mean /metrics report latency. This is
  // SERVER LOAD on loopback with N synthetic peers — it is NOT a browser, offload, or cross-network
  // number, and must never be quoted as one (HARD RULE 2). Extrapolate the per-peer memory linearly
  // only with that caveat attached.
  const rssPeak = process.memoryUsage().rss;
  const rssDeltaMB = (rssPeak - rssStart) / 1e6;
  const perPeerKB = latencies.length ? ((rssPeak - rssStart) / latencies.length) / 1e3 : 0;
  const meanLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : NaN;
  console.log(`\nMEASURE (server-load, loopback, N=${N} synthetic peers — NOT a browser/offload/cross-network number):`);
  console.log(`  peak RSS delta over flood: ${rssDeltaMB.toFixed(1)} MB  (~${perPeerKB.toFixed(1)} KB/peer, linear extrapolation only)`);
  console.log(`  mean /metrics report latency: ${meanLatencyMs.toFixed(2)} ms over ${latencies.length} reports`);

  console.log(`\nall ${N} announces + reports sent; assert the stack held`);
  check(`all ${N} announces got a valid tracker response (not failure/hang)`, announceOk, N);

  // The tracker still answers a FRESH announce after the flood (proves not crashed/hung).
  let aliveAnn = null;
  const probe = new WebSocket(`ws://localhost:${T_PORT}`);
  const got = new Promise((resolve) => {
    probe.on("message", (m) => { try { const j = JSON.parse(m.toString()); if (j.action === "announce") { aliveAnn = j; resolve(); } } catch { /* ignore */ } });
  });
  await new Promise((r) => probe.on("open", r));
  probe.send(JSON.stringify({ action: "announce", info_hash: INFO_HASH, peer_id: "probe-after-flood-01", numwant: 0, uploaded: 0, downloaded: 0, left: 0, event: "started", offers: [] }));
  await Promise.race([got, sleep(2000)]);
  checkTrue("tracker still answers an announce AFTER the flood (not crashed/hung)", aliveAnn !== null);

  // /stats aggregated the N clients correctly.
  const s = await stats();
  check(`/stats.tracked reflects the ${N} injected clients`, s.tracked, Math.min(N, s.maxClients));
  check("httpBytes sum == N * per-peer", s.httpBytes, N * HTTP_PER);
  check("p2pBytes sum == N * per-peer", s.p2pBytes, N * P2P_PER);
  checkTrue("tracked did not exceed the MAX_CLIENTS ceiling", s.tracked <= s.maxClients);

  // The measurement itself must be REAL, not a silent NaN/0 (P2P-0087): a latency was recorded for
  // every accepted report, and RSS is a finite positive figure.
  check("a latency sample was recorded for every report", latencies.length, N);
  checkTrue("mean report latency is a finite number", Number.isFinite(meanLatencyMs));
  checkTrue("peak RSS is a finite positive figure", Number.isFinite(rssPeak) && rssPeak > 0);

  for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
  try { probe.close(); } catch { /* ignore */ }
  try { metrics.close(); } catch { /* ignore */ }
  try { tracker.close(); } catch { /* ignore */ }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error("ERROR:", e.stack || e.message);
  process.exitCode = 1;
});
