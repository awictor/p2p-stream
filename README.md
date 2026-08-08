# P2P Live Streaming MVP — prove bandwidth offload

Viewers relay live video segments to each other over WebRTC so the origin serves few
and peers fan out the rest, cutting the egress bill that dominates streaming costs.
Live, browser-only, and it **measures the ratio** (% bytes served peer-to-peer vs origin).

> **Status: working, and offload rises with swarm size — 45% at 2 viewers, 79% at 8.**
> Measured against a P2P-off control arm, origin egress falls **51%** at 4 viewers with zero
> rebuffering. (Offload ratio ≠ bill reduction — see below.)
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
| `test/*.test.js` | unit tests: ratio maths, signaling, viewer config, dashboard (`npm test`) |
| `start.sh` | one-command bring-up of all four services, waits for real readiness (`npm start`) |

## Prereqs
- Node 18+ (`crypto.randomUUID`, modern deps)
- `ffmpeg` and `nginx`. The scripts prefer portable copies under `bin/` if present
  (`bin/ffmpeg-*/bin/ffmpeg.exe`, `bin/nginx-*/nginx.exe`) and fall back to PATH, so no
  admin install is required. `bin/` is gitignored — download them yourself or install normally.
- A sample video at `origin/sample.mp4` for loop mode (any mp4), or OBS for RTMP mode
- Windows note: `origin/nginx.conf` sets `sendfile off`, which is REQUIRED there — with it on,
  nginx caches file handles and 404s the rotating live segments.

## Run (one command)
```bash
npm install
npm start                      # or: bash start.sh
```
`start.sh` starts all four services, then **waits for real readiness** before printing URLs —
it polls until the playlist exists and holds ≥20 fragments, because a playlist with 2 fragments
plays but measures ~0% offload, which looks like a broken product rather than an impatient
operator. In live mode ffmpeg buffers before it writes the playlist at all, so first output
takes ~90s. Ctrl-C stops everything it started.

```bash
npm run start:vod              # segment origin/vod.mp4 instead — no ~90s live wait
bash start.sh rtmp             # ingest OBS at rtmp://localhost:1935/live/stream
```

Then open the dashboard <http://localhost:8001> and the viewer <http://localhost:5173> in 2+ tabs.

<details><summary>Or run the four services by hand (4 terminals)</summary>

```bash
npm run origin:loop            # 1) segmenter (or: npm run origin:rtmp, then stream from OBS)
npm run nginx                  # 2) origin      http://localhost:8080/hls/stream.m3u8
npm run tracker                # 3) tracker ws://localhost:8000 + metrics :8001
npm run web                    # 4) viewer      http://localhost:5173
```
</details>

> Local dev uses `ws://` and `http://` on localhost (allowed secure context). Deploying
> off-localhost requires **HTTPS + WSS everywhere** — WebRTC and MSE refuse insecure
> contexts. Update URLs in `web/p2p-config.js`.

## Verify
Automated, no services needed:
```bash
npm test                  # 128 assertions: metrics (37) + tracker (15) + config (36) + dashboard (24) + start (16)
```

