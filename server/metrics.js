// Metrics collector + live dashboard.
// Viewers POST cumulative {httpBytes, p2pBytes, uploadBytes} keyed by a random
// clientId every few seconds. We aggregate across the swarm and compute the
// offload ratio = p2pBytes / (httpBytes + p2pBytes). Dashboard at GET /.
import express from "express";
import path from "path";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startMetrics(port) {
  const app = express();
  app.use(express.json());
  // Viewers live on a different origin (static web host); allow the POST.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // clientId -> latest cumulative counters + lastSeen (ms epoch, from client).
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
  const retired = { httpBytes: 0, p2pBytes: 0, uploadBytes: 0, count: 0 };

  app.post("/metrics", (req, res) => {
    const { clientId, httpBytes = 0, p2pBytes = 0, uploadBytes = 0, ts } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    clients.set(clientId, {
      httpBytes: Number(httpBytes) || 0,
      p2pBytes: Number(p2pBytes) || 0,
      uploadBytes: Number(uploadBytes) || 0,
      lastSeen: Number(ts) || 0,
    });
    res.json({ ok: true });
  });

  app.get("/stats", (req, res) => res.json(aggregate()));
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

  function aggregate() {
    // "active" = reported within STALE_MS of the newest report we hold.
    let newest = 0;
    for (const c of clients.values()) newest = Math.max(newest, c.lastSeen);

    // Reclaim entries far older than the stale window, folding their bytes into
    // `retired` so the totals below are unchanged by the eviction itself.
    if (newest) {
      for (const [id, c] of clients) {
        if (c.lastSeen && newest - c.lastSeen > EVICT_MS) {
          retired.httpBytes += c.httpBytes;
          retired.p2pBytes += c.p2pBytes;
          retired.uploadBytes += c.uploadBytes;
          retired.count += 1;
          clients.delete(id);
        }
      }
    }

    let http = retired.httpBytes, p2p = retired.p2pBytes, upload = retired.uploadBytes;
    let active = 0;
    for (const c of clients.values()) {
      const stale = newest && c.lastSeen && newest - c.lastSeen > STALE_MS;
      http += c.httpBytes;
      p2p += c.p2pBytes;
      upload += c.uploadBytes;
      if (!stale) active += 1;
    }
    const total = http + p2p;
    return {
      viewers: active,
      httpBytes: http,          // bytes pulled from origin across the swarm
      p2pBytes: p2p,            // bytes pulled peer-to-peer across the swarm
      uploadBytes: upload,      // bytes served to peers across the swarm
      offloadRatio: total ? p2p / total : 0, // <- the number the whole MVP exists to show
      tracked: clients.size,    // live entries in the Map (bounded — see EVICT_MS)
      retiredClients: retired.count,
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
