# Deploying off localhost (HTTPS + WSS)

**This is required, not optional.** WebRTC and MSE refuse to run in a non-secure context, so over
plain `http://` on anything other than `localhost` the viewer does not work at all —
`crypto.randomUUID` is undefined and `RTCPeerConnection` is unavailable. The viewer already
derives `https`/`wss` from `location.protocol` (asserted in `test/config.test.js`), so nothing in
the page needs changing. What was missing until now is the server side: something to terminate TLS.

## One command, after the stack is up

```bash
npm start                                                # the four services (see main README)
P2P_HOST=stream.example.com caddy run --config deploy/Caddyfile
```

Caddy fetches a Let's Encrypt certificate for `$P2P_HOST` on first start. Requirements: a DNS A
record pointing at this machine, and ports **80 and 443** reachable from the internet. No other
ports need to be exposed — that is the point of the layout below.

To try it without a public DNS name (Caddy issues its own internal CA certificate):

```bash
P2P_HOST=localhost caddy run --config deploy/Caddyfile
```

## Open the viewer with this URL

Everything is served from one https origin under distinct paths, so **the viewer's default derived
URLs are wrong here** and the three override params it already supports must be used. Substitute
your host:

```
https://stream.example.com/?origin=https://stream.example.com/hls/stream.m3u8&tracker=wss://stream.example.com/tracker&metrics=https://stream.example.com/metrics
```

That URL *is* the configuration — there is no viewer-side file to edit.

| path | backend | prefix |
|---|---|---|
| `/` | viewer, `http-server` :5173 | — |
| `/hls/*` | nginx origin :8080 | kept (nginx serves `/hls/`) |
| `/tracker` | signaling tracker :8000 | **stripped** (tracker is at the backend root) |
| `/metrics`, `/stats` | metrics :8001 | kept (Express routes are those exact paths) |
| `/dashboard` | metrics :8001 | **stripped** (dashboard is Express's `/`) |

### Why one origin instead of TLS per port

Terminating TLS port-for-port (8080/8000/8001/5173) would keep the viewer's default URLs working
untouched, but it needs four internet-facing ports and a certificate covering all of them. One
origin needs one port and one certificate. The cost is the long viewer URL above.

## ⚠ The swarm-identity rule, which TLS makes easier to break

The swarm hash includes `hash(streamUrl)`, so **every viewer must resolve the identical
`streamUrl` string.** Mixing `https://HOST/hls/stream.m3u8` with
`http://192.168.x.x:8080/hls/stream.m3u8` puts viewers in **different swarms**: 0 peers, 0%
offload, and no error message anywhere. Pick one form and use it everywhere, including on the
machine running the stack.

## No secrets

The hostname comes from `$P2P_HOST`. TLS keys are generated and stored by Caddy outside this
repository. Nothing in `deploy/` contains a credential and nothing should — this repo is public.

## Exactly what is and is not verified

`npm run check:configs` runs before the test suite and parses every config it can. This table is the
single place that tracks the gaps, so they cannot quietly multiply — **the standing rule is that a
new config file gets a parser wired into `scripts/check-configs.mjs` in the same change that adds
it.** Two exemptions exist today and both are tool availability, not choice:

| config | syntax | semantics / runtime |
|---|---|---|
| `origin/nginx.conf` | ✅ `nginx -t` (vendored binary in `bin/`) | ✅ same check validates directives |
| `docker-compose.yml` | ✅ real YAML parse, plus ports/volumes structure | ❌ `docker compose config` needs docker — image tags and key names unchecked |
| `deploy/Caddyfile` | ❌ **`caddy validate` is the only Caddyfile parser and there is no library** | ❌ never served traffic |

For the Caddyfile, `test/deploy.test.js` asserts the routing invariants instead — every backend port
proxied exactly once, prefixes stripped only where the backend expects it, no secrets, the websocket
route present. That covers the mistakes that fail *silently*: a wrong `/tracker` route presents as
"peers never connect", not as an HTTP error. It does not and cannot cover syntax.

`check:configs` picks the Caddyfile up automatically once `caddy` is on PATH — the check is already
written and reports SKIP with its reason until then. The user-run steps are the unchecked boxes in
`.p2p-loop/manual-qa.md`.
