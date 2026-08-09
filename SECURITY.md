# Security & Threat Model — p2p-stream

This is an **MVP that proves a bandwidth-offload mechanism**, not a hardened production service. The
abuse surface is small but real: two of the three servers (`/metrics` on :8001, the WS tracker on
:8000) are **public and unauthenticated** by design — viewers report from a different origin. This
document states, per guard, exactly what is defended and what is **not**. Every claim here is
already shipped and unit-tested (`npm test`); nothing below is aspirational.

## The one gap that governs everything: identities are free

`peerId` is `prefix + Math.random()`-derived, minted client-side, with no proof of work, possession,
or uniqueness, and the `peerId → clientId` mapping is **self-declared**. **Anything that depends on a
peer being who it says it is can be forged.** Closing this needs authenticated identity at the
tracker (tracker-assigned IDs or a signed handshake), which this MVP does not have and which is out
of scope. Consequence, and the **standing rule**:

> **Never pay out a reward/incentive tier on these numbers.** The attested-upload figures are a
> cross-check, not an authorisation to pay. See the sybil result below.

## What each guard defends — and what it does NOT

| Guard (item) | Defends against | Does **NOT** defend against |
|---|---|---|
| **Byte-range sanitize** (P2P-0063) | A single POST driving `offloadRatio` impossible/negative — byte fields are clamped to `[0, MAX_REPORT_BYTES]`, so junk/NaN/Infinity/negative → 0, overshoot → ceiling. | A peer reporting a **plausible lie within range**. It bounds the value range, not the truthfulness. |
| **Resident-state ceiling** (P2P-0061) | Memory exhaustion from a flood of unique `clientId`s — `clients` is hard-capped at `MAX_CLIENTS` (evict oldest-by-lastSeen), `attest` keys at `MAX_ATTEST_KEYS`, `clientId` length at `MAX_CLIENTID_LEN`. Enforced on insert, not only on read. | **Map churn**: an attacker flooding fake ids can still evict honest viewers. Byte totals stay monotonic under churn, so the published number is not corrupted, but the active set can be displaced. |
| **WS frame cap** (P2P-0062) | A 100MB-frame flood at signaling — the tracker WS `maxPayload` is bounded (`WS_MAX_PAYLOAD`, 64KB; real SDP+ICE is a few KB) instead of the ws library's 100MB default. | A flood of **small valid frames**. It bounds frame size, not connection rate or identity. |
| **Host fingerprint / loopback refusal** (P2P-0058, P2P-0060) | Certifying a loopback run as cross-network — `distinctHosts` is derived from the report **socket** (`req.socket.remoteAddress`), never the body, so a client cannot claim to be elsewhere; `verify:remote` refuses (exit 2) when all viewers share one host or the field is absent. | A **genuine multi-host sybil**: two real machines colluding satisfy the check honestly. It proves bytes crossed a network, not that the peers are distinct people. |
| **Receiver attestation + K-of-N filter** | **Solo** upload forgery — a peer inflating its own `uploadBytes` earns no attested credit, because credit only arrives from *other* viewers; self-attestation is dropped. `MIN_ATTESTERS`/`MAX_VOUCH_PER_ATTESTER` meter it. | **Collusion** — see below. |
| **Config fail-safe** (HARDEN iter 84) | A guard silently disabling itself on a typo'd limit env — a misconfigured `MAX_*` falls back to its default and warns, rather than parsing to `NaN` and turning the bound off. | Nothing new; it keeps the guards above from being accidentally voided. |

## We attacked our own detector, and it is blind (demonstrated, `npm run test:sybil`)

A collusion ring run against a **real** metrics server:

| | result |
|---|---|
| identities | 10, minted in one process |
| video actually relayed | **0 bytes** |
| attested credit produced | **500 MB** |
| suspects raised by our detector | **0** |
| per-identity ratio reported | a clean **1.00** |

**This cannot be fixed by tuning the threshold.** A 2-member ring and two honest peers who really
served each other produce *byte-identical* data — there is no signal to separate them. The only real
fix is making identities cost something (authenticated peer IDs), which changes the signaling
contract this MVP does not implement.

## In scope for a real deployment (not done here)

- Authenticated peer identity at the tracker (closes sybil/collusion and unlocks a payable tier).
- Connection-rate limiting and per-IP quotas on both public endpoints.
- TURN infrastructure (currently STUN-only; symmetric-NAT peers fall back to HTTP).
- TLS/WSS termination for off-localhost use — `deploy/Caddyfile` provides this but is unrun here.

## No secrets in the repo

No API keys, no `.env` with real values, no TURN credentials are committed. Anything requiring a
secret reads it from an environment variable and documents it in the README. The repo is public;
assume every commit is world-readable.

## Reporting

This is a demo/research repo. Open a GitHub issue for anything security-relevant; there is no
embargoed disclosure process and no production deployment to protect.
