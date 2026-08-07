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

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