With the four services up:
```bash
npm run verify            # the ONLY accepted proof of offload (~2min)
npm run verify:sweep      # offload vs viewer count, 1/2/4/8 (~4min)
npm run verify:control    # P2P ON vs OFF, side by side (~2min)
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

`N=1` at 0% is correct — a lone viewer has no peer to pull from — and peer connections growing
2→12→50 is the mesh fanning out rather than a star. `N=2` measured 45% and 44% on independent runs.

### ⚠️ The offload ratio is NOT the bill reduction (measured iter 25)

The percentages above are the **share of delivered bytes that came from peers**. That is not the
same as how much less the origin served, and the difference is not small. `npm run verify:control`
runs the identical scenario twice — once normally, once with `?p2p=off` — and compares them:

| metric | P2P ON | P2P OFF |
|---|---|---|
| offload ratio | 68% | 0% |
| **origin bytes** | **74.8MB** | **151.6MB** |
| total fetched | 234.4MB | 151.6MB |
| stalls | 0 | 0 |

Origin egress fell by **51%**, not 68%, because the P2P arm fetched *more total bytes*. **Quote the
control-arm subtraction, not the offload ratio.** The ratio is the flattering number.

**The 1.52x total-byte gap is not yet explained, and it matters.** Both arms held the *same*
474 video-seconds with *identical* 61s buffers, so the P2P arm fetched ~82.8MB (~127 segments)
that the HTTP-only arm did not need. Amplification: **0.98x with P2P off** (fetches what it
plays) versus **1.52x with P2P on**. Identical buffer depth rules out "P2P just prefetches
deeper"; the open candidates are duplicate fetching (HTTP and P2P racing the same segment),
discarded late arrivals, or double-counted accounting. Until it is attributed (tracked as
P2P-0024), treat the viewer-side cost as **unquantified** — a viewer may be spending ~55% more
total bandwidth to save the platform 51% of its origin bill, which is exactly the trade the
ad-free tier would have to price.

The control arm also settles what the QoE figures mean: **both arms rebuffered zero times**, so
the correct claim is "P2P cut origin bytes with no rebuffering introduced" — *not* that P2P
improved playback. Playback was already clean without it.

**Upload accounting cross-checks.** Every byte downloaded from a peer must have been uploaded by
one, and it balances: 171.6MB down vs 172.6MB up in a 4-viewer run (0.6% skew). The harness now
prints an `upload conservation` ratio each run, because this silently read 0 B until iteration 12.

Also verified: origin pipeline (ffmpeg→CMAF→nginx, correct MIME/CORS), tracker announce handling
and offer relay, metrics aggregation (37 assertions), HTTP fallback survives killing the tracker
mid-stream, headless WebRTC.

**Not yet proven: anything off localhost.** These viewers are tabs on one machine sharing a
loopback path, so the numbers show the mesh, the scaling shape, and the accounting are real —
not what a network with genuine RTT, packet loss, and asymmetric home uplinks would give. A
two-machine run is the next credibility step; see [Running across two machines](#running-across-two-machines).

## Running across two machines

On the host, start all four services and note the LAN address the tracker prints:

```bash
npm run origin:loop &   # wait ~180s for the 90-fragment playlist to fill
npm run nginx & npm run tracker & npm run web &
# [tracker] reachable from LAN at ws://192.168.68.66:8000
```

Then open **`http://<LAN_IP>:5173`** on every viewer — **including the host machine itself**.

> ⚠️ **Never mix `localhost` with the LAN IP.** The swarm is identified by
> `${version}-${swarmId}-${hash(streamUrl)}`, so the stream URL is part of the swarm identity.
> A viewer on `http://localhost:5173` and one on `http://192.168.68.66:5173` derive different
> stream URLs, join **different swarms**, and sit at 0 peers with no error message at all.

The viewer derives the origin, tracker and metrics URLs from the page's own hostname, so no
config editing is needed. Override individually with `?origin=`, `?tracker=`, `?metrics=`,
`?host=` or `?swarm=` if the services are split across hosts.

Watch `http://<LAN_IP>:8001` — offload above 0% with viewers on separate machines is the
result that matters. Notes from testing this path:

- **Plain `http://` is fine on a private IP.** Chromium permits WebRTC there. Only
  `crypto.randomUUID()` is secure-context-gated, and the viewer now falls back when it is
  unavailable — without that, every off-localhost viewer threw before playback started.
- **Windows Firewall** may prompt on first run; allow Node and nginx on the private network or
  ports 8080/8000/8001/5173 stay filtered and the second machine sees nothing.
- **A phone on Wi-Fi works** (same LAN, same URL). A phone on **cellular cannot reach a LAN
  IP** — that needs a routable origin plus HTTPS/WSS, which is not covered here.

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
