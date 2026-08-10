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
  createPublicKey, createPrivateKey } from "crypto";

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
    const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), type: "pkcs8", format: "der" });
    const msg = Buffer.from(canonicalize(reportObj), "utf8");
    return cryptoSign(null, msg, key).toString("base64"); // null algo => implied by the ed25519 key
  } catch {
    return null;
  }
}

// Verify a base64 detached signature over a report's canonical bytes under a base64 public key.
// Returns a strict boolean. ANY malformed input (bad key, bad sig, non-object report) returns
// FALSE, never throws — an exception on a public endpoint is a DoS and a false-negative risk.
export function verifyReport(reportObj, sigB64, publicKeyB64) {
  try {
    if (typeof sigB64 !== "string" || !sigB64) return false;
    if (typeof publicKeyB64 !== "string" || !publicKeyB64) return false;
    if (reportObj === null || typeof reportObj !== "object") return false;
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), type: "spki", format: "der" });
    const msg = Buffer.from(canonicalize(reportObj), "utf8");
    return cryptoVerify(null, msg, key, Buffer.from(sigB64, "base64")) === true;
  } catch {
    return false;
  }
}
