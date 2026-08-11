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
