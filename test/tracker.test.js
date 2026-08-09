#!/usr/bin/env node
/**
 * tracker.test.js — proves the signaling tracker actually relays WebRTC offers.
 *
 * This matters because the current blocker is that viewers announce with offers:[]
 * and no peer ever connects. That could be the browser engine's fault OR the
 * tracker's. This test removes the tracker from suspicion (or convicts it) by
 * driving the WS protocol directly with two synthetic peers — no browser involved.
 *
 * Covers the exact trap that once broke this server: bittorrent-tracker's `filter`
 * is async callback-style `(infoHash, params, cb)`, and returning a boolean silently
 * hangs every announce with no response frame at all.
 *
 * Usage: node test/tracker.test.js     (exit 0 = pass, 1 = fail)
 */
import { Server } from "bittorrent-tracker";
import { WebSocket } from "ws";

const PORT = Number(process.env.TRACKER_TEST_PORT || 8201);
const INFO_HASH = "aaaaaaaaaaaaaaaaaaaa"; // must be exactly 20 chars
const PEER_A = "-PM0300-aaaaaaaaaaaa";    // must be exactly 20 chars
const PEER_B = "-PM0300-bbbbbbbbbbbb";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkTruthy(name, actual) {
  const ok = !!actual;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : " — got falsy"}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A synthetic peer: opens a WS, announces, and records every frame it receives.
function connectPeer(peerId, { offers = [] } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const received = [];
    ws.on("message", (m) => {
      try { received.push(JSON.parse(m.toString())); } catch { /* ignore non-JSON */ }
    });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        action: "announce",
        info_hash: INFO_HASH,
        peer_id: peerId,
        numwant: offers.length,
        uploaded: 0, downloaded: 0, left: 0,
        event: "started",
        offers,
      }));
      resolve({ ws, received, peerId });
    });
  });
}

