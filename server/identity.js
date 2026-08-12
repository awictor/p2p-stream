// Authenticated peer identity — the crypto CORE (P2P-0068, iter 93).
//
// SECURITY.md calls unauthenticated identity "the gap that governs everything": `peerId` is
// `prefix + Math.random()`, minted client-side with nothing behind it, so upload accounting is
// forgeable and the reward tier is unpayable. This module is the primitive every payable number
// must rest on — ed25519 keypair issuance and detached sign/verify over a report.
//
// SCOPE OF THIS FILE: pure functions only. No server wiring, no browser, no key STORAGE or
// key-to-peer BINDING. Signing a report proves "whoever holds this private key produced these exact
// bytes"; it does NOT by itself prove the signer is a distinct, tracker-vouched peer — that binding
// is P2P-0070 (tracker issuance). So this closes SOLO forgery of a report's contents, not COLLUSION
// (two real keys still vouch for each other). See HARD RULE 6.
//
// ed25519 chosen: small keys (44-char b64 pubkey), 88-char b64 sigs, and node's crypto signs it
// with a null algorithm (the algorithm is implied by the key type). Verified round-trip in node 24.
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
  createPublicKey, createPrivateKey, createHash, randomBytes } from "crypto";

// A fresh ed25519 identity. Keys are returned as base64 DER strings so they are trivially
// JSON-transportable (a report carries the pubkey; the tracker will later vouch for it). spki for
// the public key, pkcs8 for the private — the standard portable encodings.
export function issueIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

// CANONICAL serialization is the load-bearing correctness property. A signature covers BYTES; if
// the bytes depended on key order, a peer (or a proxy, or JSON re-encoding) could reorder fields and
// the same signature would still verify over different-looking data — or an honest reorder would
// spuriously fail. So we serialize with keys sorted at every level, deterministically. `undefined`
// values are dropped (JSON would drop them anyway); functions are not expected in a report.
export function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// Sign the canonical bytes of a report. Returns a base64 detached signature, or null on bad input
// (a private key that will not import) rather than throwing — callers are request handlers.
export function signReport(reportObj, privateKeyB64) {
  try {
    if (typeof privateKeyB64 !== "string" || !privateKeyB64) return null;
    // A report is a keyed object, never an array or scalar — reject the confusable shapes so a
    // signature is only ever produced over the object form verifyReport also demands.
    if (reportObj === null || typeof reportObj !== "object" || Array.isArray(reportObj)) return null;
    const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), type: "pkcs8", format: "der" });
    const msg = Buffer.from(canonicalize(reportObj), "utf8");
    return cryptoSign(null, msg, key).toString("base64"); // null algo => implied by the ed25519 key
  } catch {
    return null;
  }
}

// An ed25519 detached signature is EXACTLY 64 bytes. Node's base64 decoder silently stops at the
// last complete quad and drops trailing junk, so `sig + "garbage"` decodes to the same 64 bytes and
// would verify — signature MALLEABILITY (iter 94 HARDEN). Enforce the exact byte length so a padded
// or mutated signature is rejected. Same for the key: an ed25519 spki public key is exactly 44
// bytes, so a garbage-suffixed key cannot slip through either.
const ED25519_SIG_BYTES = 64;
const ED25519_SPKI_PUBKEY_BYTES = 44;

// STRICT base64 decode: node's decoder silently drops trailing junk after the last complete quad,
// so `sig + "A"` and `sig + "garbage"` decode to the SAME bytes as `sig` (signature malleability).
// Decode, then re-encode and require it to round-trip to the exact input — anything with dropped
// or altered characters fails. Returns the Buffer, or null if the input is not clean base64.
function strictB64(str) {
  const buf = Buffer.from(str, "base64");
  return buf.toString("base64") === str ? buf : null;
}

