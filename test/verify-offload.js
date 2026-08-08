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
 *   node test/verify-offload.js --sweep 8,12,16 --maxPeers 200 [--watch 45]
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

// --participation 100,75,50,25 -> run once per participation rate and tabulate what the platform
// actually saves when only some viewers relay. Every other number in this repo assumes 100%.
const participationArg = (() => {
  const i = process.argv.indexOf("--participation");
  if (i === -1) return null;
  const raw = process.argv[i + 1];
  if (!raw || raw.startsWith("--")) return [100, 75, 50, 25];
  const ns = raw.split(",").map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  return ns.length ? ns : null;
})();

// --windows 6000,600,120,30 -> run once per p2pDownloadTimeWindow value and tabulate offload
// against the viewer's bandwidth cost. `default` runs with the knob untouched as the baseline.
const windowsArg = (() => {
  const i = process.argv.indexOf("--windows");
  if (i === -1) return null;
  const raw = process.argv[i + 1];
  if (!raw || raw.startsWith("--")) return [null, 600, 120, 30];
  const ns = raw.split(",").map((s) => s.trim()).map((s) =>
    s === "default" ? null : Number(s)).filter((n) => n === null || (Number.isFinite(n) && n > 0));
  return ns.length ? ns : null;
})();

// --sweep 1,2,4,8 -> run once per count and print the offload-vs-N curve.
const sweepArg = (() => {
  const i = process.argv.indexOf("--sweep");
  if (i === -1) return null;
  const raw = process.argv[i + 1];
  if (!raw || raw.startsWith("--")) return [1, 2, 4, 8];
  const ns = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ns.length ? ns : null;
})();

// --maxPeers <n> raises the engine's p2pMaxPeers (default 50) on every relayer for the whole run.
// It exists so a flattening sweep tail can be attributed: past the cap the engine evicts peers
// slowest-bandwidth-first every 30s, so a row above the cap measures peer POLICY, not scaling.
// Measured iter 49 at 8/12/16 with the cap at 200: connects 50/90/134, offload 80/84/85% — the
// flattening is real, not the cap. Keep the flag; it is how any future flat row gets ruled out.
const MAX_PEERS = (() => {
  const i = process.argv.indexOf("--maxPeers");
  if (i === -1) return null;
  // Floor BEFORE the >0 test — `--maxPeers 0.5` would otherwise pass and floor to 0, which the
  // viewer reads as "cap at zero peers". Same bug as in web/p2p-config.js; fixed in both.
  const n = Math.floor(Number(process.argv[i + 1]));
  return Number.isFinite(n) && n > 0 ? n : null;
})();

// Public egress list prices, USD per GB, first tier, as of 2025. These are REFERENCE POINTS for
// the `--usdPerGB` flag, not a claim about what anyone pays: real bills are negotiated, tiered by
// volume, and vary by region. Cloudflare is in the list deliberately — it charges nothing for
// egress, so on that CDN this entire product saves $0, and a pricing feature that cannot express
// that is marketing rather than measurement.
export const EGRESS_RATES = {
  cloudflare: 0,
  cloudfront: 0.085,   // AWS CloudFront, first 10TB/mo, US/EU
  fastly: 0.12,        // Fastly, North America on-demand
  gcs: 0.12,           // Google Cloud CDN, first tier
};
const DEFAULT_RATE_NAME = "cloudfront";

