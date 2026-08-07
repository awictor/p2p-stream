// P2P + reporting config for the viewer. Loaded before the inline player script in
// index.html.
//
// The server host is DERIVED from the page URL, not hardcoded, so a second machine that
// loads http://<host>:5173 automatically talks to <host> for origin/tracker/metrics
// instead of resolving "localhost" to itself and finding nothing. That single detail is
// what makes a cross-machine run possible without editing this file.
//
// Precedence: ?host= query param > the hostname the page was served from > localhost.
// Override the whole thing per-service with ?origin=, ?tracker=, ?metrics= if the
// services are split across hosts.
//
// ⚠️ CROSS-MACHINE GOTCHA (verified in the engine source): the swarm's infoHash is
// `${version}-${swarmId}-${hash(streamUrl)}`, so the STREAM URL IS PART OF THE SWARM
// IDENTITY. Two viewers with the same swarmId but different stream URLs — say
// http://localhost:8080/... and http://192.168.68.66:8080/... — land in DIFFERENT
// swarms and will never see each other, silently, with no error.
// So for a multi-machine run every viewer must resolve the SAME streamUrl string:
// have all machines (including the host one) load the page by the host's LAN IP or
// DNS name, e.g. http://192.168.68.66:5173 — do NOT mix that with localhost.
(function () {
  const q = new URLSearchParams(location.search);
  // location.hostname is "" for file:// URLs, so fall back to localhost.
  const host = q.get("host") || location.hostname || "localhost";
  // The page is plain http on localhost, but off-localhost deployments need https/wss
  // (WebRTC and MSE refuse insecure contexts). Follow the page's own scheme.
  const secure = location.protocol === "https:";
  const http = secure ? "https" : "http";
  const ws = secure ? "wss" : "ws";

  window.P2P_DEMO = {
    // HLS manifest served by the origin (nginx). This is the HTTP fallback source too.
    streamUrl: q.get("origin") || `${http}://${host}:8080/hls/stream.m3u8`,

    // WebSocket signaling tracker (bittorrent-tracker).
    announceTrackers: [q.get("tracker") || `${ws}://${host}:8000`],

    // Metrics collector — viewers POST byte counters here for the dashboard.
    metricsUrl: q.get("metrics") || `${http}://${host}:8001/metrics`,

    // ICE: public STUN only, no TURN (MVP). Symmetric-NAT peers that can't connect
    // simply fall back to HTTP origin — playback never breaks, offload just drops.
    //
    // DO NOT add `?transport=udp` to a stun: URL. That query param is only legal on
    // turn:/turns: URLs, and Chromium rejects the whole ICE config with
    //   Failed to construct 'RTCPeerConnection': '...' is not a valid stun or turn URL
    // which makes EVERY RTCPeerConnection constructor throw. The engine swallows that
    // into an "offer-failed" warning and silently drops the offer, so the tracker
    // announce goes out with offers:[] and no peer can ever connect. This exact typo
    // (copied from an upstream docs snippet) was the whole reason offload sat at 0%.
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],

    // All viewers of one stream must share a swarmId to find each other. Viewers on
    // DIFFERENT machines must use the same value or they form separate swarms.
    swarmId: q.get("swarm") || "p2p-stream-demo-1",

    // How often each viewer reports counters to the dashboard.
    reportIntervalMs: 3000,
  };
})();
