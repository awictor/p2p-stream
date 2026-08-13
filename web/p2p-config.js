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

    // Cert-issuance endpoint (server/tracker.js). The viewer GETs /issue/challenge, solves the PoW
    // if the tracker set one, and POSTs its pubKey to /issue to obtain a tracker cert — which turns
    // its signed report into CERTIFIED credit (P2P-0083). Base URL; the viewer appends the paths.
    issuerUrl: q.get("issuer") || `${http}://${host}:8002`,

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

    // ?p2p=off turns this viewer into a pure-HTTP control arm. The harness needs it to
    // answer "was playback actually better WITH P2P?" — a QoE number with no baseline is
    // an anecdote, since zero stalls might just be how this stack always plays video.
    // Anything other than the exact string "off" leaves P2P ON, so a typo fails SAFE
    // (towards measuring P2P) rather than silently reporting a control run as the real one.
    p2pEnabled: q.get("p2p") !== "off",

    // ?p2pWindow=<seconds> overrides the engine's p2pDownloadTimeWindow (default 6000s — yes,
    // seconds, ~100 minutes of read-ahead eligibility, vs 3000 for HTTP). Measured at iter 31:
    // 33% of P2P fetches are never appended to the media buffer, so the window is the prime
    // suspect for a viewer paying 1.55x the bytes for the same video. Null means "leave the
    // engine default alone" — an unparseable or non-positive value must NOT silently become 0,
    // which would disable P2P entirely and read as "the tuning killed offload".
    p2pWindowS: (() => {
      const raw = q.get("p2pWindow");
      if (raw === null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),

    // ?p2pMaxPeers=<n> raises the engine's peer cap (default 50). Added to settle whether the
    // flattening top of our published offload curve was PHYSICS or the engine's peer POLICY: past
    // the cap the engine evicts peers slowest-bandwidth-first every 30s, and the N=8 row had
    // measured exactly 50 connects, which looked like the cap binding.
    //
    // MEASURED (iter 49, --sweep 8,12,16 --maxPeers 200): it was NOT the cap. N=8 measured 50
    // connects AGAIN at cap 200, so the 50 was swarm shape, not a limit; connects ran 50/90/134,
    // all well under 200, and offload still only went 80→84→85%. The flattening is real.
    // Keep the flag anyway — it is the only way to prove a future flat row isn't policy.
    //
    // Null = leave the engine default alone. A non-positive or unparseable value must NOT become 0,
    // which would mean "no peers at all" and would read as P2P being broken by the flag.
    p2pMaxPeers: (() => {
      const raw = q.get("p2pMaxPeers");
      if (raw === null || raw === "") return null;
      // FLOOR BEFORE the >0 test, not after. The other way round, `?p2pMaxPeers=0.5` passes
      // n > 0 and then floors to 0 — the exact "connect to no peers" value this guard exists
      // to prevent. Caught by test/config.test.js on the first run of that assertion.
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),

    // ?uploadCapMB=<MB> stops this viewer relaying once it has uploaded that much. Measured
    // iter 33: the viewer's ~55% extra bandwidth is INHERENT to the design (narrowing the
    // download window cuts the saving just as fast), so the only remaining lever is consent —
    // let a viewer bound what they spend instead of pretending the cost can be tuned away.
    //
    // ⚠ SECURITY: this bounds an HONEST viewer's cost. It is NOT an anti-abuse control. The
    // byte counter lives in the page and is trivially forgeable, so a modified client can
    // report any figure it likes; see the note in index.html.
    //
    // Null = uncapped (today's behaviour). A non-positive or unparseable value must NOT become
    // 0, which would mean "never relay" — a malformed flag would then silently look like the
    // cap feature disabling P2P altogether.
    uploadCapMB: (() => {
      const raw = q.get("uploadCapMB");
      if (raw === null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),

    // How often each viewer reports counters to the dashboard.
    reportIntervalMs: 3000,
  };
})();
