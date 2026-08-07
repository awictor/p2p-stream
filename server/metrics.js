// Metrics collector + live dashboard.
// Viewers POST cumulative {httpBytes, p2pBytes, uploadBytes} keyed by a random
// clientId every few seconds. We aggregate across the swarm and compute the
// offload ratio = p2pBytes / (httpBytes + p2pBytes). Dashboard at GET /.
import express from "express";
import path from "path";
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
  const STALE_MS = 15000; // drop a viewer from "active" if silent this long

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
    let http = 0, p2p = 0, upload = 0, active = 0;
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
    };
  }

  app.listen(port, () => console.log(`[metrics] dashboard http://localhost:${port}`));
}
