# P2P Live Streaming MVP — prove bandwidth offload

Viewers relay live video segments to each other over WebRTC so the origin serves few
and peers fan out the rest, cutting the egress bill that dominates streaming costs.
Live, browser-only, and it **measures the ratio** (% bytes served peer-to-peer vs origin).

> **Status: working, and offload rises with swarm size — 45% at 2 viewers, 79% at 8.**
> Measured against a P2P-off control arm, origin egress falls **51%** at 4 viewers with zero
> rebuffering — **but only if every viewer relays.** At 50% participation the saving is 29%, at
> 25% it is 7%. (Offload ratio ≠ bill reduction, and neither survives an opt-out — see below.)
> Measured on one machine. Not yet reproduced across two machines.
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
npm test                  # 251 assertions: metrics 49, tracker 15, config 57, dashboard 24, start 16,
                          #                 ledger 37, claim 19, participation 35
```

With the four services up:
```bash
npm run verify            # the ONLY accepted proof of offload (~2min)
npm run verify:sweep      # offload vs viewer count, 1/2/4/8 (~4min)
npm run verify:control    # P2P ON vs OFF, side by side (~2min)
npm run verify:windows    # sweep p2pDownloadTimeWindow: saving vs viewer cost (~5min)
npm run verify:participation  # saving vs % of viewers who actually relay (~5min)
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
| total fetched | 234.3MB | 151.6MB |
| video obtained | 474s | 474s |
| **KB per video-second** | **494** | **320** |
| fetches / unique segment | 1.00x | 1.00x |
| duplicate segments | 0 | 0 |
| stalls | 0 | 0 |

Origin egress fell by **51%**, not 68%, because the P2P arm fetched *more total bytes*. **Quote the
control-arm subtraction, not the offload ratio.** The ratio is the flattering number.

That 51% is measured **per video-second** (320 → 158 KB per second of video obtained), not as a raw
byte subtraction. The distinction only matters when the two arms play unequal amounts of video —
and then it matters a lot: a raw subtraction credits P2P for video the control arm played and the
P2P arm did not. Here the arms matched (472s each) so both methods agree, but the harness now
normalises by construction and flags any run where the arms diverge by more than 3%.

### The 1.55x gap is real, and it is WASTE — 33% of P2P fetches are never played (iter 31)

The P2P arm moves **1.55x the bytes per second of video obtained** (497 KB vs 321 KB) for the
*same* 472 video-seconds. A per-segment ledger attributes it precisely. Every fetched segment is
classified by its actual fate:

| fate | P2P ON | P2P OFF |
|---|---|---|
| played | 117 | 117 |
| buffered, pending (would have played) | 123 | 119 |
| **fetched but never buffered — wasted** | **120 (33%, 78.1MB)** | **0 (0%)** |

`fetches / unique segment` is **1.00x in both arms with zero duplicates**, so this is **not**
double-counted accounting, **not** a duplicate fetch, and **not** HTTP racing P2P. It is
**78.1MB of segments pulled over the mesh and never appended to the media buffer** — which
almost exactly accounts for the 76.9MB the origin saved. The control arm's **0%** is the
sanity check that makes the 33% believable: a pure-HTTP viewer wastes nothing.

### The waste is NOT tunable — read-ahead is what earns the offload (measured iter 33)

The obvious fix was to narrow `p2pDownloadTimeWindow` (engine default **6000 seconds** of
read-ahead eligibility, vs 3000 for HTTP). `npm run verify:windows` sweeps it and reports the
saving and the viewer's cost side by side:

| window | origin saving | KB/video-s | amplification | wasted |
|---|---|---|---|---|
| P2P off | — | 323 | 1.00x | 0% |
| 6000 (default) | **-49%** | 519 | 1.61x | 36% |
| 150 | -47% | 519 | 1.61x | 36% |
| 90 | -13% | 496 | 1.54x | 33% |
| 45 | -7% | 401 | 1.24x | 19% |

**Cost and saving fall together.** Cutting the waste from 36% to 19% costs the origin saving
49% → 7%. There is no setting that keeps the saving and drops the cost, so the read-ahead a
viewer pays for *is* the mechanism that produces the offload — a peer can only serve a segment
it fetched early. Zero rebuffering at every value.

So the viewer's ~55% extra bandwidth is **inherent to this design, not a misconfiguration.**
The remaining lever is consent, not tuning — which is what the upload budget below implements.

### Upload budget: bound what a viewer spends (`?uploadCapMB=`)

```
http://localhost:5173/index.html?uploadCapMB=25
```

