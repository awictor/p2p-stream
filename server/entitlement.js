// Ad-free-for-relay ENTITLEMENT (P2P-0074) — the value-exchange arithmetic.
//
// The reward tier trades relay work for ad-free time. Auth+receipts (P2P-0068..0073) made the input
// trustworthy: `receiptedBytes` is per-segment corroborated, from a tracker-certified, non-self key.
// This turns that number into ad-free SECONDS OWED, per a declared policy rate. Pure function — no
// wiring, no payout. It computes what is owed; the payout RAIL (real ad-server/token) is out of
// scope (needs secrets/infra, HARD RULE 5).
//
// DISCIPLINE (same as priceSaving/sanitizeBytes): junk in -> 0 out, never a fabricated entitlement.
// A dollar/second figure derived from garbage bytes is worse than 0 because it reads as real.

// Policy rate default: bytes a relayer must serve per one ad-free second. 1 MB/s of ad-free is the
// placeholder — an operator sets the real rate. Env-overridable and DOCUMENTED (.env.example).
export const DEFAULT_BYTES_PER_AD_FREE_SECOND = 1_000_000;

// earnedEntitlement({ receiptedBytes, bytesPerSecond?, capSeconds? }) -> ad-free seconds (integer).
//   - receiptedBytes: the trustworthy relay figure. Anything non-finite / <= 0 -> 0 (no fabrication).
//   - bytesPerSecond: policy rate; must be a positive finite number, else the DEFAULT is used (a
//     zero/negative/NaN rate would divide to Infinity/NaN — refuse it, don't emit garbage).
//   - capSeconds: optional per-viewer ceiling so a whale cannot accrue unbounded ad-free time; a
//     non-positive/non-finite cap means "no cap".
// Monotonic non-decreasing in receiptedBytes, exactly 0 at 0, floored to whole seconds (you cannot
// owe a fractional ad-free second in any billing sense), clamped to capSeconds.
export function earnedEntitlement({ receiptedBytes, bytesPerSecond, capSeconds } = {}) {
  const bytes = Number(receiptedBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;

  const rate = Number(bytesPerSecond);
  const perSecond = (Number.isFinite(rate) && rate > 0) ? rate : DEFAULT_BYTES_PER_AD_FREE_SECOND;

  let seconds = Math.floor(bytes / perSecond);

  const cap = Number(capSeconds);
  if (Number.isFinite(cap) && cap > 0 && seconds > cap) seconds = Math.floor(cap);

  return seconds;
}

// applyPolicy(receiptedBytes, policy) -> ad-free seconds (integer) under a TIERED policy (P2P-0095).
//
// A flat rate ("1MB = 1s forever") is a toy; a real reward tier tapers. `policy.tiers` is an ORDERED
// list of marginal bands: [{ uptoBytes, bytesPerSecond }, ...]. Each band earns at ITS OWN rate for
// the bytes that fall inside it — MARGINAL, like a tax bracket, NOT a whole-recompute at the top rate.
// The final tier's `uptoBytes` is the ceiling of the band; omit it (or Infinity) on the last tier so
// it catches everything above. `policy.dayCapSeconds` (optional) clamps the total — a per-window
// ceiling so a whale cannot accrue unbounded ad-free time.
//
// Same discipline as earnedEntitlement: junk/negative/NaN bytes -> 0 (never fabricate), monotonic
// non-decreasing in bytes, exactly 0 at 0, floored to whole seconds. A malformed policy (no usable
// tier) -> 0, never a divide-by-zero or NaN.
//
// STILL OWED, NEVER PAID — this is the arithmetic of what a relayer is owed, not a payout (rail is
// out of scope, HARD RULE 5). The input `receiptedBytes` must already be the payout-grade figure
// (certified + per-segment + non-self); this function does not re-check provenance.
export function applyPolicy(receiptedBytes, policy = {}) {
  const bytes = Number(receiptedBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;

  const rawTiers = Array.isArray(policy.tiers) ? policy.tiers : null;
  // Fall back to the flat default when no usable tiers are declared, so a caller can pass {} and get
  // the legacy behaviour rather than 0.
  if (!rawTiers || rawTiers.length === 0) {
    return earnedEntitlement({ receiptedBytes: bytes, capSeconds: policy.dayCapSeconds });
  }

  let seconds = 0;
  let lower = 0; // bytes already consumed by lower tiers
  for (const tier of rawTiers) {
    if (bytes <= lower) break; // all bytes already allocated to lower bands
    const rate = Number(tier && tier.bytesPerSecond);
    // A tier with a junk rate is skipped (contributes 0 for its band) rather than poisoning the total.
    const upto = Number(tier && tier.uptoBytes);
    // This band spans (lower, ceil]; ceil is the tier's uptoBytes, or Infinity on an open last tier.
    const ceil = Number.isFinite(upto) && upto > lower ? upto : Infinity;
    const bandBytes = Math.min(bytes, ceil) - lower;
    if (bandBytes > 0 && Number.isFinite(rate) && rate > 0) {
      seconds += bandBytes / rate;
    }
    lower = ceil;
    if (!Number.isFinite(ceil)) break; // open tier consumed the remainder
  }

  seconds = Math.floor(seconds);
  const cap = Number(policy.dayCapSeconds);
  if (Number.isFinite(cap) && cap > 0 && seconds > cap) seconds = Math.floor(cap);
  return seconds;
}
