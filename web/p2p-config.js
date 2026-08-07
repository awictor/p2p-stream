// P2P + reporting config for the viewer. Loaded before the inline player script in
// index.html. Edit these to point at your deployed servers.
window.P2P_DEMO = {
  // HLS manifest served by the origin (nginx). This is the HTTP fallback source too.
  streamUrl: "http://localhost:8080/hls/stream.m3u8",

  // WebSocket signaling tracker (bittorrent-tracker). Must be wss:// in production
  // (secure context); ws://localhost is allowed for local dev.
  announceTrackers: ["ws://localhost:8000"],

  // Metrics collector — viewers POST byte counters here for the dashboard.
  metricsUrl: "http://localhost:8001/metrics",

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

  // All viewers of one stream must share a swarmId to find each other.
  swarmId: "p2p-stream-demo-1",

  // How often each viewer reports counters to the dashboard.
  reportIntervalMs: 3000,
};
