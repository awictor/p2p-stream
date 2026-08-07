# P2P Live Streaming MVP — prove bandwidth offload

Viewers relay live video segments to each other over WebRTC so the origin serves few
and peers fan out the rest. This MVP proves offload works and **measures the ratio**
(% bytes served peer-to-peer vs from origin). Live, browser-only.

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

## Prereqs
- Node 18+ (`crypto.randomUUID`, modern deps)
- `ffmpeg` and `nginx` on PATH
- A sample video at `origin/sample.mp4` for loop mode (any mp4), or OBS for RTMP mode

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

## Verify (build order = proof)
1. **Baseline.** One viewer tab → dashboard shows ~**0%** offload (only origin serves).
2. **P2P kicks in.** Open 5–10 viewer tabs on the same stream → offload climbs to
   **60–90%**. Each viewer card also shows its own peers + P2P bytes.
3. **Ground truth.** Tail `origin/logs/egress.log` — origin `$body_bytes_sent` per
   viewer drops as the swarm grows, independent of the JS counters.
4. **Fallback.** Kill the tracker (`Ctrl-C` on terminal 3) mid-stream → all viewers
   keep playing via HTTP origin. Playback never fully breaks.
5. **Latency.** Confirm live delay stays a few seconds.

## ⚠️ Status: offload is currently 0% — known cause, unsolved

**Honest state:** every part of the pipeline is verified except the thing the project exists
to prove. `npm run verify` currently exits **1** — the stack runs, four viewers play, the
tracker pairs them, but no peer-to-peer bytes move.

Two gates inside the p2p-media-loader core fight each other:

1. `jr()` zeroes **both** download windows when a viewer holds ≤5 segments ahead:
   ```
   t<=5 ? (httpDownloadTimeWindow=0, p2pDownloadTimeWindow=0)
        : t<=10 && (p2pDownloadTimeWindow = httpDownloadTimeWindow)
   ```
2. Anything inside `highDemandTimeWindow` is HTTP-only regardless of gate 1.

Measured (see `.p2p-loop/patterns.md`): leaving hls.js buffer keys unset lets the engine's
auto-tune run (`liveSyncDurationCount→29`, `maxBufferLength→15`), giving a 15.4s / 7.7-segment
buffer that clears gate 1 — but the same auto-tune sets `highDemandTimeWindow=15` ≥ that
buffer, so every buffered segment stays HTTP-only. Forcing `highDemandTimeWindow=4` collapses
the buffer to 3.8s / 1.9 segments, falling back under gate 1. Note that setting the buffer
keys yourself *suppresses* the auto-tune entirely (the engine guards on `!userConfig.<key>`),
so `web/index.html` deliberately leaves them alone.

Untried, in priority order: larger `-hls_time` (more seconds per segment may clear both gates
at once); VOD with a genuinely deep buffer; a real second network so HTTP stops being
instant-localhost.

**What IS verified end-to-end:** origin pipeline (ffmpeg→CMAF→nginx, correct MIME/CORS), 4
concurrent viewers playing, per-segment byte accounting, tracker peer pairing (`incomplete:N`),
metrics aggregation + dashboard (exact on synthetic input), HTTP fallback, and headless WebRTC
capability (offer + ICE). The plumbing is sound; the window math is the blocker.

### Verify it yourself
```bash
npm run verify            # exit 0 = real P2P bytes seen; 1 = offload still 0%; 2 = stack down
```

## Known limits (by design, for MVP)
- Newest live-edge segment is always origin-served first, then propagates → caps max
  offload near the live edge. Larger buffer/latency = more offload.
- No TURN: symmetric-NAT peers can't P2P, fall back to HTTP (lower offload, not broken).
- Small streams save little (few peers). Offload scales with viewer count.

## Deferred (not this MVP)
Ad-free-for-relay reward tier, accounts, token incentive, browser broadcasting, TURN, mobile.