// --usdPerGB <n> (or EGRESS_USD_PER_GB, or --rate <name>) prices the measured origin saving.
// Default is AWS CloudFront's first-tier list price, named in the output so nobody has to guess
// where the number came from. 0 is a LEGAL value, not a missing one — Cloudflare charges nothing
// for egress, and the feature has to be able to say "this saves you $0".
const RATE_NAME = (() => {
  const i = process.argv.indexOf("--rate");
  const v = i !== -1 ? process.argv[i + 1] : process.env.EGRESS_RATE_NAME;
  return v && Object.prototype.hasOwnProperty.call(EGRESS_RATES, v) ? v : null;
})();
const USD_PER_GB = (() => {
  const i = process.argv.indexOf("--usdPerGB");
  const raw = i !== -1 ? process.argv[i + 1] : process.env.EGRESS_USD_PER_GB;
  if (raw !== undefined && raw !== null && raw !== "") {
    const n = Number(raw);
    // >= 0, not > 0: zero is meaningful here. Reject only unparseable/negative.
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;   // resolved against RATE_NAME / the default below
})();
// --videoHours <n>: how many video-hours/month to extrapolate over. No default is "right", so it
// is echoed with every figure. 730 = a 24/7 channel for one month, which is at least a stated
// assumption rather than a hidden one.
const VIDEO_HOURS = (() => {
  const i = process.argv.indexOf("--videoHours");
  const raw = i !== -1 ? process.argv[i + 1] : process.env.EGRESS_VIDEO_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 730;
})();
// Precedence: an explicit --usdPerGB wins over --rate, which wins over the default. Resolved once
// so the printed label always matches the number actually used — a mislabelled rate would be
// worse than no rate at all.
const EFF_USD_PER_GB = USD_PER_GB !== null ? USD_PER_GB : EGRESS_RATES[RATE_NAME || DEFAULT_RATE_NAME];
const EFF_RATE_LABEL = USD_PER_GB !== null ? "custom rate" : (RATE_NAME || DEFAULT_RATE_NAME);

// This package is "type":"module", so there is no bare `require` here. Playwright is a
// CommonJS dep living OUTSIDE this repo, so build a require() bound to this file's URL.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
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
async function runOnce({ viewers = VIEWERS, watchS = WATCH_S, staggerS = STAGGER_S, stopEarly = true, p2p = true, p2pWindow = null, relayers = null, p2pMaxPeers = MAX_PEERS } = {}) {
  const VIEWERS = viewers;
  const WATCH_S = watchS;
  const STAGGER_S = staggerS;
  // PARTICIPATION. `relayers` = how many of the viewers actually relay; the rest load with
  // ?p2p=off and are pure freeloaders. Null means "all of them", which is what every number in
  // this repo assumed until now — and no real deployment gets 100% participation.
  // Resolved by the unit-tested participationPlan() rather than inline, so the p2p/relayers
  // precedence cannot drift back to silently overriding a control arm.
  const plan = participationPlan({ viewers: VIEWERS, relayers, p2p, p2pWindow, p2pMaxPeers, baseUrl: VIEWER_URL });
  const RELAYERS = plan.relayers;
  const urlFor = plan.urlFor;
  const relayerAt = plan.relayerAt;
  console.log(`verify-offload: ${VIEWERS} viewers, ${WATCH_S}s watch, ${STAGGER_S}s stagger, ` +
    `relaying ${RELAYERS}/${VIEWERS} (${Math.round((RELAYERS / VIEWERS) * 100)}%)` +
    (p2pWindow ? `, p2pWindow=${p2pWindow}s` : "") +
    (p2pMaxPeers ? `, p2pMaxPeers=${p2pMaxPeers}` : ""));
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
      await page.goto(urlFor(i), { waitUntil: "domcontentloaded" });
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
    // Checked PER VIEWER, since participation is now per-viewer: viewer i must relay iff
    // i < RELAYERS. A mixed run where the split silently failed would report a participation
    // rate it never ran, which is the most misleading possible output.
    const armFlags = await Promise.all(pages.map((p) => p.evaluate(() => window.__p2pEnabled)));
    const wrongArm = armFlags.filter((f, i) => f !== relayerAt(i)).length;
    if (wrongArm) {
      console.error(`\nFAIL(2): ${wrongArm}/${armFlags.length} viewers have the wrong participation flag.`);
      console.error(`  expected ${JSON.stringify(armFlags.map((_, i) => relayerAt(i)))}, got ${JSON.stringify(armFlags)}.`);
      console.error("  The ?p2p=off flag did not take effect, so this run is not what it claims.");
      process.exit(2);
    }
    console.log(`  participation confirmed: ${armFlags.filter(Boolean).length}/${armFlags.length} viewers relaying`);

    // Read the window back OUT of the engine. A sweep whose knob silently failed would print a
    // table of near-identical rows and read as "tuning makes no difference" — worse than no
    // sweep, because it looks like evidence. Assert the value the engine actually holds.
    const windows = await Promise.all(pages.map((pg) =>
      pg.evaluate(() => (typeof window.__p2pWindow === "function" ? window.__p2pWindow() : null))));
    // Only RELAYERS carry the window override, so read it from a relayer. windows[0] is a
    // freeloader when nobody relays, and reporting its window would misdescribe the run.
    const effWindow = RELAYERS > 0 ? windows[0] : null;
    if (p2pWindow) {
      const wrong = windows.filter((w, i) => relayerAt(i) && w !== p2pWindow).length;
      if (wrong) {
        console.error(`\nFAIL(2): asked for p2pDownloadTimeWindow=${p2pWindow} but the engine reports ${JSON.stringify(windows)}.`);
        console.error("  The knob did not take effect, so this row would be a fabricated data point.");
        process.exit(2);
      }
      console.log(`  window confirmed: p2pDownloadTimeWindow=${effWindow}s (engine-reported)`);
    } else if (effWindow !== null && effWindow !== undefined) {
      console.log(`  window: p2pDownloadTimeWindow=${effWindow}s (engine default, not overridden)`);
    }

    // Same readback rule for the peer cap, and it matters MORE here than for the window: the
    // engine's default is 50, and the N=8 row happens to measure ~50 peer connects. A
    // sweep past N=8 whose cap silently failed would measure the DEFAULT and read as "raising
    // the cap changes nothing / offload plateaus" — a scaling limit that is policy, not physics.
    const caps = await Promise.all(pages.map((pg) =>
      pg.evaluate(() => (typeof window.__p2pMaxPeers === "function" ? window.__p2pMaxPeers() : null))));
    const effMaxPeers = RELAYERS > 0 ? caps[0] : null;
    if (p2pMaxPeers) {
      const wrong = caps.filter((c, i) => relayerAt(i) && c !== p2pMaxPeers).length;
      if (wrong) {
        console.error(`\nFAIL(2): asked for p2pMaxPeers=${p2pMaxPeers} but the engine reports ${JSON.stringify(caps)}.`);
        console.error("  The cap did not take effect, so this row would be a fabricated data point.");
        process.exit(2);
      }
      console.log(`  peer cap confirmed: p2pMaxPeers=${effMaxPeers} (engine-reported)`);
    } else if (effMaxPeers !== null && effMaxPeers !== undefined) {
      console.log(`  peer cap: p2pMaxPeers=${effMaxPeers} (engine default, not overridden)`);
    }

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

    // DASHBOARD AGREEMENT. The dashboard renders `Math.round(s.offloadRatio * 100)` from this
    // same /stats payload, so the on-screen figure is exactly `pct` — and a human was being
    // asked to eyeball that (a manual-QA box since iter 10). Assert it instead.
    //
    // The honest subtlety, and why this is not just `pct === dPct`: the dashboard shows the
    // CUMULATIVE ratio while the harness quotes THIS RUN's delta. On a stack that has served
    // earlier runs the two legitimately differ, so demanding equality would fail on a correct
    // system. What must hold is that the dashboard's number is reproducible from the payload
    // and that the two agree WHEN the counters started clean.
    const dashPct = Math.round(final.offloadRatio * 100);
    if (dashPct !== pct) {
      console.error(`\nFAIL(2): dashboard arithmetic drifted — offloadRatio*100 rounds to ${dashPct}, printed ${pct}.`);
      process.exit(2);
    }
    const priorBytes = before.httpBytes + before.p2pBytes;
    if (priorBytes === 0) {
      // Clean counters: cumulative IS this run, so the dashboard and the harness must match.
      // ±1 point for independent rounding of the same two byte totals.
      if (Math.abs(dashPct - dPct) > 1) {
        console.error(`\nFAIL(2): counters started clean but dashboard says ${dashPct}% and this run measured ${dPct}%.`);
        console.error("  Same bytes, two answers — one of the two aggregations is wrong.");
        process.exit(2);
      }
      console.log(`dashboard agrees: ${dashPct}% on screen == ${dPct}% measured (counters were clean)`);
    } else {
      console.log(`dashboard shows ${dashPct}% CUMULATIVE (${mb(priorBytes)} carried in from earlier runs);` +
        ` this run alone is ${dPct}%. Not comparable — restart the metrics server for a clean read.`);
    }

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
      // ...and the SPREAD behind that mean. The line above is a pooled average; the per-viewer
      // figures it averages have been collected since iter 29 and never printed, so the tail was
      // measurable all along. An ad-free tier priced on the mean underprices the worst-off viewer.
      for (const line of viewerSpreadLines(viewerSpread(qoe))) console.log(line);
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
      // The window the ENGINE reported, not what we asked for — so the sweep table cannot
      // claim a value that never applied.
      p2pWindow: effWindow,
      // Likewise engine-reported, not requested — the sweep table must not print a cap that
      // never applied next to an offload number produced at the default.
      p2pMaxPeers: effMaxPeers,
      relayers: RELAYERS, participationPct: plan.participationPct,
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

    // FORGERY SIGNAL, per viewer. Conservation above is swarm-wide and so hides a single liar:
    // one peer inflating its claim while three report honestly barely moves the sum. This diffs
    // each viewer's own claim against what its RECEIVERS attested, which is the only comparison
    // a reward tier could act on.
    const sig = forgerySignals(final.uploadByClient, final.attestedByClient);
    if (sig.rows.length) {
      console.log("\nupload claims vs receiver attestations (the forgery signal):");
      for (const r of sig.rows) {
        const pct = r.ratio === null ? "n/a" : r.ratio === Infinity ? "inf" : r.ratio.toFixed(2);
        console.log(`  ${r.id.slice(0, 8)}  claimed ${mb(r.self).padStart(8)}  attested ${mb(r.attested).padStart(8)}` +
          `  attested/claimed=${pct}` +
          (!r.judged ? "  (too small to judge)"
            : r.overClaim ? "  <-- OVER-CLAIMING: bytes nobody received"
              : r.underClaim ? "  (under-claims; not a payout risk)" : "  ok"));
      }
      if (sig.unmapped > 0) {
        console.log(`  ${mb(sig.unmapped)} attested to peerIds with no known client (departed or unannounced).`);
      }
      console.log(sig.suspects.length
        ? `  => ${sig.suspects.length} viewer(s) claim materially more than receivers confirm. DO NOT pay out on self-reported upload.`
        : `  => no viewer over-claims by >25%; self-reported and attested agree within normal report timing.`);
      // K-of-N filtered credit, printed next to the raw figure. The GAP is the signal: a large drop
      // means credit rested on too few witnesses or on one voucher claiming more than the cap.
      if (typeof final.attestedFilteredUploadBytes === "number") {
        const raw = final.attestedUploadBytes || 0;
        const filt = final.attestedFilteredUploadBytes;
        const kept = raw > 0 ? Math.round((filt / raw) * 100) : 0;
        console.log(`  K-of-N filter (>=${final.minAttesters} attesters, <=${mb(final.maxVouchPerAttester)} each): ` +
          `${mb(filt)} of ${mb(raw)} survives (${kept}%).`);
        console.log(`  It METERS collusion — it cannot stop it. A ring is byte-identical to honest peers.`);
      }
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
// Participation plan for a run, as a PURE function so it can be unit-tested without a browser.
// Decides how many viewers relay and what URL each one loads. Inline in runOnce this was only
// reachable via a ~10-minute browser sweep, and it hid a real precedence bug: `{p2p:false,
// relayers:3}` produced THREE relayers, silently overriding an explicit "P2P off". A mixed run
// that reports a participation rate it never ran is the most misleading output this harness can
// produce, so the resolution is now explicit and asserted.
// Classify one participation row against the full-participation reference. Pure, so the
// thresholds that decide the PUBLISHED conclusion ("graceful" vs "collapse") are testable rather
// than only reachable through a 10-minute browser sweep.
export function participationVerdict({ pct, relayers, savedPct, fullPct, fullSavedPct }) {
  // A single relayer has no peer to pull from, so 0% is arithmetic, not a measurement. Calling
  // that a collapse would report a certainty as a finding.
  if (relayers < 2) return { kind: "not-measurable", expected: null, ratio: null };
  if (savedPct === null || fullSavedPct === null || !fullPct) {
    return { kind: "unknown", expected: null, ratio: null };
  }
  // If the mesh degraded gracefully, half the relayers would still save about half.
  const expected = fullSavedPct * (pct / fullPct);
  const ratio = expected > 0 ? savedPct / expected : 0;
  const kind = ratio >= 0.85 ? "graceful" : ratio >= 0.5 ? "worse-than-proportional" : "collapse";
  return { kind, expected, ratio };
}

export function participationPlan({ viewers, relayers = null, p2p = true, p2pWindow = null, p2pMaxPeers = null, baseUrl }) {
  // p2p:false means OFF and wins over any relayer count — the caller asked for a control arm.
  // Otherwise null means "everyone relays"; a number is clamped into [0, viewers].
  const n = !p2p ? 0
    : relayers === null ? viewers
      : Math.max(0, Math.min(viewers, Math.floor(relayers)));
  const relayerAt = (i) => i < n;
  const urlFor = (i) => {
    const url = new URL(baseUrl);
    // Relayers get the FIRST slots so a staggered join puts a relayer in first — with a
    // freeloader first there is nobody to pull from and early segments skew to HTTP.
    if (!relayerAt(i)) url.searchParams.set("p2p", "off");
    // The window override only means anything for a viewer that actually relays.
    if (p2pWindow && relayerAt(i)) url.searchParams.set("p2pWindow", String(p2pWindow));
    // Same for the peer cap: a freeloader has no peers to cap.
    if (p2pMaxPeers && relayerAt(i)) url.searchParams.set("p2pMaxPeers", String(p2pMaxPeers));
    return url.toString();
  };
  return {
    relayers: n,
    participationPct: viewers > 0 ? Math.round((n / viewers) * 100) : 0,
    relayerAt, urlFor,
  };
}

// The claim arithmetic, pulled out as a PURE function so it can be unit-tested without a
// browser or a running stack. Every externally quoted number comes through here, so a silent
// error in it misreports the product's whole value proposition — that is exactly why it should
// not live inline inside a 600-line async driver.
//
// NORMALISED BY VIDEO OBTAINED. Dividing raw origin bytes is only valid when both arms obtained
// the same amount of video; when they differ, the raw formula credits P2P for video the control
// arm played and the P2P arm did not. At iter 25/29/31 the arms happened to match (472s vs 472s)
// so the raw number was right by luck. Per video-second is right by construction.
// FORGERY SIGNAL. Diffs what each viewer CLAIMS it uploaded against what its receivers say it
// served them. Pure, so the threshold that decides "distrust this claim" is unit-testable rather
// than buried in the driver — the same reason claimNumbers() was extracted.
//
// Direction matters and is the whole point:
//   self >> attested  -> the peer claims bytes nobody received. That is the forgery a reward tier
//                        would pay out on, so it is the flagged case.
//   attested >> self   -> receivers report MORE than the server admits. Not a payout risk (it
//                        under-claims), usually just report timing, so it is reported not flagged.
// Honest runs measured 0.97-1.03, so a wide band is normal and only a gross gap is a signal.
export function forgerySignals(uploadByClient = {}, attestedByClient = {}, { tolerance = 0.25, floorBytes = 1e6 } = {}) {
  const ids = new Set([...Object.keys(uploadByClient), ...Object.keys(attestedByClient)]);
  const rows = [];
  for (const id of ids) {
    if (id.startsWith("unmapped:")) continue;   // no client to judge; reported separately
    const self = Number(uploadByClient[id]) || 0;
    const attested = Number(attestedByClient[id]) || 0;
    // Below the floor, ratios are noise: a viewer that has served 3 segments can read 0.5 purely
    // from report timing. Judging those would manufacture alarms on every startup.
    const judged = self >= floorBytes || attested >= floorBytes;
    const ratio = self > 0 ? attested / self : (attested > 0 ? Infinity : null);
    // Flag ONLY over-claiming, and only once the numbers are big enough to mean something.
    const overClaim = judged && self > 0 && ratio !== null && ratio < 1 - tolerance;
    const underClaim = judged && ratio !== null && ratio > 1 + tolerance;
    rows.push({ id, self, attested, ratio, judged, overClaim, underClaim });
  }
  rows.sort((a, b) => (a.ratio ?? 9e9) - (b.ratio ?? 9e9));
  return {
    rows,
    suspects: rows.filter((r) => r.overClaim),
    unmapped: Object.entries(attestedByClient)
      .filter(([k]) => k.startsWith("unmapped:"))
      .reduce((a, [, v]) => a + (Number(v) || 0), 0),
  };
}

/**
 * The ⚠ skew warning, as LINES rather than console.log calls, so a test can assert that it
 * actually fires. Extracted iter 53: `claim.test.js` already covered the skew ARITHMETIC
 * (videoSkewPct), but nothing checked that the harness EMITS the warning — so a run whose arms
 * played unequal video could have published a raw subtraction silently. The arithmetic being
 * right does not help if the number never reaches the reader.
 *
 * Returns [] when there is nothing to warn about. The 3% threshold is the same one the README
 * documents; below it the raw and normalised figures agree closely enough to be interchangeable.
 */
export function skewWarning(claim, offHeldS, onHeldS) {
  if (claim.videoSkewPct === null || claim.videoSkewPct <= 3) return [];
  return [
    `  ⚠ the arms obtained ${claim.videoSkewPct}% different video (${offHeldS.toFixed(0)}s vs ${onHeldS.toFixed(0)}s),`,
    `    so the raw byte subtraction would have claimed -${claim.rawSavedPct}%. Quote the`,
    `    per-video-second figure (-${claim.savedPct}%); the raw one credits P2P for video it did not serve.`,
  ];
}

/**
 * Turn the measured origin saving into a $/month figure.
 *
 * Every input is explicit because the extrapolation is where a number like this normally goes
 * wrong: we measure ~40 seconds of one stream on one box, and a monthly bill is a different
 * quantity by many orders of magnitude. So this does NOT invent a viewer count or a schedule —
 * it converts to a per-video-hour rate, then multiplies by `videoHoursPerMonth`, which the
 * CALLER supplies and which is echoed alongside the result. A dollar figure whose assumptions
 * are not printed next to it is unusable.
 *
 * `usdPerGB` of 0 must yield exactly 0 — see EGRESS_RATES.cloudflare.
 * GB here is 1e9 bytes (decimal), which is how CDNs quote egress. Echoed so it is not a guess.
 */
export function priceSaving({ savedBytes, videoSeconds, usdPerGB, videoHoursPerMonth }) {
  // A saving is only meaningful per unit of video delivered; raw bytes from a 40s run say nothing.
  if (!(videoSeconds > 0)) return null;
  if (!Number.isFinite(usdPerGB) || usdPerGB < 0) return null;
  if (!Number.isFinite(videoHoursPerMonth) || videoHoursPerMonth <= 0) return null;
  const GB = 1e9;
  const savedGBPerVideoHour = (savedBytes / videoSeconds) * 3600 / GB;
  return {
    savedGBPerVideoHour,
    usdPerVideoHour: savedGBPerVideoHour * usdPerGB,
    usdPerMonth: savedGBPerVideoHour * usdPerGB * videoHoursPerMonth,
    // Echoed so the figure can never be quoted without what produced it.
    usdPerGB, videoHoursPerMonth, gbBytes: GB,
  };
}

/**
 * The $/month lines, as LINES so a test can assert what actually gets printed (same reason as
 * skewWarning). Returns [] when the saving cannot be priced.
 *
 * Deliberately prints the ZERO case as its own sentence rather than "$0.00/month": on a
 * zero-egress CDN the correct business answer is "this product saves you nothing", and burying
 * that in a formatted number would be the flattering version.
 */
export function pricingLines(price, rateName) {
  if (!price) return [];
  const rate = `$${price.usdPerGB.toFixed(3)}/GB`;
  const src = rateName ? ` (${rateName})` : "";
  if (price.usdPerGB === 0) {
    return [
      `  at ${rate}${src} the saving is worth NOTHING — a zero-egress CDN bills no transfer,`,
      `  so ${price.savedGBPerVideoHour.toFixed(2)} GB saved per video-hour is $0. P2P buys you nothing here.`,
    ];
  }
  return [
    `  = ${price.savedGBPerVideoHour.toFixed(2)} GB saved per video-hour` +
      ` -> $${price.usdPerVideoHour.toFixed(2)}/video-hour at ${rate}${src}`,
    `  = $${price.usdPerMonth.toFixed(0)}/month at ${price.videoHoursPerMonth} video-hours/month` +
      ` (${(price.gbBytes / 1e9).toFixed(0)}e9 bytes = 1 GB, list price, real bills are negotiated)`,
    `  ⚠ EXTRAPOLATED from a ${VIEWERS}-viewer loopback run of seconds, not a measured bill.` +
      ` Scales with participation: see the decay table.`,
  ];
}

/**
 * Per-viewer bandwidth cost, and the SPREAD across viewers.
 *
 * Every cost figure this project publishes is a pooled mean: total bytes / total video-seconds.
 * But `heldS` and the ledger's `httpBytes`/`p2pBytes` have been captured PER VIEWER since iter 29
 * and averaged away at print time, so the tail was measurable all along and never looked at. That
 * matters because the mean is what an ad-free tier would be priced on, and a late joiner plausibly
 * pays far more than the mean — which is exactly the viewer who quits.
 *
 * Takes the `qoe` array (one entry per viewer, each with `heldS` and `led`). Viewers with no
 * video-seconds are EXCLUDED rather than counted as zero: a tab that never played has no cost
 * per video-second, and folding it in as 0 would drag the mean down and invent a rosier spread.
 * Their count is returned so the exclusion is visible instead of silent.
 */
export function viewerSpread(qoe) {
  const rows = [];
  let noVideo = 0;
  (qoe || []).forEach((v, i) => {
    const held = v && typeof v.heldS === "number" ? v.heldS : 0;
    const led = v && v.led;
    if (!led || held <= 0) { noVideo++; return; }
    const bytes = (Number(led.httpBytes) || 0) + (Number(led.p2pBytes) || 0);
    rows.push({ viewer: i, kbPerVideoS: bytes / held / 1e3, bytes, heldS: held });
  });
  if (!rows.length) return null;
  const vals = rows.map((r) => r.kbPerVideoS);
  const min = Math.min(...vals), max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  // Spread as a fraction of the MEAN, not of the min: "the worst viewer pays 1.4x the average" is
  // the sentence a pricing decision needs. maxOverMean >= 1 always; 1.0 means perfectly even.
  return {
    rows,
    n: rows.length,
    noVideo,
    min, max, mean,
    maxOverMean: mean > 0 ? max / mean : null,
    spreadPct: mean > 0 ? Math.round(((max - min) / mean) * 100) : null,
    worst: rows.reduce((a, b) => (a.kbPerVideoS >= b.kbPerVideoS ? a : b)),
    best: rows.reduce((a, b) => (a.kbPerVideoS <= b.kbPerVideoS ? a : b)),
  };
}

/**
 * The per-viewer lines. Returns [] when there is nothing to report.
 *
 * The 10% threshold splits two genuinely different outcomes and the wording has to differ:
 * above it the tail is a finding, below it **the mean was representative** — which is an honest
 * null result, not a reason to print a dramatic-sounding spread. Reporting "worst viewer 1.02x
 * the mean" as though it were news would be manufacturing a finding out of noise.
 */
export function viewerSpreadLines(spread) {
  if (!spread) return [];
  const out = [`  per-viewer cost (KB per video-second), ${spread.n} viewer(s):`];
  for (const r of spread.rows) {
    out.push(`    tab${r.viewer}: ${r.kbPerVideoS.toFixed(0)} KB/video-s` +
      ` (${(r.bytes / 1e6).toFixed(1)}MB over ${r.heldS.toFixed(0)}s)` +
      (r.viewer === spread.worst.viewer && spread.n > 1 ? "   <- WORST" : ""));
  }
  if (spread.noVideo > 0) {
    out.push(`    (${spread.noVideo} viewer(s) excluded: no video-seconds, so no cost per video-second)`);
  }
  if (spread.n < 2) {
    out.push("    single viewer — no spread to report.");
    return out;
  }
  out.push(`  min ${spread.min.toFixed(0)} / mean ${spread.mean.toFixed(0)} / max ${spread.max.toFixed(0)} KB/video-s` +
    ` = ${spread.spreadPct}% spread, worst pays ${spread.maxOverMean.toFixed(2)}x the mean`);
  if (spread.spreadPct >= 10) {
    out.push(`  ⚠ tab${spread.worst.viewer} pays ${spread.maxOverMean.toFixed(2)}x the average.` +
      ` Pricing an ad-free tier on the MEAN underprices that viewer,`);
    out.push(`    and the worst-off viewer is the one who churns. Quote the max alongside the mean.`);
  } else {
    out.push(`  the mean was REPRESENTATIVE here (spread under 10%) — no tail to report, which is`);
    out.push(`    a null result rather than a finding. It may not hold on a real network.`);
  }
  return out;
}

export function claimNumbers(on, off) {
  if (!on || !off) return null;
  const originPerS = (a) => (a.heldS > 0 ? a.httpBytes / a.heldS : null);
  const offPerS = originPerS(off), onPerS = originPerS(on);
  const savedPct = (offPerS && onPerS !== null && offPerS > 0)
    ? Math.round(((offPerS - onPerS) / offPerS) * 100)
    : null;
  // Raw (unnormalised) kept only so the two can be compared and a skew flagged.
  const rawSavedPct = off.httpBytes > 0
    ? Math.round(((off.httpBytes - on.httpBytes) / off.httpBytes) * 100)
    : null;
  // How unequal the arms' video is. Above a few percent the raw number stops being trustworthy
  // and the normalised one must be quoted instead.
  const videoSkewPct = off.heldS > 0
    ? Math.round((Math.abs(on.heldS - off.heldS) / off.heldS) * 100)
    : null;
  return {
    savedPct, rawSavedPct, videoSkewPct,
    savedBytes: off.httpBytes - on.httpBytes,
    offOriginPerS: offPerS, onOriginPerS: onPerS,
  };
}

// --windows: sweep p2pDownloadTimeWindow and tabulate the SAVING against the viewer's COST.
// The question this answers is not "which value gives the most offload" — it is whether the
// 33% of never-played fetches can be cut without giving up the origin saving. So every row
// carries both sides, and a row that wins on cost while losing the saving is not a win.
async function runWindowSweep() {
  console.log(`WINDOW SWEEP: p2pDownloadTimeWindow = ${windowsArg.map((w) => w ?? "default").join(", ")}` +
    ` — ${VIEWERS} viewers, ${WATCH_S}s watch each\n`);

  // A window LONGER than the stream itself cannot be distinguished from the engine default:
  // both mean "every segment is eligible". Such rows come out byte-identical and look like a
  // measured plateau when they are an artifact of the test material. Measured at iter 33 with a
  // 180s stream: windows 6000 and 600 produced identical rows. Say so instead of printing them
  // as data.
  let streamS = null;
  try {
    const m = await (await fetch(PLAYLIST_URL)).text();
    streamS = [...m.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, x) => a + Number(x[1]), 0);
  } catch { /* preflight will report the real problem */ }
  if (streamS) {
    const tooBig = windowsArg.filter((w) => w !== null && w >= streamS);
    console.log(`stream is ${streamS.toFixed(0)}s long.`);
    if (tooBig.length) {
      console.log(`⚠ window(s) ${tooBig.join(", ")} EXCEED the stream length, so they are`);
      console.log(`  indistinguishable from the engine default by construction — every segment is`);
      console.log(`  eligible either way. Treat those rows as the baseline repeated, not as data.`);
      console.log(`  Only windows below ${streamS.toFixed(0)}s test anything on this stream.\n`);
    }
  }

  // Measure the P2P-off baseline ONCE. Waste and KB/video-second are only meaningful against
  // it, and re-running it per row would triple the sweep for no extra information.
  console.log(`${"=".repeat(60)}\n=== BASELINE: P2P OFF\n${"=".repeat(60)}`);
  const off = await runOnce({ stopEarly: false, p2p: false });
  await sleep(3000);

  const rows = [];
  for (const w of windowsArg) {
    console.log(`${"=".repeat(60)}\n=== p2pDownloadTimeWindow = ${w ?? "engine default"}\n${"=".repeat(60)}`);
    const r = await runOnce({ stopEarly: false, p2p: true, p2pWindow: w });
    if (r) rows.push(r);
    await sleep(3000);
  }

  if (!off || !rows.length) {
    console.error("\nFAIL(2): baseline or sweep rows missing; nothing to compare.");
    process.exitCode = 2;
    return;
  }

  const offKB = off.bytesPerVideoS / 1e3;
  const wastePct = (l) => {
    if (!l) return null;
    const timed = l.played + l.pending + l.wasted;
    return timed ? Math.round((l.wasted / timed) * 100) : null;
  };

  console.log(`\n${"=".repeat(72)}\nOFFLOAD vs VIEWER COST, BY P2P DOWNLOAD WINDOW\n${"=".repeat(72)}`);
  console.log("| window |  saving | KB/video-s | amplif | wasted | stalls | peers |");
  console.log("|--------|---------|------------|--------|--------|--------|-------|");
  console.log(`| ${"OFF".padStart(6)} | ${"  —".padStart(7)} | ${offKB.toFixed(0).padStart(10)} |` +
    ` ${"1.00x".padStart(6)} | ${String((wastePct(off.ledger) ?? 0) + "%").padStart(6)} |` +
    ` ${String(off.stalls).padStart(6)} | ${String(off.peerConnects).padStart(5)} |`);
  for (const r of rows) {
    const c = claimNumbers(r, off);
    const kb = r.bytesPerVideoS / 1e3;
    console.log(`| ${String(r.p2pWindow ?? "dflt").padStart(6)} |` +
      ` ${String((c && c.savedPct !== null ? `-${c.savedPct}%` : "n/a")).padStart(7)} |` +
      ` ${kb.toFixed(0).padStart(10)} | ${((offKB ? kb / offKB : 0).toFixed(2) + "x").padStart(6)} |` +
      ` ${String((wastePct(r.ledger) ?? "n/a") + "%").padStart(6)} |` +
      ` ${String(r.stalls).padStart(6)} | ${String(r.peerConnects).padStart(5)} |`);
  }

  console.log("\ncsv:");
  console.log("window_s,saved_pct,kb_per_video_s,amplification,wasted_pct,stalls,peer_connects");
  for (const r of rows) {
    const c = claimNumbers(r, off);
    console.log(`${r.p2pWindow ?? "default"},${c && c.savedPct !== null ? c.savedPct : ""},` +
      `${(r.bytesPerVideoS / 1e3).toFixed(0)},${(offKB ? r.bytesPerVideoS / 1e3 / offKB : 0).toFixed(2)},` +
      `${wastePct(r.ledger) ?? ""},${r.stalls},${r.peerConnects}`);
  }

  // VERDICT. A smaller window only WINS if it cuts the viewer's cost while keeping the saving
  // and not introducing rebuffering. Losing 10 points of saving to save 10 points of waste is
  // not an improvement, it is a different trade — so say which it is rather than picking the
  // prettiest number.
  const baseline = rows.find((r) => r.p2pWindow === null || r.p2pWindow === undefined)
    || rows.find((r) => r.p2pWindow === 6000) || rows[0];
  const baseClaim = claimNumbers(baseline, off);
  const baseSaved = baseClaim && baseClaim.savedPct;
  const baseKB = baseline.bytesPerVideoS / 1e3;
  console.log("\nverdict:");
  console.log(`  baseline (window=${baseline.p2pWindow ?? "default"}): -${baseSaved}% saving,` +
    ` ${baseKB.toFixed(0)} KB/video-s, ${wastePct(baseline.ledger)}% wasted, ${baseline.stalls} stalls`);
  // "Wins" = cost strictly lower by >5%, saving within 5 points, no new stalls. Rows whose
  // window exceeds the stream length are excluded: they are the baseline under another name and
  // would otherwise be able to "win" against themselves on run-to-run noise.
  const wins = rows.filter((r) => {
    if (r === baseline) return false;
    if (streamS && r.p2pWindow && r.p2pWindow >= streamS) return false;
    const c = claimNumbers(r, off);
    if (!c || c.savedPct === null || baseSaved === null) return false;
    const kb = r.bytesPerVideoS / 1e3;
    return kb < baseKB * 0.95 && c.savedPct >= baseSaved - 5 && r.stalls <= baseline.stalls;
  });
  if (wins.length) {
    const best = wins.reduce((a, b) => (a.bytesPerVideoS <= b.bytesPerVideoS ? a : b));
    const bc = claimNumbers(best, off);
    const bkb = best.bytesPerVideoS / 1e3;
    console.log(`  => window=${best.p2pWindow}s CUTS the viewer's cost ${baseKB.toFixed(0)} -> ${bkb.toFixed(0)} KB/video-s` +
      ` (${Math.round((1 - bkb / baseKB) * 100)}% less) while holding the saving at -${bc.savedPct}% and ${best.stalls} stalls.`);
    console.log(`     Record it in patterns.md as the recommended value, with that offload cost stated.`);
  } else {
    console.log(`  => NO window beats the default on cost without giving up saving or adding stalls.`);
    console.log(`     The 1.55x is therefore NOT tunable via this knob — the read-ahead the viewer`);
    console.log(`     pays for is what earns the offload. Record the negative result; the remedy`);
    console.log(`     becomes bounding upload per viewer, not narrowing the window.`);
  }
  process.exitCode = 0;
}

// --participation: what does the platform save when only SOME viewers relay?
// Granting consent means granting refusal, so this is the number that decides whether the
// headline saving survives an opt-out. The freeloaders are real viewers pulling real bytes from
// the origin — they are part of the bill, not excluded from it.
async function runParticipationSweep() {
  console.log(`PARTICIPATION SWEEP: ${participationArg.join("%, ")}% of ${VIEWERS} viewers relaying` +
    ` — ${WATCH_S}s watch each\n`);

  // Baseline: nobody relays. That is the bill WITHOUT the product, and every row is measured
  // against it. Same reason the control arm exists.
  console.log(`${"=".repeat(60)}\n=== BASELINE: 0% relaying (P2P off)\n${"=".repeat(60)}`);
  const off = await runOnce({ stopEarly: false, p2p: false, relayers: 0 });
  await sleep(3000);

  const rows = [];
  for (const pct of participationArg) {
    const relayers = Math.round((pct / 100) * VIEWERS);
    console.log(`${"=".repeat(60)}\n=== participation ${pct}% (${relayers}/${VIEWERS} relaying)\n${"=".repeat(60)}`);
    const r = await runOnce({ stopEarly: false, p2p: relayers > 0, relayers });
    if (r) rows.push({ pct, relayers, r });
    await sleep(3000);
  }

  if (!off || !rows.length) {
    console.error("\nFAIL(2): baseline or sweep rows missing; nothing to compare.");
    process.exitCode = 2;
    return;
  }

  console.log(`\n${"=".repeat(72)}\nORIGIN SAVING vs PARTICIPATION RATE\n${"=".repeat(72)}`);
  console.log("| relaying |  saving | KB/video-s | up/relayer | stalls | peers |");
  console.log("|----------|---------|------------|------------|--------|-------|");
  console.log(`| ${"0%".padStart(8)} | ${"—".padStart(7)} | ${(off.bytesPerVideoS / 1e3).toFixed(0).padStart(10)} |` +
    ` ${"—".padStart(10)} | ${String(off.stalls).padStart(6)} | ${String(off.peerConnects).padStart(5)} |`);
  for (const { pct, relayers, r } of rows) {
    const c = claimNumbers(r, off);
    // Upload per RELAYER, not per viewer: freeloaders upload nothing, and averaging over them
    // would understate what the people actually carrying the swarm pay.
    const upPerRelayer = relayers > 0 ? r.uploadBytes / relayers : 0;
    console.log(`| ${String(pct + "%").padStart(8)} |` +
      ` ${String(c && c.savedPct !== null ? `-${c.savedPct}%` : "n/a").padStart(7)} |` +
      ` ${(r.bytesPerVideoS / 1e3).toFixed(0).padStart(10)} | ${mb(upPerRelayer).padStart(10)} |` +
      ` ${String(r.stalls).padStart(6)} | ${String(r.peerConnects).padStart(5)} |`);
  }

  console.log("\ncsv:");
  console.log("participation_pct,relayers,saved_pct,kb_per_video_s,upload_per_relayer_bytes,stalls,peer_connects");
  for (const { pct, relayers, r } of rows) {
    const c = claimNumbers(r, off);
    console.log(`${pct},${relayers},${c && c.savedPct !== null ? c.savedPct : ""},` +
      `${(r.bytesPerVideoS / 1e3).toFixed(0)},${relayers > 0 ? Math.round(r.uploadBytes / relayers) : 0},` +
      `${r.stalls},${r.peerConnects}`);
  }

  // VERDICT: does the saving degrade gracefully, or collapse? Linear-ish decay means the claim
  // just needs qualifying with a rate. A collapse means the product needs near-total
  // participation to work at all, which is a much weaker business case than "-51%".
  const full = rows.find((x) => x.pct === 100) || rows[0];
  const fullSaved = (claimNumbers(full.r, off) || {}).savedPct;
  console.log("\nverdict:");
  console.log(`  at ${full.pct}% participation: -${fullSaved}% origin saving`);
  for (const { pct, relayers, r } of rows) {
    if (r === full.r) continue;
    const c = claimNumbers(r, off);
    if (!c || c.savedPct === null || fullSaved === null) continue;
    const v = participationVerdict({
      pct, relayers, savedPct: c.savedPct, fullPct: full.pct, fullSavedPct: fullSaved,
    });
    if (v.kind === "not-measurable") {
      console.log(`  at ${pct}%: -${c.savedPct}% — only ${relayers} relayer, which CANNOT offload` +
        ` (no peer to pull from). 0% here is arithmetic, not a measurement.`);
      continue;
    }
    if (v.kind === "unknown") continue;
    const label = v.kind === "graceful" ? "graceful (≈proportional)"
      : v.kind === "worse-than-proportional" ? "WORSE than proportional"
        : "COLLAPSE — mesh needs the missing peers";
    console.log(`  at ${pct}%: -${c.savedPct}% (proportional would be -${v.expected.toFixed(0)}%) -> ${label}`);
  }
  if (VIEWERS < 8) {
    console.log(`  ⚠ only ${VIEWERS} viewers: each step removes a large fraction of the swarm, so low`);
    console.log(`    rates are coarse. Re-run with --viewers 8+ before treating the shape as final.`);
  }
  console.log(`  Freeloaders pull from the ORIGIN, so they are part of the bill — that is why the`);
  console.log(`  saving falls faster than the relayer count in a mesh that is already sparse.`);
  console.log(`  Quote the participation rate alongside any saving figure.`);
  process.exitCode = 0;
}

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
  const claim = claimNumbers(on, off);
  const savedPctForClaim = claim && claim.savedPct;
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
  const savedBytes = claim ? claim.savedBytes : 0;
  if (off.httpBytes === 0) {
    console.log(`  origin comparison UNAVAILABLE: the control arm counted 0 bytes (see FAIL below).`);
  } else if (claim.savedPct === null) {
    console.log(`  origin comparison UNAVAILABLE: no video-seconds recorded, cannot normalise.`);
  } else if (savedBytes > 0) {
    const savedPct = claim.savedPct;
    console.log(`  origin served ${mb(savedBytes)} less with P2P on (${mb(off.httpBytes)} -> ${mb(on.httpBytes)}),`);
    console.log(`  = -${savedPct}% per video-second (${(claim.offOriginPerS / 1e3).toFixed(0)} -> ${(claim.onOriginPerS / 1e3).toFixed(0)} KB/s of video).`);
    console.log(`  That subtraction — not the offload ratio — is the bill a platform stops paying.`);
    // ...and in the unit the person paying the bill actually uses. Normalised per video-second
    // first, then extrapolated with the assumptions printed alongside — never a bare dollar figure.
    for (const line of pricingLines(priceSaving({
      savedBytes, videoSeconds: on.heldS, usdPerGB: EFF_USD_PER_GB, videoHoursPerMonth: VIDEO_HOURS,
    }), EFF_RATE_LABEL)) console.log(line);
    // If the arms obtained materially different amounts of video, the raw byte subtraction
    // credits P2P for video it never delivered. Say so rather than quietly publishing it.
    for (const line of skewWarning(claim, off.heldS, on.heldS)) console.log(line);
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

// Only drive browsers when RUN AS A SCRIPT. `claimNumbers` is exported for unit testing, and
// without this guard a plain `import` of this file would launch Chromium and demand a live stack.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

(async () => {
  if (!isMain) return;
  if (participationArg) {
    await runParticipationSweep();
    return;
  }
  if (windowsArg) {
    await runWindowSweep();
    return;
  }
  if (CONTROL) {
    await runControl();
    return;
  }
  if (!sweepArg) {
    await runOnce();
    return;
  }

  console.log(`SWEEP: viewer counts ${sweepArg.join(", ")} — ${WATCH_S}s watch each` +
    (MAX_PEERS ? `, p2pMaxPeers=${MAX_PEERS}` : ", p2pMaxPeers=engine default (50)") + "\n");
  // Any N above the peer cap cannot form a full mesh, so its offload number describes the CAP,
  // not the swarm size. Say so up front rather than letting the curve imply otherwise.
  const capLimit = MAX_PEERS || 50;
  const overCap = sweepArg.filter((n) => n - 1 > capLimit);
  if (overCap.length) {
    console.log(`⚠ N=${overCap.join(",")} exceed p2pMaxPeers=${capLimit} (needs N-1 peers for a full mesh).`);
    console.log("  Those rows measure the peer cap, not swarm scaling. Raise --maxPeers.\n");
  }
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
  console.log("| viewers | offload | p2p bytes | http bytes | p2p segs | peer conns | maxPeers |");
  console.log("|---------|---------|-----------|------------|----------|------------|----------|");
  for (const r of rows) {
    console.log(`| ${String(r.viewers).padStart(7)} | ${String(r.offloadPct + "%").padStart(7)} | ${mb(r.p2pBytes).padStart(9)} | ${mb(r.httpBytes).padStart(10)} | ${String(r.p2pSegments).padStart(8)} | ${String(r.peerConnects).padStart(10)} | ${String(r.p2pMaxPeers ?? "dflt").padStart(8)} |`);
  }
  console.log("\ncsv:");
  console.log("viewers,offload_pct,p2p_bytes,http_bytes,p2p_segments,peer_connects,max_peers");
  for (const r of rows) {
    console.log(`${r.viewers},${r.offloadPct},${r.p2pBytes},${r.httpBytes},${r.p2pSegments},${r.peerConnects},${r.p2pMaxPeers ?? ""}`);
  }
  // The whole point of P2P-0041: is a flat tail physics, or the engine hitting its own cap?
  // peerConnects PEGGED at the cap is the tell. Print the diagnosis, don't leave it to a reader.
  const pegged = rows.filter((r) => r.peerConnects >= capLimit);
  if (pegged.length) {
    console.log(`\n⚠ peer connects reached the cap (${capLimit}) at N=${pegged.map((r) => r.viewers).join(",")}.`);
    console.log("  The engine evicts peers slowest-first every 30s past the cap, so any flattening");
    console.log("  in those rows is PEER POLICY, not a scaling limit of P2P. Re-run with --maxPeers.");
  } else if (MAX_PEERS) {
    console.log(`\npeer connects stayed under the raised cap (${MAX_PEERS}) at every N,` +
      " so the curve's shape is not the peer cap.");
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
