# P2P Live Streaming MVP — prove bandwidth offload

Viewers relay live video segments to each other over WebRTC so the origin serves few
and peers fan out the rest, cutting the egress bill that dominates streaming costs.
Live, browser-only, and it **measures the ratio** (% bytes served peer-to-peer vs origin).

> **Status: working, and offload rises with swarm size — 45% at 2 viewers, 79% at 8.**
> Measured by `npm run verify:sweep` on one machine. Not yet reproduced across two machines.
> See [Status](#-status-working--offload-rises-with-swarm-size).

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
npm run verify            # the ONLY accepted proof of offload (~2min)
npm run verify:sweep      # offload vs viewer count, 1/2/4/8 (~4min)
```
It drives 4 headless viewers, counts announces with/without `offers[]`, listens for the
engine's own fault events, and prints a cause-specific diagnosis on failure. Exit codes:
**0** = real P2P bytes observed (current state), **1** = stack ran but offload stayed 0%,
**2** = stack not up.

> A 90-fragment playlist needs ~180s of wall clock to fill before `verify` is meaningful.

## ✅ Status: working — offload rises with swarm size

`npm run verify:sweep` runs the harness once per viewer count. More viewers means more peers
to pull from, so offload climbs — which is the whole economic argument:

| viewers | offload | served P2P | served by origin | peer connections |
|---|---|---|---|---|
| 1 | **0%** | 0.0MB | 31.5MB | 0 |
| 2 | 45% | 77.1MB | 95.4MB | 2 |
| 4 | 67% | 236.5MB | 114.7MB | 12 |
| 8 | **79%** | 585.8MB | 158.3MB | 50 |

At 8 concurrent viewers the origin served 79% less. `N=1` at 0% is correct — a lone viewer has
no peer to pull from — and peer connections growing 2→12→50 is the mesh fanning out rather than
a star. `N=2` measured 45% and 44% on independent runs.

**Upload accounting cross-checks.** Every byte downloaded from a peer must have been uploaded by
one, and it balances: 171.6MB down vs 172.6MB up in a 4-viewer run (0.6% skew). The harness now
prints an `upload conservation` ratio each run, because this silently read 0 B until iteration 12.

Also verified: origin pipeline (ffmpeg→CMAF→nginx, correct MIME/CORS), tracker announce handling
and offer relay, metrics aggregation (37 assertions), HTTP fallback survives killing the tracker
mid-stream, headless WebRTC.

**Not yet proven: anything off localhost.** These viewers are tabs on one machine sharing a
loopback path, so the numbers show the mesh, the scaling shape, and the accounting are real —
not what a network with genuine RTT, packet loss, and asymmetric home uplinks would give. A
two-machine run is the next credibility step.

### The bug that made this read 0% for nine iterations
One invalid character sequence in our own ICE config:

```js
{ urls: "stun:global.stun.twilio.com:3478?transport=udp" }   // WRONG
{ urls: "stun:global.stun.twilio.com:3478" }                 // fixed
```

`?transport=udp` is only legal on `turn:`/`turns:` URLs. On a `stun:` URL Chromium rejects the
**entire** ICE config, so every `new RTCPeerConnection(...)` threw
`Failed to construct 'RTCPeerConnection': '...' is not a valid stun or turn URL`. p2p-media-loader
catches that, emits an `offer-failed` warning, returns `undefined`, and the falsy offer is
silently filtered out of the announce's `offers[]`. The result is a tracker announce with no
offers, so no peer connects — and because a segment is only P2P-eligible once a *connected* peer
holds it, zero peers is self-reinforcing. **An ICE URL typo fails closed and nearly silently.**

Found by wrapping `window.RTCPeerConnection` before the engine loads and counting constructions
plus constructor throws. That printed the exact error in one run, after nine iterations of
black-box config guessing had ruled out the buffer/window math, the tracker, and the engine
config. Worth reaching for platform-API instrumentation earlier.

## Known limits (by design, for MVP)
- No TURN: symmetric-NAT peers can't P2P, fall back to HTTP (lower offload, not broken).
- Small streams save little (few peers). Offload scales with viewer count.
- Newest live-edge segment is origin-served first, then propagates.

## Deferred (not this MVP)
Ad-free-for-relay reward tier, accounts, token incentive, browser broadcasting, TURN, mobile.
