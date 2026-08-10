// WebRTC signaling tracker for peer discovery.
// bittorrent-tracker's WS server IS the signaling server: peers announce a swarm
// (hash of the stream), it returns peer lists and relays WebRTC SDP offer/answer +
// ICE candidates between them. p2p-media-loader speaks this protocol natively.
//
// Start:  node server/tracker.js         (defaults: tracker :8000, metrics :8001)
//         PORT=8000 METRICS_PORT=8001 node server/tracker.js
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import path from "path";
import http from "http";
import { Server } from "bittorrent-tracker";
import { startMetrics } from "./metrics.js";
import { issueIdentity, issueCert } from "./identity.js";

const PORT = Number(process.env.PORT || 8000);
const METRICS_PORT = Number(process.env.METRICS_PORT || 8001);
const ISSUER_PORT = Number(process.env.ISSUER_PORT || 8002);

// The tracker's OWN ed25519 identity — the root of the certified-credit chain (P2P-0071). It signs
// each peer's pubKey (a cert), and the metrics server is configured with only this identity's PUBLIC
// key (TRACKER_PUBKEY) to VERIFY certs. The private key lives ONLY here.
//   Loaded from TRACKER_PRIVKEY / TRACKER_PUBKEY if set (HARD RULE 5: secret via env, never in the
//   repo); otherwise a fresh keypair is generated at boot and its public key logged so an operator
//   can copy it to the metrics server's TRACKER_PUBKEY. A generated key is fine for dev/loopback; a
//   real deploy sets the env so the pair survives restarts.
export function loadTrackerIdentity(env = process.env) {
  if (env.TRACKER_PRIVKEY && env.TRACKER_PUBKEY) {
    return { privateKey: env.TRACKER_PRIVKEY, publicKey: env.TRACKER_PUBKEY, generated: false };
  }
  return { ...issueIdentity(), generated: true };
}

// Issue a cert for a peer-submitted public key: the tracker's signature over that pubKey. Pure —
// takes the identity so it is testable without booting anything. Returns null on bad input.
export function issueTrackerCert(peerPublicKeyB64, identity) {
  if (!identity || typeof identity.privateKey !== "string") return null;
  return issueCert(peerPublicKeyB64, identity.privateKey);
}

// Node binds 0.0.0.0 by default, so these services are ALREADY reachable from other
// machines on the LAN. Print the routable address rather than "localhost", which is what
// a second machine needs and which the old log line actively hid.
export function lanAddress() {
  const nets = Object.values(networkInterfaces()).flat();
  const hit = nets.find((n) => n && n.family === "IPv4" && !n.internal);
  return hit ? hit.address : "localhost";
}

// The tracker CONFIG, exported so a test can assert its shape without binding a port.
// This config is not cosmetic: a boolean-returning `filter` once hung every announce with no
// response frame at all, and re-enabling `udp`/`http` would expose transports browsers never use.
// It had zero coverage until iter 44 because the only tracker test builds its own Server.
// Signaling frames are small: a WebRTC SDP offer/answer plus ICE candidates is a few KB. But this
// WS server is PUBLIC and UNAUTHENTICATED, and bittorrent-tracker spreads `ws` straight into
// `new WebSocketServer({...})`, whose `maxPayload` DEFAULTS TO 100MB. That default let a peer (or a
// script hitting the open port) ship 100MB frames at peer discovery — an unbounded-client-input
// memory/bandwidth DoS on the one server the whole swarm depends on, the same class as the
// unbounded metrics Map fixed in P2P-0061. 64KB is ~10x the largest real signaling message.
//   THREAT NOTE: this bounds FRAME SIZE. It does NOT authenticate the signaling peer, and does not
//   stop a flood of small valid frames — that needs authenticated identity at the tracker, out of
//   scope (roadmap.md). It closes the single-giant-frame vector, not identity.
const WS_MAX_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD || 64 * 1024); // 64KB
export const TRACKER_CONFIG = {
  udp: false,
  http: false,
  // Object form (not the boolean `true`) so options reach `new WebSocketServer(...)`. Still enabled
  // — an object is truthy, and bittorrent-tracker starts the WS transport unless `ws === false`.
  ws: { maxPayload: WS_MAX_PAYLOAD },
  stats: false,
  // NB: filter is async callback-style `(infoHash, params, cb)` — you MUST call
  // cb() to allow (or cb(err) to reject). Returning a boolean silently hangs every
  // announce (no response, no peer exchange). Omit it to accept all swarms.
};

