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
import { issueIdentity, issueCert, makeChallenge, verifyPow } from "./identity.js";
import { installShutdown } from "./shutdown.js";
import { rateLimit, pruneBuckets } from "./ratelimit.js";

// Validated numeric env reader (P2P-0097 config-robustness). Catches NaN AND negatives — the two a
// bare `Number(x ?? d)` / `Number(x)||d` misses (?? only guards null/undefined; ||d maps a legit 0 to
// the default and passes negatives). allowZero accepts 0 as a documented opt-out. Mirrors metrics.js
// numEnv; kept local so tracker.js has no cross-module coupling for a two-line helper.
export function numEnv(name, dflt, { allowZero = false, env = process.env } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  const floor = allowZero ? 0 : Number.MIN_VALUE;
  if (!Number.isFinite(n) || n < floor) {
    console.warn(`[tracker] ignoring ${name}=${JSON.stringify(raw)} (not a ${allowZero ? "non-negative" : "positive"} number); using ${dflt}`);
    return dflt;
  }
  return n;
}
const PORT = numEnv("PORT", 8000);
const METRICS_PORT = numEnv("METRICS_PORT", 8001);
// Per-IP WS connection rate limit (P2P-0094), reusing the same token-bucket as /metrics (P2P-0093).
// The WS signaling server is PUBLIC + UNAUTHENTICATED: one IP opening connections in a loop can churn
// swarm peer lists / exhaust sockets. A per-IP bucket caps new-connection rate; over-cap sockets are
// closed immediately (1013 "try again later"). WS_RATE_CAPACITY<=0 disables (documented opt-out).
//   THREAT (HARD RULE 6): prices new-connection WALL-CLOCK per source IP. Does NOT authenticate the
//   peer and does NOT stop a many-IP distributed flood (needs identity, out of scope). Complements
//   WS_MAX_PAYLOAD (frame size) — this bounds connection RATE, that bounds frame SIZE.
// Read at startTracker() CALL time (not module load) so a test can set the env after importing this
// module — the module is import-cached, so a load-time const would freeze the default for the suite.
function wsRateConfig(env = process.env) {
  return {
    // allowZero: WS_RATE_CAPACITY=0 disables the WS connection limiter (documented opt-out);
    // WS_RATE_REFILL_PER_SEC=0 is valid burst-only. NaN/negative now falls back + warns.
    capacity: numEnv("WS_RATE_CAPACITY", 20, { allowZero: true, env }),
    refillPerSec: numEnv("WS_RATE_REFILL_PER_SEC", 5, { allowZero: true, env }),
  };
}
const ISSUER_PORT = numEnv("ISSUER_PORT", 8002);
// Cert-issuance proof-of-work difficulty (leading zero bits). 0 = OFF (default, back-compat): the
// issuer hands a cert to any pubKey. >0 forces the client to solve a PoW per issuance, pricing a
// sybil ring in CPU (P2P-0079). Positive-int validated so a garbage env falls back to 0, never NaN.
//   CLAMPED to MAX_POW_BITS: the shipped solver (solvePow, maxTries=1<<24) can only reliably find a
//   nonce up to ~24 bits; a larger difficulty would BRICK issuance silently (every POST /issue 400s
//   forever, no cert ever minted). So an over-large env is clamped down and WARNED, never honoured as
//   an un-meetable target — same fail-safe as the iter-84 MAX_* limits. (iter 120 HARDEN)
export const MAX_POW_BITS = 24;
// Pure so a test can drive every branch without mutating process.env. `warn` is injected (defaults to
// console.warn) so a test can assert the warning fires without capturing global console.
export function resolvePowBits(raw, warn = (m) => console.warn(m)) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    if (raw !== undefined && raw !== "" && raw !== "0" && raw !== 0) {
      warn(`[tracker] ISSUE_POW_BITS='${raw}' is not a positive integer; PoW stays OFF (0).`);
    }
    return 0;
  }
  if (n > MAX_POW_BITS) {
    warn(`[tracker] ISSUE_POW_BITS=${n} exceeds MAX_POW_BITS=${MAX_POW_BITS} (the shipped solver's ceiling); clamping to ${MAX_POW_BITS} so issuance is not bricked.`);
    return MAX_POW_BITS;
  }
  return n;
}
const ISSUE_POW_BITS = resolvePowBits(process.env.ISSUE_POW_BITS);

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
const WS_MAX_PAYLOAD = numEnv("WS_MAX_PAYLOAD", 64 * 1024); // 64KB
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