// Verify a base64 detached signature over a report's canonical bytes under a base64 public key.
// Returns a strict boolean. ANY malformed input (bad key, bad sig, non-object report, wrong-length
// sig/key) returns FALSE, never throws — an exception on a public endpoint is a DoS and a
// false-negative risk. A report that is an ARRAY is rejected: a signed report is a keyed object,
// and treating an array as a report invites shape confusion.
export function verifyReport(reportObj, sigB64, publicKeyB64) {
  try {
    if (typeof sigB64 !== "string" || !sigB64) return false;
    if (typeof publicKeyB64 !== "string" || !publicKeyB64) return false;
    if (reportObj === null || typeof reportObj !== "object" || Array.isArray(reportObj)) return false;
    const sig = strictB64(sigB64);
    if (!sig || sig.length !== ED25519_SIG_BYTES) return false; // reject padded/mutated/short sigs
    const pub = strictB64(publicKeyB64);
    if (!pub || pub.length !== ED25519_SPKI_PUBKEY_BYTES) return false;
    const key = createPublicKey({ key: pub, type: "spki", format: "der" });
    const msg = Buffer.from(canonicalize(reportObj), "utf8");
    return cryptoVerify(null, msg, key, sig) === true;
  } catch {
    return false;
  }
}

// TRACKER CERTIFICATION (P2P-0070) — the step that turns "this key HOLDER signed" into "this key was
// ISSUED by the tracker". The tracker signs the peer's public key with ITS OWN private key; the cert
// is that signature. A self-minted key has no such cert, so certified credit cannot be earned by an
// identity the tracker never vouched for — which is what a payable tier requires (possession alone,
// P2P-0069, does not distinguish one real peer from N self-minted ones).
//   THREAT (HARD RULE 6): certification binds a key to a tracker-blessed announce. It does NOT stop
//   a determined attacker who drives N real browsers from obtaining N certs — that needs rate limits
//   / proof-of-work at issuance, a further step. It raises the cost of a sybil from "free" to "one
//   tracker round-trip per identity", and lets the server REJECT keys it never issued.

// Sign a peer's public key with the tracker's private key. Returns a base64 cert, or null on bad
// input. The signed message is the peer pubkey's canonical bytes so the cert is bound to that exact
// key and nothing else.
export function issueCert(peerPublicKeyB64, trackerPrivateKeyB64) {
  if (typeof peerPublicKeyB64 !== "string" || !peerPublicKeyB64) return null;
  return signReport({ pk: peerPublicKeyB64 }, trackerPrivateKeyB64);
}

// True iff `certB64` is the tracker's signature over `peerPublicKeyB64`, under the tracker's public
// key. Reuses verifyReport so it inherits the strict-base64 + exact-length + no-throw guards.
export function verifyCert(peerPublicKeyB64, certB64, trackerPublicKeyB64) {
  if (typeof peerPublicKeyB64 !== "string" || !peerPublicKeyB64) return false;
  return verifyReport({ pk: peerPublicKeyB64 }, certB64, trackerPublicKeyB64);
}

// PROOF-OF-DELIVERY RECEIPT (P2P-0072) — a receiver's signature over a SPECIFIC segment transfer,
// not a bulk self-attestation. A receipt names (segmentId, bytes, senderPeerId, receiverPeerId), so
// credit reflects a transfer two parties can corroborate at the segment level. The receiver signs
// with ITS key; the metrics server (P2P-0073) will credit only receipts whose signer is CERTIFIED.
//   REQUIRED SHAPE: all four fields present and typed, so a receipt cannot be forged by omission and
//   cannot be confused with a generic signed report. Anything else -> not a receipt.
const RECEIPT_FIELDS = ["segmentId", "bytes", "senderPeerId", "receiverPeerId"];
function isReceiptShape(r) {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
  // Exactly the four fields — no more (an extra field would ride along unsigned-in-spirit), no less.
  const keys = Object.keys(r);
  if (keys.length !== RECEIPT_FIELDS.length) return false;
  for (const f of RECEIPT_FIELDS) if (!(f in r)) return false;
  if (typeof r.segmentId !== "string" || !r.segmentId) return false;
  if (typeof r.senderPeerId !== "string" || !r.senderPeerId) return false;
  if (typeof r.receiverPeerId !== "string" || !r.receiverPeerId) return false;
  if (typeof r.bytes !== "number" || !Number.isFinite(r.bytes) || r.bytes <= 0) return false;
  return true;
}

// Sign a delivery receipt. Returns a base64 sig, or null if the receipt is not the required shape or
// the key is bad (so a malformed receipt is never signed into legitimacy).
export function signReceipt(receipt, privateKeyB64) {
  if (!isReceiptShape(receipt)) return null;
  return signReport(receipt, privateKeyB64);
}

