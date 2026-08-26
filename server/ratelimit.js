// Per-IP token-bucket rate limiter (P2P-0093). The /metrics POST and the WS announce are PUBLIC and
// UNAUTHENTICATED — one IP can flood them, churning the bounded client map or spending server CPU on
// verifyReport/verifyCert for junk. A per-source token bucket bounds each IP's request rate: every
// call spends one token, the bucket refills at `refillPerSec` up to `capacity`, and an empty bucket
// denies (429). Bursts up to `capacity` pass; sustained load is capped at the refill rate.
//
// THREAT NOTE (HARD RULE 6): this prices WALL-CLOCK per source key (IP fingerprint). It COMPLEMENTS
// the cert-issuance PoW (which prices CPU per cert) but does NOT authenticate the peer and does NOT
// stop a DISTRIBUTED flood from many IPs — that needs authenticated identity (out of scope, roadmap).
// It closes the single-IP flood vector only. Keys should already be hashed (hostFingerprint), never
// raw addresses, so this state never holds a viewer's real IP.
//
// PURE by design: no clock, no Map-of-its-own, no timers. The caller owns the bucket store and passes
// `now` (ms). This makes every branch unit-testable deterministically and keeps the limiter free of
// the process.env / Date.now traps that bit earlier iterations.

// rateLimit(state, key, now, {capacity, refillPerSec})
//   state          - a plain object used as the bucket store: { [key]: {tokens, ts} }. Caller-owned;
//                    pass the same object across calls. Mutated in place AND returned (so a test can
//                    also treat it as immutable-ish by reading the return).
//   key            - the per-source identifier (e.g. hostFingerprint hash). Distinct keys are independent.
//   now            - current time in ms (injectable; production passes Date.now()).
//   capacity       - max tokens (burst ceiling). <=0 disables limiting (always allowed) — an explicit
//                    opt-out, documented so a mis-set env cannot silently throttle to zero.
//   refillPerSec   - tokens added per second, linearly, capped at capacity.
// Returns { allowed, state, tokens } — allowed=false means over cap (caller answers 429/close).
export function rateLimit(state, key, now, { capacity, refillPerSec } = {}) {
  if (!state || typeof state !== "object") state = {};
  const cap = Number(capacity);
  const refill = Number(refillPerSec);
  // Disabled / misconfigured -> allow. capacity<=0 is the documented "unlimited" switch; a NaN from a
  // bad env must FAIL OPEN (never silently deny every request), same fail-safe posture as iter 84.
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(refill) || refill < 0) {
    return { allowed: true, state, tokens: Infinity };
  }
  const b = state[key];
  if (!b) {
    // First sight of this key: full bucket, spend one.
    state[key] = { tokens: cap - 1, ts: now };
    return { allowed: true, state, tokens: cap - 1 };
  }
  // Refill for elapsed wall-clock, capped at capacity. Guard against a backwards clock (elapsed<0).
  const elapsedSec = Math.max(0, (now - b.ts) / 1000);
  const refilled = Math.min(cap, b.tokens + elapsedSec * refill);
  b.ts = now;
  if (refilled >= 1) {
    b.tokens = refilled - 1;
    return { allowed: true, state, tokens: b.tokens };
  }
  // Empty (sub-one) bucket: deny, keep the fractional tokens so refill continues from here.
  b.tokens = refilled;
  return { allowed: false, state, tokens: b.tokens };
}

// Prune buckets not touched within `maxIdleMs` so the store can't grow unboundedly under a spray of
// distinct keys (the store is memory an attacker could otherwise spend). Caller invokes periodically
// or opportunistically. Returns the number pruned.
export function pruneBuckets(state, now, maxIdleMs) {
  if (!state || typeof state !== "object") return 0;
  let pruned = 0;
  for (const [k, b] of Object.entries(state)) {
    if (!b || (now - b.ts) > maxIdleMs) { delete state[k]; pruned += 1; }
  }
  return pruned;
}
