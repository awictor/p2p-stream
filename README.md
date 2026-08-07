# P2P Live Streaming MVP — prove bandwidth offload

Viewers relay live video segments to each other over WebRTC so the origin serves few
and peers fan out the rest, cutting the egress bill that dominates streaming costs.
Live, browser-only, and it **measures the ratio** (% bytes served peer-to-peer vs origin).

> **Status: the offload itself is not working yet — measured 0%.** The full pipeline runs
> and everything around it is tested, but no peer ever connects, for a specific reason found
> in the engine source. See [Status](#-status-offload-is-0--a-peer-bootstrap-deadlock-in-the-p2p-engine)
> before trusting any number here.

Not built from scratch: [`p2p-media-loader`](https://github.com/novage/p2p-media-loader)
(OSS, MIT) does the mesh, WebRTC transfer, and HTTP fallback. We wire it to hls.js +
a signaling tracker + a metrics dashboard.

```
OBS/ffmpeg --> LL-HLS CMAF segments --> nginx (ORIGIN :8080)
                                           |
Viewer: <video> + hls.js + p2p-media-loader <--HTTP fallback-- |
   |  \__ WebRTC DataChannel (segments peer<->peer) __/
   \--- WS announce/SDP/ICE --> tracker (:8000)
   \--- POST byte counters ----> metrics + dashboard (:8001)
```

## Components
| Path | Role |
|------|------|
| `origin/segment.sh` | ffmpeg → LL-HLS CMAF fMP4 (loop a file, or ingest OBS RTMP) |
| `origin/nginx.conf` | serve segments at `:8080/hls/`, log origin egress bytes |
| `server/tracker.js` | WebSocket signaling (bittorrent-tracker) for peer discovery |
| `server/metrics.js` + `dashboard.html` | aggregate P2P-vs-HTTP bytes → offload % dashboard |
| `web/index.html` + `p2p-config.js` | viewer: hls.js + p2p-media-loader + stats reporting |
| `test/verify-offload.js` | the offload harness — the only accepted proof (`npm run verify`) |
| `test/metrics.test.js`, `test/tracker.test.js` | unit tests for the ratio maths and signaling (`npm test`) |

## Prereqs
- Node 18+ (`crypto.randomUUID`, modern deps)
- `ffmpeg` and `nginx`. The scripts prefer portable copies under `bin/` if present
  (`bin/ffmpeg-*/bin/ffmpeg.exe`, `bin/nginx-*/nginx.exe`) and fall back to PATH, so no
  admin install is required. `bin/` is gitignored — download them yourself or install normally.
- A sample video at `origin/sample.mp4` for loop mode (any mp4), or OBS for RTMP mode
- Windows note: `origin/nginx.conf` sets `sendfile off`, which is REQUIRED there — with it on,
  nginx caches file handles and 404s the rotating live segments.

## Run (4 terminals)
```bash
npm install

# 1) origin segmenter — loop a local file as a fake live stream
npm run origin:loop            # (or: npm run origin:rtmp, then stream from OBS)

# 2) origin static server (serves the segments)
npm run nginx                  # http://localhost:8080/hls/stream.m3u8

# 3) tracker + metrics dashboard
npm run tracker                # ws://localhost:8000  +  http://localhost:8001

# 4) viewer web app
npm run web                    # http://localhost:5173
```
Open the dashboard: <http://localhost:8001>. Open viewers: <http://localhost:5173>.

> Local dev uses `ws://` and `http://` on localhost (allowed secure context). Deploying
> off-localhost requires **HTTPS + WSS everywhere** — WebRTC and MSE refuse insecure
> contexts. Update URLs in `web/p2p-config.js`.

## Verify
Automated, no services needed:
```bash
npm test                  # 37 assertions: metrics aggregation (21) + tracker signaling (16)
```

With the four services up:
```bash
npm run verify            # the ONLY accepted proof of offload
```
It drives 4 headless viewers, counts announces with/without `offers[]`, listens for the
engine's own fault events, and prints a cause-specific diagnosis. Exit codes: **0** = real
P2P bytes observed, **1** = stack ran but offload stayed 0%, **2** = stack not up.

What currently passes: origin serves the playlist and segments, all four viewers play, byte
accounting and the dashboard are exact, and killing the tracker mid-stream leaves playback
running on HTTP fallback. What currently fails: `verify` exits 1 — see Status below.

> A 90-fragment playlist needs ~180s of wall clock to fill before `verify` is meaningful.

## ⚠️ Status: offload is 0% — a peer-bootstrap deadlock in the P2P engine

**Honest state:** every part of the pipeline is verified except the thing the project exists
to prove. `npm run verify` exits **1** — the stack runs, four viewers play, the tracker
accepts their announces, but no peer ever connects so no peer-to-peer bytes move.

### The cause, read from the engine source
In `web/vendor/p2pml-hlsjs.iife.min.js`, whether a segment may be fetched from a peer is:

```js
isP2PDownloadable: Nr(seg, playback, p2pDownloadTimeWindow)   // window is 6000s — always open
                && registry.isSegmentLoadingOrLoadedBySomeone(seg)

isSegmentLoadingOrLoadedBySomeone(seg) {
  for (const peer of connectedPeers.values())
    if (peer.getSegmentStatus(seg)) return true;
  return false;                       // zero connected peers -> ALWAYS false
}
```

A segment is only P2P-eligible if an **already-connected** peer reports holding it. With no
peers connected, nothing is eligible, so the download scheduler never queues a P2P request, so
the tracker announce goes out with `offers:[]`, so no WebRTC offer is ever exchanged, so no peer
connects. Chicken and egg.

### What has been ruled out (measured, not assumed)
- **Not the buffer/window math.** `p2pDownloadTimeWindow` is 6000s and was never the
  constraint. Five config hypotheses died here — bigger `-hls_time`, removing our buffer
  overrides, `highDemandTimeWindow`→8/→4, `lowLatencyMode:false`. Buffer knobs only affect
  `isHighDemand`, never P2P eligibility.
- **Not the tracker.** `npm run test:tracker` drives the WS protocol with two synthetic peers
  and proves the server relays offers and routes answers correctly (16 assertions). An
  `offers:[]` announce correctly triggers no relay — our exact symptom, as correct behaviour.
- **Not config, and not a thrown error.** `webRtcOffersCount=5`, P2P enabled both directions,
  tracker and swarmId set. `shouldGenerateOffers`/`claimPeer` are never overridden by the core,
  so both default to true. The harness listens for the engine's `offer-failed` warning and sees
  **zero faults** — so offer creation is not failing, it is never attempted.
- **Not WebRTC availability.** Headless Chromium creates offers and gathers ICE fine.

### What IS verified end-to-end
Origin pipeline (ffmpeg→CMAF→nginx, correct MIME/CORS), 4 concurrent viewers playing,
per-segment byte accounting, tracker announce handling and offer relay, metrics aggregation
(37 assertions across `npm test`), HTTP fallback, headless WebRTC capability.

### Verify it yourself
```bash
npm test                  # 37 assertions, ~5s, no services needed
npm run verify            # exit 0 = real P2P bytes seen; 1 = offload still 0%; 2 = stack down
```

## Known limits (by design, for MVP)
- No TURN: symmetric-NAT peers can't P2P, fall back to HTTP (lower offload, not broken).
- Small streams save little (few peers). Offload scales with viewer count.
- Newest live-edge segment is origin-served first, then propagates.

## Deferred (not this MVP)
Ad-free-for-relay reward tier, accounts, token incentive, browser broadcasting, TURN, mobile.