// Verify a receipt signature. False unless the receipt is the required shape AND the sig verifies —
// inherits the strict-base64/length/no-throw guards from verifyReport.
export function verifyReceipt(receipt, sigB64, publicKeyB64) {
  if (!isReceiptShape(receipt)) return false;
  return verifyReport(receipt, sigB64, publicKeyB64);
}

// CERT-ISSUANCE PROOF-OF-WORK (P2P-0078) — the primitive that prices identity minting.
//
// certification (P2P-0070) raised a sybil's cost from "free" to "one tracker round-trip per key",
// but the tracker's /issue endpoint still hands a cert to any pubkey for nothing, so a certified
// COLLUSION RING assembles for free. A PoW gate makes each issuance cost measurable CPU: the client
// must find a nonce whose hash of (challenge+nonce) has at least `bits` leading zero bits. Solving is
// O(2^bits) hashes on average; verifying is ONE hash. The tracker will require a valid proof before
// signing a cert (P2P-0079).
//   THREAT (HARD RULE 6): PoW prices issuance in CPU. It does NOT prove a distinct HUMAN — an
//   attacker with more cores or an ASIC still mints faster; and a challenge is only anti-replay if
//   the issuer makes it single-use and fresh (that binding lives at the endpoint, P2P-0079). This is
//   a cost multiplier on a collusion ring, not a personhood proof.

// A fresh random challenge (128 bits of entropy, hex). The issuer hands one out per attempt; the
// client hashes (challenge + nonce) hunting for the difficulty target. randomBytes is CSPRNG, so
// challenges are unpredictable — a client cannot precompute nonces for a challenge it has not seen.
export function makeChallenge() {
  return randomBytes(16).toString("hex");
}

// Count leading zero BITS in a Buffer (not hex chars — bit granularity so `bits` is a smooth knob).
function leadingZeroBits(buf) {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) { count += 8; continue; }
    // Math.clz32 on a right-shifted byte gives the leading zeros within this byte; the byte occupies
    // the low 8 bits of a 32-bit int, so subtract the 24 high zero bits clz32 also counts.
    count += Math.clz32(byte) - 24;
    break;
  }
  return count;
}

// The hashed message is LENGTH-PREFIXED, not a bare `challenge + nonce` concatenation. Naive
// concatenation is ambiguous when the nonce is attacker-controlled: sha256("ab"+"c") ===
// sha256("a"+"bc"), so ONE solved digest would satisfy MULTIPLE (challenge, nonce) pairs, and a
// solution mined against a short challenge could be replayed against a differently-split one. By
// prefixing the challenge's length, the boundary between challenge and nonce is pinned regardless of
// what the nonce contains, so a proof is bound to exactly one challenge. (iter 114 HARDEN.)
function powDigest(challenge, nonce) {
  return createHash("sha256")
    .update(String(challenge.length) + ":" + challenge + nonce)
    .digest();
}

// True iff the length-prefixed hash of (challenge, nonce) has at least `bits` leading zero bits.
//   bits <= 0  -> ALWAYS true (the off switch — issuance PoW disabled, back-compat default).
//   Any non-string challenge/nonce, or a non-finite/negative-after-flooring bits, -> false (no throw:
//   this runs in a request handler on a public endpoint). bits is floored so "8.9" means 8, not a
//   surprise; a fractional target is meaningless at bit granularity.
export function verifyPow(challenge, nonce, bits) {
  try {
    const target = Math.floor(Number(bits));
    if (!Number.isFinite(target)) return false;
    if (target <= 0) return true; // disabled
    if (typeof challenge !== "string" || typeof nonce !== "string") return false;
    return leadingZeroBits(powDigest(challenge, nonce)) >= target;
  } catch {
    return false;
  }
}

// Convenience for a client/test: brute-force a nonce meeting `bits` for a challenge. Deterministic
// counter, not randomness, so a test is reproducible. Guarded with a hash ceiling so a mistuned
// difficulty cannot spin forever — returns null if no nonce is found within `maxTries`.
export function solvePow(challenge, bits, maxTries = 1 << 24) {
  const target = Math.floor(Number(bits));
  if (!Number.isFinite(target) || target <= 0) return "0"; // any nonce works when disabled
  if (typeof challenge !== "string") return null;
  for (let i = 0; i < maxTries; i++) {
    const nonce = i.toString(16);
    if (leadingZeroBits(powDigest(challenge, nonce)) >= target) return nonce;
  }
  return null;
}
