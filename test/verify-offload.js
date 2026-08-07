#!/usr/bin/env node
/**
 * verify-offload.js — the real gate for this project.
 *
 * Drives N browser viewers against a running stack and asserts that video bytes
 * actually moved peer-to-peer. A booting server or a playing <video> is NOT proof;
 * only `downloadSource === "p2p"` segments and a non-zero aggregate offload ratio are.
 *
 * Requires all four services up (see README):
 *   origin segmenter + nginx :8080, tracker :8000, metrics :8001, web :5173
 *
 * Usage:
 *   node test/verify-offload.js [--viewers 4] [--watch 90] [--stagger 5] [--headed]
 *
 * Exit codes:
 *   0 = P2P bytes observed (offload > 0)          <- the only pass
 *   1 = stack reachable but no P2P after the watch window
 *   2 = preflight failed (a service is down / viewers never played)
 *
 * Playwright resolution: this repo does not depend on playwright. It is loaded from
 * the playwright-skill install if present, else from a global/parent install. Set
 * PLAYWRIGHT_PATH to override.
 */

const VIEWER_URL = process.env.VIEWER_URL || "http://localhost:5173/index.html";
const STATS_URL = process.env.STATS_URL || "http://localhost:8001/stats";
const PLAYLIST_URL = process.env.PLAYLIST_URL || "http://localhost:8080/hls/stream.m3u8";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const VIEWERS = arg("viewers", 4);
const WATCH_S = arg("watch", 90);
const STAGGER_S = arg("stagger", 5);
const HEADED = process.argv.includes("--headed");

// This package is "type":"module", so there is no bare `require` here. Playwright is a
// CommonJS dep living OUTSIDE this repo, so build a require() bound to this file's URL.
import { createRequire } from "module";
const require = createRequire(import.meta.url);

function loadPlaywright() {
  // Windows USERPROFILE uses backslashes; normalise so require() gets a clean path.
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    "playwright",
    home && `${home}/.claude/skills/playwright-skill/node_modules/playwright`,
  ].filter(Boolean);
  const errs = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { errs.push(`${c}: ${e.code || e.message}`); }
  }
  console.error("FAIL: playwright not resolvable. Tried:");
  errs.forEach((e) => console.error("  " + e));
  console.error("Set PLAYWRIGHT_PATH to a playwright install directory.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1e6).toFixed(1) + "MB";

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function preflight() {
  const checks = [
    ["playlist", PLAYLIST_URL],
    ["viewer", VIEWER_URL],
    ["metrics", STATS_URL],
  ];
  for (const [name, url] of checks) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      console.log(`  ok   ${name} <- ${url}`);
    } catch (e) {
      console.error(`  DOWN ${name} <- ${url} (${e.message})`);
      console.error("\nFAIL(2): stack not up. Start all four services first (see README).");
      process.exit(2);
    }
  }
}