Once the viewer has served that many MB it **stops relaying and keeps watching.** Measured live
with a 2MB cap: upload froze at 2.74MB and grew **0 bytes over the next 45 seconds**, the engine
reported `isP2PUploadDisabled: true`, playback advanced the full 45s, and **peer downloads kept
climbing** (35.1 → 46.3MB) — so a capped viewer stops *serving* without being pushed back onto the
origin. An uncapped viewer in the same swarm was unaffected. The stat line shows `2.4 MB (capped)`,
because consent needs a visible number and a visible stop.

> **⚠ This is not an anti-abuse control, and must not be used as one.** The byte counter lives in
> the page, so a modified client can under-report it and relay forever, or **over-report it and
> claim credit for bytes it never sent**. The cap bounds an *honest* viewer's bill; it does not
> defend the platform against a dishonest one. Any ad-free-for-relay reward built on this number
> needs proof-of-delivery attested by the **receiving** peer — self-reported upload totals are
> free money for a scripted client.

### Receiver-attested upload: don't pay out on a peer's own claim (iter 39)

The reward tier can't be built on `uploadBytes`, because that is a peer's claim about itself. So
every viewer now also reports **what its peers served it** — `onSegmentLoaded` hands the receiver
`{peerId, bytesLength}` — and `/stats` credits a peer from those third-party reports:

| | 4-viewer run |
|---|---|
| self-reported upload | 116.8MB |
| **receiver-attested upload** | **113.5MB** |
| attested ÷ self-reported | **0.972** |
| viewers credited by peers | 4 of 4 (0 unmapped) |

A peer that inflates its own `uploadBytes` gains **no** attested credit — unit-tested by pushing a
self-claim to 999,999,999 bytes and watching attested credit stay put. Self-attestation is dropped
outright, since that is precisely the forgery being detected (mutation-tested: removing that guard
lets a viewer self-credit 501,000 bytes).

> **⚠ Attestation defeats SOLO forgery, not COLLUSION.** Peer identity here is a self-chosen engine
> id with nothing behind it, so one browser can open N tabs that attest for each other, and a
> `peerId → clientId` mapping is self-declared. Treat attested totals as a **cross-check**, not an
> authorisation to pay. Closing the collusion gap needs authenticated peer identity at the tracker,
> which this MVP does not have.

> Windows longer than the stream itself (here 180s) are indistinguishable from the default —
> every segment is eligible either way. The harness now says so instead of printing them as
> data points; an earlier sweep included 6000 and 600 and produced two identical rows.

### ⚠️ The saving needs near-total participation (measured iter 35)

Consent implies refusal, so `npm run verify:participation` loads some viewers with `?p2p=off`
(real viewers, pulling real bytes from the origin) and measures what the platform actually saves.
At 8 viewers:

| relaying | origin saving | KB/video-s | upload per relayer | stalls |
|---|---|---|---|---|
| 0% | — | 322 | — | 0 |
| **100%** | **-69%** | 488 | 46.7MB | 0 |
| 75% | -50% | 439 | 44.5MB | 0 |
| 50% | -29% | 395 | 40.1MB | 0 |
| 25% | -7% | 355 | 26.7MB | 0 |

**The saving decays faster than the relayer count.** At 75% it is still roughly proportional
(-50% vs a proportional -52%), but by 50% it lags (-29% vs -35%) and by 25% it has effectively
collapsed (-7% vs -17%). Two compounding reasons: a freeloader still pulls its whole stream **from
the origin**, so it adds to the bill it isn't helping reduce; and peer connections fall
50 → 30 → 12 → 2, so the remaining relayers have progressively fewer partners to serve.

Consequence for the business model: **the ad-free-for-relay tier is not a nice-to-have, it is what
makes the economics work at all.** A 51%-or-69% saving assumes participation this design has to
actively earn, and any quoted figure should carry the rate it assumes.

> Every rate here has ≥2 relayers. A *single* relayer cannot offload — it has no peer to pull
> from — so a 25%-of-4-viewers row reads 0% by arithmetic, not by measurement. The harness now
> says so rather than reporting it as a collapse.

So the trade is explicit: **the platform saves 51% of its origin egress, and a relaying viewer
spends ~55% more total bandwidth** (plus ~40MB of upload each) to provide it — **and a third of
that extra is currently pure waste, not payment for the saving.** On a metered or mobile
connection that may not be a trade a viewer accepts, and it is the number the ad-free-for-relay
tier has to be priced against. Earlier iterations attributed the gap to "P2P prefetches deeper";
identical buffer depth in both arms refuted that.

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
