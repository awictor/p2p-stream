#!/usr/bin/env node
/**
 * verify-offload.js — the real gate for this project.
 *
 * Drives N browser viewers against a running stack and asserts that video bytes
 * actually moved peer-to-peer. A booting server or a playing <video> is NOT proof;
 * only `downloadSource === "p2p"` segments and a non-zero aggregate offload ratio are.
 *
 * It also reports the COST side — rebuffers, stall seconds, latency behind the live edge,
 * and upload bytes per viewer — printed immediately after the offload figure. A savings
 * number must never appear without what the relaying viewer paid for it.
 *
 * Requires all four services up (see README):
 *   origin segmenter + nginx :8080, tracker :8000, metrics :8001, web :5173
 *
 * Usage:
 *   node test/verify-offload.js [--viewers 4] [--watch 90] [--stagger 5] [--headed]
 *   node test/verify-offload.js --sweep 1,2,4,8 [--watch 45]
 *   node test/verify-offload.js --control [--watch 45]
 *
 * --control runs the SAME scenario twice — once with P2P on, once with `?p2p=off` — and
 * prints the two arms side by side. This exists because a QoE number with no baseline is
 * an anecdote: "0 stalls with P2P" only means something if we know what this stack does
 * WITHOUT P2P. The off arm doubles as a check that the flag really disables P2P; if it
 * still shows offload, the comparison is meaningless and the run fails loudly (exit 2)
 * rather than quietly reporting two identical P2P-on runs as a comparison.
 *
 * --sweep runs the harness once per viewer count and prints a N -> offload% table, which
 * is the economic claim (offload should RISE with swarm size). Two differences from a
 * single run, both necessary for the number to mean anything:
 *   1. It does NOT stop at the first P2P byte. A single run may exit early once offload is
 *      proven, which samples the ratio at its lowest; a curve needs the full window.
 *   2. It measures DELTAS of the /stats counters around each run. The metrics server never
 *      evicts clients (see P2P-0010), so raw totals carry over between runs and would make
 *      every later N look better than it is.
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
const CONTROL = process.argv.includes("--control");

// --sweep 1,2,4,8 -> run once per count and print the offload-vs-N curve.
const sweepArg = (() => {
  const i = process.argv.indexOf("--sweep");
  if (i === -1) return null;
  const raw = process.argv[i + 1];
  if (!raw || raw.startsWith("--")) return [1, 2, 4, 8];
  const ns = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ns.length ? ns : null;
})();

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

// One measured run at a given viewer count. `stopEarly` short-circuits as soon as any P2P
// byte appears (right for a pass/fail gate, wrong for measuring a ratio). Returns a summary
// so the sweep can tabulate; also sets process.exitCode for single-run use.
async function runOnce({ viewers = VIEWERS, watchS = WATCH_S, staggerS = STAGGER_S, stopEarly = true, p2p = true } = {}) {
  const VIEWERS = viewers;
  const WATCH_S = watchS;
  const STAGGER_S = staggerS;
  // The control arm is the same page with one query param, so both arms exercise the same
  // player, the same origin and the same metrics path. Built via URL so an existing query
  // string on VIEWER_URL survives instead of being clobbered by a naive "?p2p=off".
  const url = new URL(VIEWER_URL);
  if (!p2p) url.searchParams.set("p2p", "off");
  const pageUrl = url.toString();
  console.log(`verify-offload: ${VIEWERS} viewers, ${WATCH_S}s watch, ${STAGGER_S}s stagger, p2p=${p2p ? "ON" : "OFF"}`);
  console.log("preflight:");
  await preflight();

  // Snapshot the counters first: the metrics server never evicts clients, so totals carry
  // over between runs and only the delta describes THIS run.
  const before = await getJson(STATS_URL);

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
  let summary = null;

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
      await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
      // Hook the engine directly so a P2P segment is impossible to miss or fake.
      await page.evaluate(() => {
        // QoE (cost side): a savings figure means nothing without what the viewer paid.
        // Stalls come from the <video> element's own `waiting`/`playing` events rather
        // than from engine stats, because that is what a human actually experiences —
        // the engine can be happily fetching while the picture is frozen.
        const v = document.querySelector("video");
        window.__qoe = { stalls: 0, stallMs: 0, _t0: null };
        if (v) {
          v.addEventListener("waiting", () => {
            // Ignore the initial buffering before playback ever starts; that is startup
            // latency, not a rebuffer, and counting it would inflate every run by one.
            if (v.currentTime > 0) { window.__qoe.stalls++; window.__qoe._t0 = performance.now(); }
          });
          const resume = () => {
            if (window.__qoe._t0 != null) {
              window.__qoe.stallMs += performance.now() - window.__qoe._t0;
              window.__qoe._t0 = null;
            }
          };
          v.addEventListener("playing", resume);
          v.addEventListener("timeupdate", resume);
        }
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

    // Assert the arm is the arm we asked for. A control run that silently left P2P on
    // would produce a meaningless comparison that still LOOKS like a comparison, which is
    // worse than no baseline at all.
    const armFlags = await Promise.all(pages.map((p) => p.evaluate(() => window.__p2pEnabled)));
    const wrongArm = armFlags.filter((f) => f !== p2p).length;
    if (wrongArm) {
      console.error(`\nFAIL(2): ${wrongArm}/${armFlags.length} viewers reported p2pEnabled=${armFlags[0]}, expected ${p2p}.`);
      console.error("  The ?p2p=off flag did not take effect, so this arm is not what it claims.");
      process.exit(2);
    }
    console.log(`  arm confirmed: p2pEnabled=${p2p} on all ${armFlags.length} viewers`);

    console.log("watching:");
    const deadline = Date.now() + WATCH_S * 1000;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(5000);
      last = await getJson(STATS_URL);
      const pct = Math.round(last.offloadRatio * 100);
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`  viewers=${last.viewers} http=${mb(last.httpBytes)} p2p=${mb(last.p2pBytes)} up=${mb(last.uploadBytes)} offload=${pct}% (${left}s left)`);
      // Only a pass/fail gate may exit here. A sweep must burn the whole window or it
      // samples the ratio at its lowest point and understates every N.
      if (stopEarly && last.p2pBytes > 0) break;
    }

    console.log("\nper-viewer:");
    const qoe = [];
    for (let i = 0; i < pages.length; i++) {
      const v = await pages[i].evaluate(() => {
        const vid = document.querySelector("video");
        const h = window.__hls;
        const q = window.__qoe || { stalls: 0, stallMs: 0 };
        // Latency behind the live edge, straight from hls.js (null for VOD, which has no edge).
        const latency = h && typeof h.latency === "number" ? +h.latency.toFixed(1) : null;
        const buffered = vid && vid.buffered.length
          ? +(vid.buffered.end(vid.buffered.length - 1) - vid.currentTime).toFixed(1) : 0;
        // Per-segment ledger: fetch EVENTS vs distinct segment URLs. This is what attributes
        // the total-byte gap between arms instead of leaving it to a plausible story.
        const led = typeof window.__ledger === "function" ? window.__ledger() : null;
        return {
          peers: document.getElementById("peers")?.textContent,
          ratio: document.getElementById("ratio")?.textContent,
          p2pd: document.getElementById("p2pd")?.textContent,
          p2pu: document.getElementById("p2pu")?.textContent,
          t: vid?.currentTime?.toFixed(1),
          stalls: q.stalls, stallMs: Math.round(q.stallMs), latency, buffered,
          led,
          // Video-seconds this viewer actually HOLDS (played + still buffered). The
          // denominator for amplification: bytes fetched per second of video obtained.
          // Derived from the media element, never from a byte count, so the two sides of the
          // ratio are independent measurements.
          heldS: +((vid?.currentTime || 0) + buffered).toFixed(1),
        };
      });
      qoe.push(v);
      console.log(`  tab${i}: t=${v.t}s peers=${v.peers} offload=${v.ratio} p2pDown=${v.p2pd} p2pUp=${v.p2pu}`);
      console.log(`         stalls=${v.stalls} (${(v.stallMs / 1000).toFixed(1)}s) latency=${v.latency ?? "n/a"}s buffer=${v.buffered}s`);
      if (v.led) {
        const dup = v.led.fetches - v.led.unique;
        console.log(`         segments: ${v.led.fetches} fetches / ${v.led.unique} unique` +
          ` = ${v.led.unique ? (v.led.fetches / v.led.unique).toFixed(2) : "n/a"}x` +
          (dup > 0 ? `  DUPLICATES: ${dup} (${mb(v.led.dupBytes)}, ${v.led.crossTransport} cross-transport)` : "  no duplicates"));
      }
    }

    const final = last || (await getJson(STATS_URL));
    const pct = Math.round(final.offloadRatio * 100);
    // Delta-based ratio: what THIS run contributed, ignoring counters left by earlier runs.
    const dHttp = Math.max(0, final.httpBytes - before.httpBytes);
    const dP2p = Math.max(0, final.p2pBytes - before.p2pBytes);
    const dUp = Math.max(0, final.uploadBytes - before.uploadBytes);
    const dTotal = dHttp + dP2p;
    const dPct = dTotal ? Math.round((dP2p / dTotal) * 100) : 0;
    console.log(`\nsegments via p2p: ${p2pSegments} | peer connects: ${peerConnects}`);
    console.log(`signaling: announces with offers=${announcesWithOffers}, with offers:[]=${announcesNoOffers}, offer/answer frames received=${answers}`);
    console.log(`engine faults: ${engineFaults.length}${engineFaults.length ? ` (first: ${engineFaults[0]})` : ""}`);
    console.log(`aggregate offload: ${pct}% cumulative (p2p=${mb(final.p2pBytes)} http=${mb(final.httpBytes)})`);
    console.log(`this run only:    ${dPct}% (p2p=${mb(dP2p)} http=${mb(dHttp)} up=${mb(dUp)})`);

    // THE COST SIDE. Printed immediately after the savings so the two are never separated:
    // "79% cheaper" is not a shippable claim until it reads "and playback was no worse".
    const totalStalls = qoe.reduce((a, v) => a + v.stalls, 0);
    const totalStallS = qoe.reduce((a, v) => a + v.stallMs, 0) / 1000;
    const lats = qoe.map((v) => v.latency).filter((x) => typeof x === "number");
    const avgLat = lats.length ? (lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1) : "n/a";
    const upPerViewer = qoe.length ? dUp / qoe.length : 0;
    console.log(`QoE (cost):       stalls=${totalStalls} total (${totalStallS.toFixed(1)}s) across ${qoe.length} viewers` +
      `, avg latency=${avgLat}s, upload/viewer=${mb(upPerViewer)}`);
    if (totalStalls === 0) {
      console.log(`                  no rebuffering observed — offload came at no visible playback cost`);
    } else {
      console.log(`                  ^ ${totalStalls} rebuffer(s): report this WITH the offload figure, never without`);
    }

    // Segment ledger across all viewers. `fetches/unique` > 1 means some segment was delivered
    // more than once; == 1 means every delivery was a distinct segment and the extra bytes in
    // the P2P arm are real distinct data rather than a duplicate or a double-count.
    const led = qoe.map((v) => v.led).filter(Boolean);
    const ledger = led.length ? {
      fetches: led.reduce((a, l) => a + l.fetches, 0),
      unique: led.reduce((a, l) => a + l.unique, 0),
      dupFetches: led.reduce((a, l) => a + l.dupFetches, 0),
      played: led.reduce((a, l) => a + (l.played || 0), 0),
      pending: led.reduce((a, l) => a + (l.pending || 0), 0),
      wasted: led.reduce((a, l) => a + (l.wasted || 0), 0),
      wastedBytes: led.reduce((a, l) => a + (l.wastedBytes || 0), 0),
      noTiming: led.reduce((a, l) => a + (l.noTiming || 0), 0),
      dupBytes: led.reduce((a, l) => a + l.dupBytes, 0),
      crossTransport: led.reduce((a, l) => a + l.crossTransport, 0),
    } : null;
    // Video-seconds obtained across viewers, and bytes fetched per second of it. Amplification
    // is bytes-fetched ÷ bytes-needed, where "needed" comes from the media element's own
    // timeline — NOT from buffer depth, which is exactly what made the prefetch theory look
    // right at iter 25 when it was wrong.
    const heldS = qoe.reduce((a, v) => a + (v.heldS || 0), 0);
    const bytesPerVideoS = heldS ? (dHttp + dP2p) / heldS : 0;
    if (ledger) {
      const ratio = ledger.unique ? ledger.fetches / ledger.unique : 0;
      console.log(`segment ledger:   ${ledger.fetches} fetches / ${ledger.unique} unique = ${ratio.toFixed(2)}x` +
        `, duplicates ${ledger.dupFetches} (${mb(ledger.dupBytes)}), cross-transport ${ledger.crossTransport}`);
      console.log(`video obtained:   ${heldS.toFixed(1)}s across ${qoe.length} viewers` +
        ` -> ${(bytesPerVideoS / 1e3).toFixed(0)} KB per video-second`);
      // Played vs never-played. This is the count that says whether the amplification is
      // WASTE (fetched, never rendered — tunable) or merely READ-AHEAD the viewer went on to
      // watch (inherent, and no window value fixes it).
      // played / pending / wasted. `pending` = ahead of the playhead but BUFFERED, so it would
      // have been played had the run not been cut off — truncation, not cost. Only `wasted`
      // (fetched, never appended to the media buffer) is real waste.
      const timed = ledger.played + ledger.pending + ledger.wasted;
      console.log(`segment fate:     ${ledger.played} played / ${ledger.pending} buffered-pending` +
        ` / ${ledger.wasted} wasted` +
        (timed ? ` = ${Math.round((ledger.wasted / timed) * 100)}% wasted` : "") +
        ` (${mb(ledger.wastedBytes)})` +
        (ledger.noTiming ? `, ${ledger.noTiming} untimed (excluded)` : ""));
    }

    summary = {
      viewers: VIEWERS, offloadPct: dPct, p2pBytes: dP2p, httpBytes: dHttp, uploadBytes: dUp,
      p2pSegments, peerConnects, pass: dP2p > 0 && p2pSegments > 0,
      // Cost side, carried out so --control can tabulate the two arms against each other.
      p2p, stalls: totalStalls, stallS: +totalStallS.toFixed(1), avgLatency: avgLat,
      upPerViewer, ledger, heldS, bytesPerVideoS,
    };

    // Conservation check: every byte downloaded FROM a peer was uploaded BY a peer, so in a
    // closed local swarm p2pUp should track p2pDown. This is the cheapest guard against the
    // accounting silently breaking again — p2pUp read a flat 0 B for two iterations because
    // the viewer listened on a nonexistent "onSegmentUploaded" event. Reported, not asserted:
    // a viewer can leave mid-run and take its counters with it, so exact equality is wrong.
    if (dP2p > 0) {
      const ratio = dUp / dP2p;
      const skew = Math.round(Math.abs(1 - ratio) * 100);
      console.log(`upload conservation: up/down = ${ratio.toFixed(2)} (${skew}% skew)` +
        (dUp === 0 ? "  <-- SUSPECT: nobody uploaded the bytes someone downloaded"
                   : skew > 25 ? "  <-- check for viewers leaving mid-run" : "  ok"));
    }

    // The control arm is EXPECTED to show no P2P bytes, so the pass/fail verdict below
    // would be exactly inverted for it. --control judges it itself (0% is the sanity check
    // that the flag worked); here we just report and leave the exit code alone.
    if (!p2p) {
      console.log(`\ncontrol arm (p2p=off): ${dPct}% offload, ${p2pSegments} p2p segments — 0 is the expected result.`);
    } else if (final.p2pBytes > 0 && p2pSegments > 0) {
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
  return summary;
}

// --control: same scenario, P2P on vs P2P off, printed side by side. Both arms burn the
// full watch window (stopEarly:false) or the on arm would exit at its first P2P byte and
// the two arms would cover different amounts of playback, making every column
// incomparable.
async function runControl() {
  console.log(`CONTROL: ${VIEWERS} viewers, ${WATCH_S}s watch — P2P ON vs P2P OFF\n`);
  console.log(`${"=".repeat(60)}\n=== ARM 1/2: P2P ON\n${"=".repeat(60)}`);
  const on = await runOnce({ stopEarly: false, p2p: true });
  await sleep(3000); // let the previous arm's viewers age out of the active count
  console.log(`\n${"=".repeat(60)}\n=== ARM 2/2: P2P OFF (control)\n${"=".repeat(60)}`);
  const off = await runOnce({ stopEarly: false, p2p: false });

  if (!on || !off) {
    console.error("\nFAIL(2): an arm did not complete; nothing to compare.");
    process.exit(2);
  }

  const row = (label, a, b) => console.log(`| ${label.padEnd(20)} | ${String(a).padStart(12)} | ${String(b).padStart(12)} |`);
  console.log(`\n${"=".repeat(60)}\nP2P ON vs OFF\n${"=".repeat(60)}`);
  console.log(`| ${"metric".padEnd(20)} | ${"P2P ON".padStart(12)} | ${"P2P OFF".padStart(12)} |`);
  console.log(`|${"-".repeat(22)}|${"-".repeat(14)}|${"-".repeat(14)}|`);
  row("offload", on.offloadPct + "%", off.offloadPct + "%");
  row("origin bytes", mb(on.httpBytes), mb(off.httpBytes));
  row("p2p bytes", mb(on.p2pBytes), mb(off.p2pBytes));
  // Total fetched is NOT the same across arms and hiding that would flatter P2P. Origin egress
  // still falls, which is the bill that matters — but "total bytes moved" goes UP, and a reader
  // deserves to see it. The CAUSE is attributed below from the segment ledger, not guessed:
  // an earlier iteration blamed prefetch, which the identical buffer depths refuted.
  row("total fetched", mb(on.httpBytes + on.p2pBytes), mb(off.httpBytes + off.p2pBytes));
  // Normalise by video actually obtained. The arms rarely hold exactly the same number of
  // video-seconds, and comparing raw totals across unequal denominators is how a fetch gap gets
  // misattributed — at iter 25 the two arms happened to match, which made the raw comparison
  // look safe. Per-video-second is the comparison that stays valid when they don't.
  row("video obtained", `${(on.heldS || 0).toFixed(0)}s`, `${(off.heldS || 0).toFixed(0)}s`);
  row("KB / video-sec", (on.bytesPerVideoS / 1e3).toFixed(0), (off.bytesPerVideoS / 1e3).toFixed(0));
  if (on.ledger && off.ledger) {
    const r = (l) => (l.unique ? (l.fetches / l.unique).toFixed(2) + "x" : "n/a");
    row("fetches / unique", r(on.ledger), r(off.ledger));
    row("duplicate segs", `${on.ledger.dupFetches} (${mb(on.ledger.dupBytes)})`,
      `${off.ledger.dupFetches} (${mb(off.ledger.dupBytes)})`);
    const waste = (l) => {
      const timed = l.played + l.pending + l.wasted;
      return timed ? `${l.wasted} (${Math.round((l.wasted / timed) * 100)}%)` : "n/a";
    };
    row("segs played", on.ledger.played, off.ledger.played);
    row("buffered-pending", on.ledger.pending, off.ledger.pending);
    row("wasted segs", waste(on.ledger), waste(off.ledger));
    row("wasted MB", mb(on.ledger.wastedBytes), mb(off.ledger.wastedBytes));
  }
  row("upload/viewer", mb(on.upPerViewer), mb(off.upPerViewer));
  row("stalls", `${on.stalls} (${on.stallS}s)`, `${off.stalls} (${off.stallS}s)`);
  row("avg latency", on.avgLatency + "s", off.avgLatency + "s");
  row("peer connects", on.peerConnects, off.peerConnects);

  // The whole point of the control arm: attribute (or refuse to attribute) the QoE result.
  const dStalls = on.stalls - off.stalls;
  // Quote the MEASURED origin reduction, not the offload ratio — they are different numbers
  // and the ratio is the larger, flattering one (see the note below the table).
  const savedPctForClaim = off.httpBytes > 0
    ? Math.round(((off.httpBytes - on.httpBytes) / off.httpBytes) * 100) : null;
  console.log("\ninterpretation:");
  if (on.stalls === 0 && off.stalls === 0) {
    console.log(`  Both arms rebuffered ZERO times, so the zero-stall result is NOT attributable`);
    console.log(`  to P2P — it is how this stack plays video here. The honest claim is`);
    console.log(`  "P2P cut origin bytes by ${savedPctForClaim ?? "?"}% without introducing rebuffering",`);
    console.log(`  NOT "P2P improved playback". Playback was already clean.`);
  } else if (dStalls > 0) {
    console.log(`  P2P rebuffered ${dStalls} MORE time(s) than the control — offload is costing`);
    console.log(`  playback quality. Report this WITH the ${on.offloadPct}% figure, never without.`);
  } else {
    console.log(`  P2P rebuffered ${-dStalls} FEWER time(s) than the control. Suggestive, but one`);
    console.log(`  run each is not a trend — repeat before claiming P2P improves playback.`);
  }
  // The headline economic claim: the control arm's origin bytes are the bill WITHOUT P2P,
  // so this subtraction is the only direct measurement of what a platform stops paying for.
  const savedBytes = off.httpBytes - on.httpBytes;
  if (off.httpBytes === 0) {
    console.log(`  origin comparison UNAVAILABLE: the control arm counted 0 bytes (see FAIL below).`);
  } else if (savedBytes > 0) {
    const savedPct = Math.round((savedBytes / off.httpBytes) * 100);
    console.log(`  origin served ${mb(savedBytes)} less with P2P on (${mb(off.httpBytes)} -> ${mb(on.httpBytes)}, -${savedPct}%).`);
    console.log(`  That subtraction — not the offload ratio — is the bill a platform stops paying.`);
    if (savedPct < on.offloadPct) {
      console.log(`  NOTE: the real saving (-${savedPct}%) is SMALLER than the ${on.offloadPct}% offload ratio,`);
      console.log(`  because the P2P arm fetched more total bytes. Quote -${savedPct}%, not ${on.offloadPct}%.`);
    }
  }

  // ATTRIBUTE the total-byte gap. This is the whole point of the segment ledger: the same byte
  // total can come from a duplicate fetch, a double-counted event, or genuinely more distinct
  // segments, and those are three different bugs (or one non-bug).
  if (on.ledger && off.ledger) {
    const onAmp = on.ledger.unique ? on.ledger.fetches / on.ledger.unique : 0;
    const offAmp = off.ledger.unique ? off.ledger.fetches / off.ledger.unique : 0;
    const onKB = on.bytesPerVideoS / 1e3, offKB = off.bytesPerVideoS / 1e3;
    const perSecGap = offKB > 0 ? onKB / offKB : 0;
    console.log("\nwhere the extra bytes went:");
    if (on.ledger.dupFetches > 0) {
      console.log(`  ${on.ledger.dupFetches} segment(s) were delivered MORE THAN ONCE with P2P on` +
        ` (${mb(on.ledger.dupBytes)}), ${on.ledger.crossTransport} of them over both transports.`);
      console.log(`  Cross-transport duplicates mean HTTP and P2P raced the same segment — real`);
      console.log(`  wasted bandwidth. Same-transport repeats point at a refetch or a double-count.`);
    } else {
      console.log(`  NO duplicate deliveries (${onAmp.toFixed(2)} fetches/segment with P2P on,` +
        ` ${offAmp.toFixed(2)} off). So the extra bytes are DISTINCT segments, not a duplicate`);
      console.log(`  fetch and not a double-counted event — the swarm pulled more real data.`);
    }
    console.log(`  Per video-second: ${onKB.toFixed(0)} KB on vs ${offKB.toFixed(0)} KB off` +
      ` = ${perSecGap.toFixed(2)}x` +
      (perSecGap > 1.15
        ? ` — a REAL amplification a relaying viewer pays for.`
        : perSecGap < 1.15 && perSecGap > 0.85
          ? ` — no meaningful amplification once normalised by video obtained.`
          : ` — P2P fetched LESS per video-second.`));
    // IS IT TUNABLE? The never-played count is the deciding number. Waste (fetched, never
    // rendered) can be tuned away by narrowing the P2P download window. Read-ahead the viewer
    // DOES go on to watch is inherent to the mesh and no window value removes it — in that
    // case the remedy is bounding upload per viewer, not tuning.
    const onTimed = on.ledger.played + on.ledger.pending + on.ledger.wasted;
    const onWastePct = onTimed ? (on.ledger.wasted / onTimed) * 100 : null;
    const offTimed = off.ledger.played + off.ledger.pending + off.ledger.wasted;
    const offWastePct = offTimed ? (off.ledger.wasted / offTimed) * 100 : null;
    if (onWastePct === null) {
      console.log(`  Segment fate UNKNOWN: no segment carried timing, so waste cannot be counted.`);
      console.log(`  (${on.ledger.noTiming} untimed.) Treat the tunability question as unanswered.`);
    } else {
      console.log(`  Segment fate: ${on.ledger.played} played, ${on.ledger.pending} buffered-pending,` +
        ` ${on.ledger.wasted} WASTED = ${onWastePct.toFixed(0)}% (${mb(on.ledger.wastedBytes)})` +
        `; control arm ${offWastePct === null ? "n/a" : offWastePct.toFixed(0) + "%"}.`);
      // The control arm is the sanity check on the metric itself: a pure-HTTP viewer should
      // waste almost nothing. If it reads high, the metric is counting truncation as waste
      // (it did — an earlier version reported 51% for the HTTP-only arm, which is impossible).
      if (offWastePct !== null && offWastePct > 10) {
        console.log(`  ⚠ METRIC SUSPECT: the HTTP-only arm should waste ~0%, not ${offWastePct.toFixed(0)}%.`);
        console.log(`    Treat the tunability verdict below as unproven until that is explained.`);
      }
      if (onWastePct >= 15) {
        console.log(`  => TUNABLE. Most of the amplification is data the viewer never watched, so`);
        console.log(`     narrowing p2pDownloadTimeWindow (default 6000s) should cut it. See P2P-0029.`);
      } else {
        console.log(`  => NOT TUNABLE by the download window. Nearly everything fetched WAS played,`);
        console.log(`     so the extra bytes are read-ahead the viewer went on to watch, not waste.`);
        console.log(`     Reducing the window would cut offload, not cost. Bound upload per viewer instead.`);
      }
    }
    if (perSecGap > 1.15 && on.ledger.dupFetches === 0) {
      console.log(`  Distinct segments AND more bytes per video-second: not an accounting bug.`);
    }
  } else {
    console.log(`  origin served MORE with P2P on (${mb(off.httpBytes)} -> ${mb(on.httpBytes)}); no saving measured.`);
  }

  // Verdict. The off arm showing offload means the flag did not work, which invalidates the
  // comparison — that is a harness failure (2), not a product failure (1).
  //
  // The off arm must also have COUNTED its bytes. Measured at iter 25: with isP2PDisabled the
  // engine delegates to hls.js's default loader and onSegmentLoaded never fires, so the arm
  // reported 0 MB origin bytes — which reads as "P2P off is free" when it is the expensive
  // arm. A control arm that measures nothing is worse than no control arm, because it still
  // prints a table.
  if (off.httpBytes === 0) {
    console.log(`\nFAIL(2): control arm reported 0 origin bytes — it fetched video but counted none.`);
    console.log("  The P2P-off byte accounting is blind (see the FRAG_LOADED path in index.html).");
    process.exitCode = 2;
  } else if (off.p2pBytes > 0 || off.p2pSegments > 0) {
    console.log(`\nFAIL(2): control arm still moved P2P bytes (${mb(off.p2pBytes)}, ${off.p2pSegments} segs).`);
    console.log("  ?p2p=off did not disable P2P, so the two arms are not a comparison.");
    process.exitCode = 2;
  } else if (!on.pass) {
    console.log("\nFAIL(1): the P2P arm produced no P2P bytes, so there is nothing to compare.");
    process.exitCode = 1;
  } else {
    console.log("\nPASS: P2P arm offloaded, control arm did not — the comparison is valid.");
    process.exitCode = 0;
  }
}

(async () => {
  if (CONTROL) {
    await runControl();
    return;
  }
  if (!sweepArg) {
    await runOnce();
    return;
  }

  console.log(`SWEEP: viewer counts ${sweepArg.join(", ")} — ${WATCH_S}s watch each\n`);
  const rows = [];
  for (const n of sweepArg) {
    console.log(`${"=".repeat(60)}\n=== N=${n}\n${"=".repeat(60)}`);
    // stopEarly:false so each N burns the full window and the ratio is comparable.
    const r = await runOnce({ viewers: n, stopEarly: false });
    if (r) rows.push(r);
    // Let the previous run's viewers age out of the active count before the next one.
    await sleep(3000);
  }

  console.log(`\n${"=".repeat(60)}\nOFFLOAD vs VIEWER COUNT\n${"=".repeat(60)}`);
  console.log("| viewers | offload | p2p bytes | http bytes | p2p segs | peer conns |");
  console.log("|---------|---------|-----------|------------|----------|------------|");
  for (const r of rows) {
    console.log(`| ${String(r.viewers).padStart(7)} | ${String(r.offloadPct + "%").padStart(7)} | ${mb(r.p2pBytes).padStart(9)} | ${mb(r.httpBytes).padStart(10)} | ${String(r.p2pSegments).padStart(8)} | ${String(r.peerConnects).padStart(10)} |`);
  }
  console.log("\ncsv:");
  console.log("viewers,offload_pct,p2p_bytes,http_bytes,p2p_segments,peer_connects");
  for (const r of rows) {
    console.log(`${r.viewers},${r.offloadPct},${r.p2pBytes},${r.httpBytes},${r.p2pSegments},${r.peerConnects}`);
  }

  // N=1 is EXPECTED to be 0%: a solo viewer has no peer to pull from, so zero P2P bytes is
  // the correct result, not a failure. Only multi-viewer counts must produce P2P bytes.
  const solo = rows.filter((r) => r.viewers === 1);
  for (const r of solo) {
    console.log(`\nnote: N=1 measured ${r.offloadPct}% — expected, a lone viewer has no peer.` +
      (r.p2pBytes > 0 ? " NONZERO here would be suspicious." : ""));
  }
  const failed = rows.filter((r) => r.viewers > 1 && !r.pass).map((r) => r.viewers);
  if (rows.length >= 2) {
    const first = rows[0], lastRow = rows[rows.length - 1];
    console.log(`trend: N=${first.viewers} -> ${first.offloadPct}%, N=${lastRow.viewers} -> ${lastRow.offloadPct}% (${lastRow.offloadPct > first.offloadPct ? "rising" : "NOT rising"})`);
  }
  if (failed.length) {
    console.log(`\nFAIL(1): no P2P bytes at viewer count(s): ${failed.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS: every multi-viewer count produced real peer-to-peer bytes.");
    process.exitCode = 0;
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