(async () => {
  console.log(`verify-offload: ${VIEWERS} viewers, ${WATCH_S}s watch, ${STAGGER_S}s stagger`);
  console.log("preflight:");
  await preflight();

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  // ONE context for all tabs: they must be able to discover each other via the tracker.
  const ctx = await browser.newContext();
  const pages = [];
  let peerConnects = 0;
  let p2pSegments = 0;
  // Signaling counters. A 0% result means very different things depending on whether the
  // engine ever ASKED for a peer: announces carrying a non-empty offers[] mean it wanted
  // P2P and negotiation failed; announces with offers:[] mean the download scheduler never
  // queued a P2P request in the first place (a window-math problem, not a WebRTC one).
  let announcesWithOffers = 0;
  let announcesNoOffers = 0;
  let answers = 0;
  // Engine-reported faults (notably "offer-failed"), collected across all viewers.
  const engineFaults = [];

  try {
    for (let i = 0; i < VIEWERS; i++) {
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log(`  [tab${i}] pageerror: ${e.message}`));
      page.on("websocket", (ws) => {
        ws.on("framesent", (f) => {
          const s = typeof f.payload === "string" ? f.payload : "";
          if (!s.includes('"announce"')) return;
          if (/"offers":\[\s*\]/.test(s)) announcesNoOffers++;
          else if (s.includes('"offers"')) announcesWithOffers++;
        });
        ws.on("framereceived", (f) => {
          const s = typeof f.payload === "string" ? f.payload : "";
          if (s.includes('"answer"') || s.includes('"offer"')) answers++;
        });
      });
      page.on("console", (m) => {
        const t = m.text();
        if (t.startsWith("P2PSEG")) { p2pSegments++; console.log(`  [tab${i}] ${t}`); }
        if (t.startsWith("P2PPEER")) { peerConnects++; console.log(`  [tab${i}] ${t}`); }
        // The core swallows offer-creation failures into a `warning` event named
        // "offer-failed" and then filters the undefined out of offers[], which is
        // why an empty offers[] otherwise looks like a silent no-op.
        if (t.startsWith("P2PWARN") || t.startsWith("P2PERROR")) {
          engineFaults.push(t);
          console.log(`  [tab${i}] ${t}`);
        }
      });
      await page.goto(VIEWER_URL, { waitUntil: "domcontentloaded" });
      // Hook the engine directly so a P2P segment is impossible to miss or fake.
      await page.evaluate(() => {
        const hls = window.__hls;
        if (!hls || !hls.p2pEngine) { console.log("P2PERR no engine"); return; }
        hls.p2pEngine.addEventListener("onSegmentLoaded", (d) => {
          if (d.downloadSource === "p2p") {
            console.log(`P2PSEG bytes=${d.bytesLength || d.byteLength || 0}`);
          }
        });
        hls.p2pEngine.addEventListener("onPeerConnect", (d) =>
          console.log(`P2PPEER ${d && d.peerId ? d.peerId : ""}`));
        // Surface the core's own diagnostics. "offer-failed" here names exactly why
        // an announce went out with offers:[] instead of leaving it a mystery.
        const fmt = (e) => {
          if (!e) return "";
          const parts = [e.type, e.code, e.message, e.streamType].filter(Boolean);
          return parts.length ? parts.join(" | ") : JSON.stringify(e).slice(0, 200);
        };
        for (const ev of ["error", "warning", "onError", "onWarning"]) {
          try {
            hls.p2pEngine.addEventListener(ev, (e) =>
              console.log(`${ev.toLowerCase().includes("err") ? "P2PERROR" : "P2PWARN"} ${ev}: ${fmt(e)}`));
          } catch { /* engine may not expose this event name */ }
        }
      });
      pages.push(page);
      console.log(`  viewer ${i + 1}/${VIEWERS} joined`);
      // Stagger so earlier viewers have buffered segments a later one can pull.
      if (i < VIEWERS - 1) await sleep(STAGGER_S * 1000);
    }

    // Confirm playback actually started; otherwise a 0% result means nothing.
    await sleep(5000);
    const playing = await Promise.all(pages.map((p) =>
      p.evaluate(() => { const v = document.querySelector("video"); return !!v && v.currentTime > 0; })));
    if (!playing.some(Boolean)) {
      console.error("\nFAIL(2): no viewer ever started playing — cannot judge offload.");
      process.exit(2);
    }
    console.log(`  playback confirmed on ${playing.filter(Boolean).length}/${VIEWERS} viewers`);

    console.log("watching:");
    const deadline = Date.now() + WATCH_S * 1000;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(5000);
      last = await getJson(STATS_URL);
      const pct = Math.round(last.offloadRatio * 100);
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`  viewers=${last.viewers} http=${mb(last.httpBytes)} p2p=${mb(last.p2pBytes)} up=${mb(last.uploadBytes)} offload=${pct}% (${left}s left)`);
      if (last.p2pBytes > 0) break; // proven; no need to keep burning the window
    }

    console.log("\nper-viewer:");
    for (let i = 0; i < pages.length; i++) {
      const v = await pages[i].evaluate(() => ({
        peers: document.getElementById("peers")?.textContent,
        ratio: document.getElementById("ratio")?.textContent,
        p2pd: document.getElementById("p2pd")?.textContent,
        p2pu: document.getElementById("p2pu")?.textContent,
        t: document.querySelector("video")?.currentTime?.toFixed(1),
      }));
      console.log(`  tab${i}: t=${v.t}s peers=${v.peers} offload=${v.ratio} p2pDown=${v.p2pd} p2pUp=${v.p2pu}`);
    }

    const final = last || (await getJson(STATS_URL));
    const pct = Math.round(final.offloadRatio * 100);
    console.log(`\nsegments via p2p: ${p2pSegments} | peer connects: ${peerConnects}`);
    console.log(`signaling: announces with offers=${announcesWithOffers}, with offers:[]=${announcesNoOffers}, offer/answer frames received=${answers}`);
    console.log(`engine faults: ${engineFaults.length}${engineFaults.length ? ` (first: ${engineFaults[0]})` : ""}`);
    console.log(`aggregate offload: ${pct}% (p2p=${mb(final.p2pBytes)} http=${mb(final.httpBytes)})`);

    if (final.p2pBytes > 0 && p2pSegments > 0) {
      console.log("\nPASS: real peer-to-peer bytes observed.");
      process.exitCode = 0;
    } else {
      console.log("\nFAIL(1): no P2P bytes in the watch window. Offload is unproven.");
      if (announcesWithOffers === 0) {
        console.log("  DIAGNOSIS: every announce carried offers:[] — no WebRTC offer was ever");
        console.log("  generated, so no peer can connect, and with zero connected peers no");
        console.log("  segment is P2P-eligible (isSegmentLoadingOrLoadedBySomeone). Deadlock.");
        const offerFailed = engineFaults.filter((f) => f.includes("offer-failed"));
        if (offerFailed.length) {
          console.log(`  CAUSE: ${offerFailed.length} offer-failed warning(s) from the core:`);
          console.log(`    ${offerFailed[0]}`);
        } else {
          console.log("  No offer-failed warning was emitted, so offer creation was never even");
          console.log("  attempted — suspect shouldGenerateOffers()/offersCount() or that the");
          console.log("  tracker client never reached the 'connected' WS state before announcing.");
        }
      } else if (peerConnects === 0) {
        console.log(`  DIAGNOSIS: ${announcesWithOffers} announces DID carry offers but no peer`);
        console.log("  connected — this is signaling/WebRTC negotiation, not window math.");
        console.log("  Check the tracker relays offers to other peers and STUN reachability.");
      } else {
        console.log("  DIAGNOSIS: peers connected but served no segments — check that a peer");
        console.log("  actually holds the wanted segment (buffer overlap) and upload is enabled.");
      }
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