const mkOffer = (id) => ({ offer_id: id, offer: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" } });

(async () => {
  const tracker = new Server({ udp: false, http: false, ws: true, stats: false });
  await new Promise((r) => tracker.listen(PORT, r));
  await sleep(300);

  console.log("a lone peer announcing gets a response (proves filter() is not hanging):");
  const a = await connectPeer(PEER_A, { offers: [mkOffer("offerA1")] });
  await sleep(700);
  {
    const ann = a.received.find((m) => m.action === "announce");
    checkTruthy("received an announce response at all", ann);
    check("info_hash echoed", ann && ann.info_hash, INFO_HASH);
    // NB: we announce left:0, which marks the peer as a SEEDER, so it lands in
    // `complete`, not `incomplete`. Real viewers announce left:0 too, so this is the
    // shape our own stack produces.
    check("counted as 1 complete (seeder) peer", ann && ann.complete, 1);
    check("incomplete is 0 for a seeder", ann && ann.incomplete, 0);
    checkTruthy("interval present", ann && typeof ann.interval === "number");
  }

  console.log("\nsecond peer's offer is RELAYED to the first peer:");
  const b = await connectPeer(PEER_B, { offers: [mkOffer("offerB1")] });
  await sleep(900);
  {
    // The tracker forwards B's offer to A as an announce carrying offer + offer_id.
    const relayed = a.received.find((m) => m.action === "announce" && m.offer);
    checkTruthy("peer A received a relayed offer", relayed);
    check("relayed offer_id is B's", relayed && relayed.offer_id, "offerB1");
    check("relayed offer type", relayed && relayed.offer && relayed.offer.type, "offer");
    checkTruthy("relayed offer carries sdp", relayed && relayed.offer && relayed.offer.sdp);

    const bAnn = b.received.find((m) => m.action === "announce" && !m.offer);
    check("swarm now reports 2 seeders", bAnn && bAnn.complete, 2);
  }

  console.log("\nan answer from A is routed back to B (completes the handshake path):");
  {
    a.ws.send(JSON.stringify({
      action: "announce",
      info_hash: INFO_HASH,
      peer_id: PEER_A,
      to_peer_id: PEER_B,
      answer: { type: "answer", sdp: "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n" },
      offer_id: "offerB1",
    }));
    await sleep(900);
    const ans = b.received.find((m) => m.answer);
    checkTruthy("peer B received the answer", ans);
    check("answer offer_id matches", ans && ans.offer_id, "offerB1");
    check("answer type", ans && ans.answer && ans.answer.type, "answer");
  }

  console.log("\nannouncing with offers:[] yields a response but NO relay (our live symptom):");
  {
    const before = a.received.filter((m) => m.offer).length;
    const c = await connectPeer("-PM0300-cccccccccccc", { offers: [] });
    await sleep(800);
    const cAnn = c.received.find((m) => m.action === "announce");
    checkTruthy("empty-offer peer still gets an announce response", cAnn);
    const after = a.received.filter((m) => m.offer).length;
    check("no new offer relayed to A", after, before);
    c.ws.close();
  }

  a.ws.close();
  b.ws.close();
  await new Promise((r) => tracker.close(r));

  // Everything above drives a Server this test builds ITSELF, which means our actual
  // server/tracker.js had zero coverage until iter 44 — including the config that once hung
  // every announce. These assertions run against the REAL module.
  console.log("\nthe REAL server/tracker.js module (previously untested):");
  {
    const mod = await import("../server/tracker.js");

    // Importing must NOT bind ports. It used to: reaching `lanAddress()` started the tracker on
    // :8000 and metrics on :8001 and the process never exited (measured exit 124), so the module
    // was untestable and an import would have collided with a running dev stack.
    //
    // Asserting a literal `true` here would test NOTHING — my first version did exactly that, and
    // deleting the isMain guard still passed. Probe the DEFAULT metrics port instead: if the
    // import bound it, /stats answers on 8001.
    let defaultPortBound = false;
    try {
      const r = await fetch("http://localhost:8001/stats", { signal: AbortSignal.timeout(1500) });
      defaultPortBound = r.ok;
    } catch { /* nothing listening — the guard held */ }
    check("importing does NOT bind the default metrics port (isMain guard)", defaultPortBound, false);
    check("lanAddress is exported", typeof mod.lanAddress, "function");
    check("startTracker is exported", typeof mod.startTracker, "function");

    // CONFIG GUARD. `filter` MUST stay absent — bittorrent-tracker's filter is async
    // callback-style, and a boolean return silently hangs every announce with no response frame.
    // That cost real debugging time once; this pins it.
    const cfg = mod.TRACKER_CONFIG;
    checkTruthy("TRACKER_CONFIG is exported", !!cfg);
    check("filter is ABSENT (a boolean return hangs every announce)", "filter" in cfg, false);
    // ws is now an OBJECT, not the boolean `true` — options must reach `new WebSocketServer(...)`.
    // It stays ENABLED because bittorrent-tracker starts the WS transport unless `ws === false`,
    // and an object is truthy. Asserting `cfg.ws === true` (the old check) would forbid the very
    // shape that carries the payload cap.
    checkTruthy("ws transport enabled (browsers use only this)", cfg.ws !== false && !!cfg.ws);
    check("ws is an object so options reach the WebSocketServer", typeof cfg.ws, "object");
    // THE FIX (P2P-0062). The WS default maxPayload is 100MB; on a public unauthenticated signaling
    // socket that is a single-frame memory/bandwidth DoS. Signaling frames (SDP + ICE) are a few KB,
    // so the cap must be small and finite — present, a number, > 0, and well under the 100MB default.
    check("ws.maxPayload is set (not the 100MB library default)", typeof cfg.ws.maxPayload, "number");
    checkTruthy("ws.maxPayload is a positive bound", cfg.ws.maxPayload > 0);
    checkTruthy("ws.maxPayload is far below the 100MB default (<= 1MB)",
      cfg.ws.maxPayload <= 1024 * 1024);
    checkTruthy("ws.maxPayload is generous enough for real SDP+ICE (>= 8KB)",
      cfg.ws.maxPayload >= 8 * 1024);
    check("udp disabled", cfg.udp, false);
    check("http disabled", cfg.http, false);

    // lanAddress must return something usable as a host in a URL — a second machine needs a
    // routable address, and "localhost" would resolve to itself.
    const lan = mod.lanAddress();
    check("lanAddress returns a string", typeof lan, "string");
    checkTruthy("and it is non-empty", lan.length > 0);
    checkTruthy("either a bare IPv4 or the localhost fallback",
      lan === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(lan));
    checkTruthy("never a CIDR or interface suffix (would break a URL)",
      !lan.includes("/") && !lan.includes("%"));

    // startTracker must be drivable on throwaway ports AND closeable, or it cannot be used in a
    // test at all — the same lesson as startMetrics returning its server handle.
    const { tracker: t2, metrics: m2 } = mod.startTracker(8321, 8322);
    await sleep(500);
    const stats = await fetch("http://localhost:8322/stats").then((r) => r.json());
    checkTruthy("startTracker also starts the metrics server", typeof stats.offloadRatio === "number");
    checkTruthy("on the port it was given", stats.viewers === 0);

    // BEHAVIORAL PROOF the cap does not break signaling: a real peer must still announce and get a
    // response through the REAL TRACKER_CONFIG (object-form ws with maxPayload), not the boolean
    // `true` the self-built Server above uses. A normal announce is a few hundred bytes, far under
    // the cap, so it must sail through — if the object form had disabled the WS transport, this
    // hangs and fails.
    const realAnnounce = await new Promise((resolve) => {
      const ws = new WebSocket("ws://localhost:8321");
      const got = [];
      ws.on("message", (m) => { try { got.push(JSON.parse(m.toString())); } catch { /* ignore */ } });
      ws.on("error", () => resolve(null));
      ws.on("open", () => ws.send(JSON.stringify({
        action: "announce", info_hash: INFO_HASH, peer_id: PEER_A,
        numwant: 1, uploaded: 0, downloaded: 0, left: 0, event: "started",
        offers: [mkOffer("capped1")],
      })));
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(got); }, 900);
    });
    checkTruthy("a real peer still announces through the capped ws transport",
      Array.isArray(realAnnounce) && realAnnounce.some((m) => m.action === "announce"));

    m2.close();
    await new Promise((r) => t2.close(r));
    checkTruthy("both are closeable", true);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