// A tiny HTTP issuance endpoint: POST /issue {pubKey} -> {cert, trackerPubKey}. This is how a viewer
// turns its self-minted keypair into a tracker-certified one before it starts reporting. Kept as a
// bare http server (not express) to avoid coupling the tracker to the metrics dep, and returned so a
// test/operator can close it. GET /pubkey exposes the tracker public key for TRACKER_PUBKEY setup.
//   NOTE (HARD RULE 6): there is NO rate limit or proof-of-work here, so N browsers => N certs. This
//   binds a key to an issuance event, it does not prove a distinct human. Rate/PoW is a later step.
export function startIssuer(port, identity) {
  const MAX_BODY = 4096; // a pubKey POST is ~100 bytes; cap hard on this public endpoint
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && req.url === "/pubkey") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ trackerPubKey: identity.publicKey }));
    }
    if (req.method === "POST" && req.url === "/issue") {
      let body = "", tooBig = false;
      req.on("data", (c) => { body += c; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on("end", () => {
        if (tooBig) { res.writeHead(413); return res.end(); }
        let pubKey;
        try { pubKey = JSON.parse(body).pubKey; } catch { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "bad json" })); }
        const cert = issueTrackerCert(pubKey, identity);
        if (!cert) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "pubKey required" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ cert, trackerPubKey: identity.publicKey }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port);
  return server;
}

// Build and start the real services. Exported so a test can drive it on throwaway ports and
// close it, rather than being forced to reimplement the wiring it is meant to be checking.
export function startTracker(port = PORT, metricsPort = METRICS_PORT) {
  const tracker = new Server(TRACKER_CONFIG);

  tracker.on("error", (err) => console.error("[tracker] error:", err.message));
  tracker.on("warning", (err) => console.warn("[tracker] warn:", err.message));

  tracker.on("start", () => {
    const n = Object.keys(tracker.torrents).length;
    console.log(`[tracker] peer announced; active swarms: ${n}`);
  });

  tracker.listen(port, () => {
    const lan = lanAddress();
    console.log(`[tracker] WS signaling on ws://localhost:${port}`);
    if (lan !== "localhost") console.log(`[tracker] reachable from LAN at ws://${lan}:${port}`);
  });

  // Metrics collector runs alongside (viewers POST their byte counters here).
  const metrics = startMetrics(metricsPort);

  // Identity issuer: mints certs so viewers can earn CERTIFIED credit (P2P-0070/0071). The metrics
  // server verifies certs against this identity's PUBLIC key — set metrics' TRACKER_PUBKEY to it.
  const identity = loadTrackerIdentity();
  const issuer = startIssuer(ISSUER_PORT, identity);
  console.log(`[tracker] identity issuer on http://localhost:${ISSUER_PORT} (POST /issue, GET /pubkey)`);
  if (identity.generated) {
    console.log("[tracker] GENERATED an ephemeral tracker identity. For certified credit, set the");
    console.log(`[tracker]   metrics server's TRACKER_PUBKEY to: ${identity.publicKey}`);
    console.log("[tracker]   and pin it across restarts via TRACKER_PRIVKEY/TRACKER_PUBKEY env.");
  }
  return { tracker, metrics, issuer, identity };
}

// Only bind ports when RUN AS A SCRIPT. Without this guard, merely importing this module to reach
// `lanAddress()` bound :8000 and :8001 and the process never exited (measured: exit 124) — so the
// module could not be unit-tested at all, and a test would have collided with a running dev stack.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) startTracker();
