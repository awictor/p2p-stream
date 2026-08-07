// WebRTC signaling tracker for peer discovery.
// bittorrent-tracker's WS server IS the signaling server: peers announce a swarm
// (hash of the stream), it returns peer lists and relays WebRTC SDP offer/answer +
// ICE candidates between them. p2p-media-loader speaks this protocol natively.
//
// Start:  node server/tracker.js         (defaults: tracker :8000, metrics :8001)
//         PORT=8000 METRICS_PORT=8001 node server/tracker.js
import { Server } from "bittorrent-tracker";
import { startMetrics } from "./metrics.js";

const PORT = Number(process.env.PORT || 8000);
const METRICS_PORT = Number(process.env.METRICS_PORT || 8001);

const tracker = new Server({
  udp: false,
  http: false,
  ws: true,          // only the WebSocket transport (that's what browsers/WebRTC use)
  stats: false,
  // NB: filter is async callback-style `(infoHash, params, cb)` — you MUST call
  // cb() to allow (or cb(err) to reject). Returning a boolean silently hangs every
  // announce (no response, no peer exchange). Omit it to accept all swarms.
});

tracker.on("error", (err) => console.error("[tracker] error:", err.message));
tracker.on("warning", (err) => console.warn("[tracker] warn:", err.message));

let peakClients = 0;
tracker.on("start", () => {
  const n = Object.keys(tracker.torrents).length;
  console.log(`[tracker] peer announced; active swarms: ${n}`);
});

tracker.listen(PORT, () => {
  console.log(`[tracker] WS signaling on ws://localhost:${PORT}`);
});

// Metrics collector runs alongside (viewers POST their byte counters here).
startMetrics(METRICS_PORT);
