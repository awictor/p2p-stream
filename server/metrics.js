// Metrics collector + live dashboard.
// Viewers POST cumulative {httpBytes, p2pBytes, uploadBytes} keyed by a random
// clientId every few seconds. We aggregate across the swarm and compute the
// offload ratio = p2pBytes / (httpBytes + p2pBytes). Dashboard at GET /.
import express from "express";
import path from "path";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `now` is injectable purely so tests can drive the stale/evict windows deterministically
// instead of sleeping for real seconds. Production always uses Date.now.
export function startMetrics(port, { now = () => Date.now() } = {}) {
  const app = express();
  app.use(express.json());
  // Viewers live on a different origin (static web host); allow the POST.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // clientId -> latest cumulative counters + lastSeen (ms epoch, stamped SERVER-SIDE).
  const clients = new Map();
  const STALE_MS = 15000; // drop a viewer from the ACTIVE count if silent this long
  // Long-gone viewers are evicted from the Map so it cannot grow without bound on a
  // long-running dashboard. EVICT_MS is deliberately much larger than STALE_MS: a
  // viewer that goes quiet briefly should stop counting as active but keep its entry,
  // so a later report updates in place instead of double-counting.
  const EVICT_MS = STALE_MS * 20; // 5 minutes

  // Evicted clients' counters are FOLDED IN HERE rather than discarded. Reports are
  // cumulative snapshots, so deleting an entry would subtract bytes that really were
  // served and make offloadRatio jump backwards — which would also break the sweep's
  // delta arithmetic and contradict the published numbers. Session totals stay
  // monotonic; only the per-client bookkeeping is reclaimed.
  const retired = { httpBytes: 0, p2pBytes: 0, uploadBytes: 0, count: 0, attestedUploadBytes: 0 };

  // RECEIVER-ATTESTED UPLOAD. `uploadBytes` above is what a viewer claims about ITSELF, which a
  // modified client forges in one line — so the ad-free-for-relay tier cannot pay out on it.
  // Instead, every viewer reports what its PEERS served IT (peerId -> bytes, learned from
  // onSegmentLoaded), and we credit the server from those third-party reports.
  //
  // ⚠ THREAT MODEL. This defeats SOLO forgery: a peer inflating its own uploadBytes gains no
  // attested credit, because credit only arrives from other viewers. It does NOT defeat
  // COLLUSION — one browser can open N tabs that attest for each other, and peer identity here
  // is a self-chosen engine id with no proof of work or possession behind it. Closing that needs
  // authenticated peer identity at the tracker, which is out of scope. Attested totals are a
  // CROSS-CHECK, not an authorisation to pay.
  //
  // Keyed by the ATTESTING client so reports stay idempotent: each viewer's latest snapshot
  // replaces its previous one, exactly like the byte counters. Summing raw POSTs instead would
  // multiply every credit by the report interval.
  const attestations = new Map();  // attestingClientId -> { byPeer: {peerId: bytes}, lastSeen }
  // peerId -> clientId, so an attested credit can be attributed to a tracked viewer. Viewers
  // announce their own engine peerId; without this the server sees two unrelated namespaces.
  const peerToClient = new Map();

  app.post("/metrics", (req, res) => {
    const { clientId, httpBytes = 0, p2pBytes = 0, uploadBytes = 0, ts, peerId, attest } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    // Self-declared mapping. Fine for a cross-check — a peer that lies here mis-credits itself,
    // and cannot mint bytes that no receiver reported.
    if (typeof peerId === "string" && peerId) peerToClient.set(peerId, clientId);
    if (attest && typeof attest === "object") {
      const byPeer = {};
      for (const [pid, bytes] of Object.entries(attest)) {
        const n = Number(bytes);
        if (typeof pid === "string" && pid && Number.isFinite(n) && n > 0) byPeer[pid] = n;
      }
      attestations.set(clientId, { byPeer, lastSeen: now() });
    }
    // Recency is stamped SERVER-SIDE, not taken from the client. Trusting `ts` meant a
    // report without one got lastSeen=0, and the `c.lastSeen &&` guards below then
    // short-circuited on that falsy zero — so such a client was never stale, never
    // evicted, and counted as an active viewer forever. Server time also can't be
    // skewed by a wrong client clock or forged to keep an entry alive.
    // `ts` is still accepted and echoed as `clientTs` for debugging; nothing reads it.
    clients.set(clientId, {
      httpBytes: Number(httpBytes) || 0,
      p2pBytes: Number(p2pBytes) || 0,
      uploadBytes: Number(uploadBytes) || 0,
      lastSeen: now(),
      clientTs: Number(ts) || null,
    });
    res.json({ ok: true });
  });

  app.get("/stats", (req, res) => res.json(aggregate()));
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

  function aggregate() {
    // Staleness is measured against server time, NOT against the newest report we hold.
    // Comparing to the newest report meant a swarm that went entirely silent kept its
    // final viewers "active" forever, because nothing newer ever arrived to age them out.
    const t = now();

    // Reclaim entries far older than the stale window, folding their bytes into
    // `retired` so the totals below are unchanged by the eviction itself.
    for (const [id, c] of clients) {
      if (t - c.lastSeen > EVICT_MS) {
        retired.httpBytes += c.httpBytes;
        retired.p2pBytes += c.p2pBytes;
        retired.uploadBytes += c.uploadBytes;
        retired.count += 1;
        clients.delete(id);
      }
    }

    let http = retired.httpBytes, p2p = retired.p2pBytes, upload = retired.uploadBytes;
    let active = 0;
    for (const c of clients.values()) {
      http += c.httpBytes;
      p2p += c.p2pBytes;
      upload += c.uploadBytes;
      if (t - c.lastSeen <= STALE_MS) active += 1;
    }

    // Fold attestations into per-peer credit. Evict alongside the byte counters so a long run
    // cannot grow the Map without bound, keeping the retired total monotonic for the same reason.
    for (const [id, a] of attestations) {
      if (t - a.lastSeen > EVICT_MS) {
        for (const bytes of Object.values(a.byPeer)) retired.attestedUploadBytes += bytes;
        attestations.delete(id);
      }
    }
    // A viewer NEVER attests for itself — self-attestation is exactly the forgery this exists to
    // detect, so it is dropped rather than counted.
    const attestedByClient = {};
    let attestedTotal = retired.attestedUploadBytes;
    for (const [attestingId, a] of attestations) {
      for (const [pid, bytes] of Object.entries(a.byPeer)) {
        const servedBy = peerToClient.get(pid);
        if (servedBy && servedBy === attestingId) continue;   // self-attestation, ignored
        attestedTotal += bytes;
        const key = servedBy || `unmapped:${pid}`;
        attestedByClient[key] = (attestedByClient[key] || 0) + bytes;
      }
    }

    const total = http + p2p;
    return {
      viewers: active,
      httpBytes: http,          // bytes pulled from origin across the swarm
      p2pBytes: p2p,            // bytes pulled peer-to-peer across the swarm
      uploadBytes: upload,      // bytes served to peers across the swarm (SELF-REPORTED)
      offloadRatio: total ? p2p / total : 0, // <- the number the whole MVP exists to show
      tracked: clients.size,    // live entries in the Map (bounded — see EVICT_MS)
      retiredClients: retired.count,
      // Third-party view of the same bytes: what RECEIVERS say each peer served them. Compare
      // against uploadBytes — a large one-sided gap means someone is misreporting.
      attestedUploadBytes: attestedTotal,
      attestedByClient,
      attestingClients: attestations.size,
    };
  }

  app.listen(port, () => {
    console.log(`[metrics] dashboard http://localhost:${port}`);
    // Also print the LAN address: a viewer on another machine must POST here, and
    // "localhost" would resolve to that machine itself.
    const nets = Object.values(networkInterfaces()).flat();
    const lan = nets.find((n) => n && n.family === "IPv4" && !n.internal);
    if (lan) console.log(`[metrics] reachable from LAN at http://${lan.address}:${port}`);
  });
}