// A tiny HTTP issuance endpoint. Kept as a bare http server (not express) to avoid coupling the
// tracker to the metrics dep, and returned so a test/operator can close it. Routes:
//   GET  /pubkey           -> {trackerPubKey}                 (metrics' TRACKER_PUBKEY setup)
//   GET  /issue/challenge  -> {challenge, bits}               (PoW challenge to solve before issuing)
//   POST /issue {pubKey}                     when bits==0     -> {cert, trackerPubKey}
//   POST /issue {pubKey, challenge, nonce}   when bits>0      -> {cert, ...} iff the PoW verifies
//
// PoW (P2P-0079): when `powBits` > 0, a cert costs a solved proof, so a certified COLLUSION RING is
// priced in CPU rather than free. A challenge is SINGLE-USE and bounded (a solved nonce cannot be
// replayed to mint many certs, and the issuer cannot be memory-flooded by challenge requests).
//   THREAT (HARD RULE 6): PoW prices issuance in CPU; it does NOT prove a distinct HUMAN (more cores
//   / an ASIC mint faster) and it is not a rate limit. bits==0 (default) restores the old behaviour:
//   any pubKey gets a cert. This raises a sybil's cost, it does not eliminate collusion.
export function startIssuer(port, identity, powBits = ISSUE_POW_BITS) {
  const MAX_BODY = 4096; // a pubKey POST is ~100 bytes; cap hard on this public endpoint
  const bits = Number.isInteger(powBits) && powBits > 0 ? powBits : 0;
  // Outstanding unsolved challenges (single-use). Bounded so a flood of GET /issue/challenge cannot
  // grow this without limit; when full the oldest is evicted (a dropped challenge just fails to
  // redeem, forcing the client to fetch a fresh one — no cert is issued on an unknown challenge).
  const MAX_OPEN_CHALLENGES = 4096;
  const openChallenges = new Set();
  const rememberChallenge = (c) => {
    if (openChallenges.size >= MAX_OPEN_CHALLENGES) {
      const oldest = openChallenges.values().next().value;
      openChallenges.delete(oldest);
    }
    openChallenges.add(c);
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && req.url === "/pubkey") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ trackerPubKey: identity.publicKey }));
    }
    if (req.method === "GET" && req.url === "/issue/challenge") {
      const challenge = makeChallenge();
      if (bits > 0) rememberChallenge(challenge); // only track when a redemption will check it
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ challenge, bits }));
    }
    if (req.method === "POST" && req.url === "/issue") {
      let body = "", tooBig = false;
      req.on("data", (c) => { body += c; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on("end", () => {
        if (tooBig) { res.writeHead(413); return res.end(); }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "bad json" })); }
        const { pubKey, challenge, nonce } = parsed || {};
        // PoW gate (only when enabled). The challenge must be one WE issued (single-use) AND the
        // nonce must solve it. Consume the challenge FIRST so a valid-but-rejected attempt (e.g. bad
        // pubKey below) still burns it — a solved proof is worth exactly one issuance attempt.
        if (bits > 0) {
          const known = typeof challenge === "string" && openChallenges.delete(challenge);
          if (!known || !verifyPow(challenge, nonce, bits)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "invalid or missing proof of work" }));
          }
        }
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
// `graceful` opts into SIGTERM/SIGINT drain (P2P-0092). Off by default so a test booting many
// trackers in one process registers no competing signal handlers; the script entrypoint opts in.
export function startTracker(port = PORT, metricsPort = METRICS_PORT, { graceful = false } = {}) {
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

  // PER-IP WS CONNECTION RATE LIMIT (P2P-0094). tracker.ws exists once listen() has wired the WS
  // transport. Hook 'connection' and reuse the token-bucket: over-cap sockets from one IP are closed
  // with 1013 ("try again later") before any announce is processed. Buckets keyed by remote address,
  // pruned so a spray of source IPs can't grow the store unboundedly. Exposed as tracker.wsRateBuckets
  // for tests. Skips wiring when disabled (capacity<=0) so honest single-box dev/test is untouched.
  const wsRateBuckets = {};
  tracker.wsRateBuckets = wsRateBuckets;
  const { capacity: wsCap, refillPerSec: wsRefill } = wsRateConfig();
  if (wsCap > 0 && tracker.ws) {
    let lastPrune = 0;
    tracker.ws.on("connection", (socket, req) => {
      const now = Date.now();
      const addr = (req && (req.socket?.remoteAddress || req.connection?.remoteAddress)) || "unknown";
      if (now - lastPrune > 60000) { pruneBuckets(wsRateBuckets, now, 600000); lastPrune = now; }
      const rl = rateLimit(wsRateBuckets, addr, now, { capacity: wsCap, refillPerSec: wsRefill });
      if (!rl.allowed) {
        // 1013 = "try again later". Close immediately; bittorrent-tracker's own 'connection' handler
        // still runs (listener order), but a closing socket announces nothing useful.
        try { socket.close(1013, "rate limit"); } catch { /* ignore */ }
      }
    });
  }

  // Metrics collector runs alongside (viewers POST their byte counters here).
  const metrics = startMetrics(metricsPort);

  // Identity issuer: mints certs so viewers can earn CERTIFIED credit (P2P-0070/0071). The metrics
  // server verifies certs against this identity's PUBLIC key — set metrics' TRACKER_PUBKEY to it.
  const identity = loadTrackerIdentity();
  const issuer = startIssuer(ISSUER_PORT, identity);
  console.log(`[tracker] identity issuer on http://localhost:${ISSUER_PORT} (POST /issue, GET /pubkey)`);
  console.log(ISSUE_POW_BITS > 0
    ? `[tracker] cert-issuance PoW ENABLED (${ISSUE_POW_BITS} bits) — GET /issue/challenge before POST /issue`
    : "[tracker] cert-issuance PoW OFF (ISSUE_POW_BITS=0) — any pubKey gets a cert");
  if (identity.generated) {
    console.log("[tracker] GENERATED an ephemeral tracker identity. For certified credit, set the");
    console.log(`[tracker]   metrics server's TRACKER_PUBKEY to: ${identity.publicKey}`);
    console.log("[tracker]   and pin it across restarts via TRACKER_PRIVKEY/TRACKER_PUBKEY env.");
  }
  // Graceful drain on SIGTERM/SIGINT (P2P-0092). The tracker holds long-lived WS signaling
  // connections, so an ungraceful kill drops every peer's discovery channel at once on a deploy.
  // Reuse the SAME installShutdown helper as metrics (P2P-0091): close the tracker (which closes its
  // WS + HTTP), and in onClose tear down the sibling metrics + issuer HTTP listeners too, so the
  // process exits 0 with no orphan handle instead of tripping UV_HANDLE_CLOSING 127.
  let shutdownHandle = null;
  if (graceful) {
    shutdownHandle = installShutdown(tracker, {
      onClose: () => Promise.all([
        new Promise((r) => { try { metrics.close(r); } catch { r(); } }),
        new Promise((r) => { try { issuer.close(r); } catch { r(); } }),
      ]),
    });
  }
  return { tracker, metrics, issuer, identity, shutdown: shutdownHandle };
}

// Only bind ports when RUN AS A SCRIPT. Without this guard, merely importing this module to reach
// `lanAddress()` bound :8000 and :8001 and the process never exited (measured: exit 124) — so the
// module could not be unit-tested at all, and a test would have collided with a running dev stack.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) startTracker(PORT, METRICS_PORT, { graceful: true });
