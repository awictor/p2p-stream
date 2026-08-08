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

  // K-of-N attestation filter (see the aggregation below). Overridable so a deployment can tighten
  // it and so tests can pin behaviour at both sides of the boundary.
  // MIN_ATTESTERS=2 is the weakest useful setting: it kills a lone forged voucher while still
  // crediting an honest pair. MAX_VOUCH_PER_ATTESTER caps how much ONE receiver can be worth, which
  // is what makes a bigger ring cost more rather than nothing.
  const MIN_ATTESTERS = Number(process.env.MIN_ATTESTERS || 2);
  const MAX_VOUCH_PER_ATTESTER = Number(process.env.MAX_VOUCH_PER_ATTESTER || 20e6); // 20MB

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
  // peerId -> { clientId, lastSeen }, so an attested credit can be attributed to a tracked
  // viewer. Viewers announce their own engine peerId; without this the server sees two unrelated
  // namespaces. `lastSeen` exists because this Map MUST be evictable: peerIds are minted fresh
  // per page load, so a busy dashboard would otherwise accumulate one entry per viewer forever
  // (measured: 200 viewers evicted from `clients`, all 200 mappings retained). Keeping stale
  // mappings is also a correctness bug, not only a leak — credit for a long-departed peerId was
  // still being attributed to its evicted client.
  const peerToClient = new Map();

  app.post("/metrics", (req, res) => {
    const { clientId, httpBytes = 0, p2pBytes = 0, uploadBytes = 0, ts, peerId, attest } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    // Self-declared mapping. Fine for a cross-check — a peer that lies here mis-credits itself,
    // and cannot mint bytes that no receiver reported.
    if (typeof peerId === "string" && peerId) peerToClient.set(peerId, { clientId, lastSeen: now() });
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
    // Evict stale peerId mappings on the same clock. Without this the Map is unbounded AND
    // credit keeps resolving to clients that left long ago; an attacker who learns a retired
    // peerId could aim credit at a viewer that no longer exists. After eviction such a credit
    // degrades to `unmapped:` — visible and unattributed, which is the honest outcome.
    for (const [pid, m] of peerToClient) {
      if (t - m.lastSeen > EVICT_MS) peerToClient.delete(pid);
    }
    // A viewer NEVER attests for itself — self-attestation is exactly the forgery this exists to
    // detect, so it is dropped rather than counted.
    const attestedByClient = {};
    let attestedTotal = retired.attestedUploadBytes;
    // Who vouched for whom, and how much each one vouched. Needed for the K-of-N filter below:
    // a raw sum cannot tell "20 receivers each saw 1MB" from "one receiver claims 20MB".
    const vouchers = new Map();   // creditedKey -> Map(attesterId -> bytes)
    for (const [attestingId, a] of attestations) {
      for (const [pid, bytes] of Object.entries(a.byPeer)) {
        const m = peerToClient.get(pid);
        const servedBy = m && m.clientId;
        if (servedBy && servedBy === attestingId) continue;   // self-attestation, ignored
        attestedTotal += bytes;
        const key = servedBy || `unmapped:${pid}`;
        attestedByClient[key] = (attestedByClient[key] || 0) + bytes;
        if (!vouchers.has(key)) vouchers.set(key, new Map());
        const v = vouchers.get(key);
        v.set(attestingId, (v.get(attestingId) || 0) + bytes);
      }
    }

    // K-OF-N FILTER. Iter 43 demonstrated that a ring of N tabs attesting for each other produces
    // perfect mutual corroboration and sails past the forgery detector, because peerIds are free.
    // This does not fix that — nothing here can, since a 2-member ring is byte-identical to two
    // honest peers — but it METERS it: credit only counts when at least K DISTINCT attesters vouch,
    // and no single attester can contribute more than CAP of one peer's credit.
    //
    // The cap is the half that matters. A bare "≥K distinct attesters" rule is defeated for FREE by
    // enlarging the ring: every member of a K+1 ring already has K attesters. Capping per-attester
    // vouching means each fake identity must carry real traffic to be worth anything, so the
    // attacker's cost scales with the credit claimed instead of being flat.
    //
    // ⚠ STILL NOT AN AUTHORISATION TO PAY. It raises the price of forgery; it does not make the
    // number trustworthy. Only authenticated peer identity does that, and this MVP has none.
    const attestedFilteredByClient = {};
    let attestedFilteredTotal = 0;
    for (const [key, v] of vouchers) {
      if (v.size < MIN_ATTESTERS) continue;                   // too few independent witnesses
      // Cap each voucher's contribution, then sum. Sorting is unnecessary — the cap is per-attester.
      let sum = 0;
      for (const bytes of v.values()) sum += Math.min(bytes, MAX_VOUCH_PER_ATTESTER);
      attestedFilteredByClient[key] = sum;
      attestedFilteredTotal += sum;
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
      // K-of-N FILTERED credit, reported ALONGSIDE the raw figure rather than replacing it. The gap
      // between them is the point: a large drop means credit was resting on too few witnesses or on
      // one voucher claiming too much. Hiding the raw number would hide that signal.
      attestedFilteredUploadBytes: attestedFilteredTotal,
      attestedFilteredByClient,
      minAttesters: MIN_ATTESTERS,
      maxVouchPerAttester: MAX_VOUCH_PER_ATTESTER,
      // Per-client SELF-REPORTED upload, so the two views can be diffed per viewer rather than
      // only in aggregate. A swarm-level total hides a single liar: one peer inflating its claim
      // while three report honestly barely moves the sum, but stands out per client.
      uploadByClient: Object.fromEntries([...clients].map(([id, c]) => [id, c.uploadBytes])),
      // Exposed so the bound is OBSERVABLE. An unbounded Map with no counter stays invisible
      // until it is a production problem; `tracked` earned its place the same way.
      trackedPeerIds: peerToClient.size,
    };
  }

  // RETURN the server handle so callers can close it. Without this a test that starts a metrics
  // server can never exit — the listener holds the event loop open, so `node test/x.js` hangs
  // until an external timeout kills it. That is survivable for a standalone probe but would stall
  // `npm test` forever, so any test in the suite must be able to `.close()` what it started.
  return app.listen(port, () => {
    console.log(`[metrics] dashboard http://localhost:${port}`);
    // Also print the LAN address: a viewer on another machine must POST here, and
    // "localhost" would resolve to that machine itself.
    const nets = Object.values(networkInterfaces()).flat();
    const lan = nets.find((n) => n && n.family === "IPv4" && !n.internal);
    if (lan) console.log(`[metrics] reachable from LAN at http://${lan.address}:${port}`);
  });
}
