#!/usr/bin/env node
/**
 * viewerauth.test.js — the viewer's signed /metrics report is TOCTOU-safe: the signature covers the
 * EXACT attest map that is sent, even if a segment arrives mid-sign (P2P HARDEN, iter 124).
 *
 * The report interval signs {clientId, attest} and then JSON.stringify's the body AFTER the async
 * crypto.subtle.sign await. If attest were the LIVE servedByPeer object, a segment arriving during
 * the await would mutate it, the body would carry the mutated map, and the signature — computed over
 * the pre-mutation map — would no longer verify. verifyReport would reject it and signed/certified
 * credit would silently drop to 0. The fix snapshots attest once; this pins that the snapshot is
 * used for BOTH the signature and the body.
 *
 * Technique: extract the REAL report-build + sign block from web/index.html and run it with a node
 * ed25519 identity whose sign() MUTATES the live servedByPeer map before returning — simulating a
 * segment landing mid-await. Then verify report.sig against report.attest with server/identity.js.
 *
 * Usage: node test/viewerauth.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { issueIdentity, signReport, verifyReport, verifyReceipt, issueCert } from "../server/identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

// Pull the report interval body (the async setInterval callback) out of the real file.
const m = HTML.match(/setInterval\(async \(\) => \{[\s\S]*?\}, cfg\.reportIntervalMs\);/);
if (!m) { console.error("ERROR: could not find the report interval in web/index.html"); process.exit(1); }

(async () => {
  console.log("the signed report is TOCTOU-safe against a mid-sign attest mutation");
  {
    const id = issueIdentity();
    // The live map the viewer mutates on every p2p segment.
    const servedByPeer = { "peer-a": 1000 };
    let sentBody = null;
    // A sign() that, like a real async crypto call, yields — and DURING that yield a "segment
    // arrives" and mutates the live map. If the report used the live object, the body would now
    // differ from what was signed.
    const __identity = {
      pubKey: id.publicKey,
      sign: async (obj) => {
        servedByPeer["peer-b"] = 5_000_000; // segment lands mid-sign
        return signReport(obj, id.privateKey);
      },
    };
    // Minimal env for the extracted block: capture the fetch body instead of sending it.
    const cfg = { metricsUrl: "http://x/metrics", reportIntervalMs: 1 };
    let captured = null; // setInterval captures the callback here instead of scheduling it
    const setIntervalStub = (fn) => { captured = fn; };
    const fetchStub = (url, opts) => { sentBody = JSON.parse(opts.body); return Promise.resolve({ catch() {} }); };
    const runner = new Function(
      "clientId", "httpBytes", "p2pBytes", "uploadBytes", "ownPeerId", "servedByPeer",
      "__identity", "__cert", "pendingReceipts", "MAX_PENDING_RECEIPTS", "cfg", "Date", "setInterval", "fetch",
      `${m[0]}`
    );
    runner(
      "toctou", 1, 2, 0, () => "peer-self", servedByPeer, __identity, null, [], 128,
      cfg, { now: () => 1 }, setIntervalStub, fetchStub
    );
    await captured(); // run one report tick

    checkTrue("a body was sent", sentBody !== null);
    checkTrue("the body carries a signature", typeof sentBody.sig === "string");
    // THE INVARIANT: the signature verifies over the attest ACTUALLY SENT. If the code signed the
    // live map and sent the mutated one (the bug), this is false.
    checkTrue("sig verifies over the SENT attest (TOCTOU-safe)",
      verifyReport({ clientId: sentBody.clientId, attest: sentBody.attest }, sentBody.sig, sentBody.pubKey),
      "the signature must cover exactly the attest map in the body");
    // And confirm the mutation really happened on the live map (the hazard is real, not skipped).
    checkTrue("the live map WAS mutated mid-sign (hazard exercised)", servedByPeer["peer-b"] === 5_000_000);
    // The sent attest is the SNAPSHOT (pre-mutation), not the live post-mutation map.
    checkTrue("the SENT attest is the pre-mutation snapshot", sentBody.attest["peer-b"] === undefined,
      "a copy was frozen before signing; the later segment is not in this report");
  }

  console.log("\nper-segment receipts: the viewer signs buffered deliveries + skips self-receipts (P2P-0084)");
  {
    const id = issueIdentity();
    const tracker = issueIdentity();
    const cert = issueCert(id.publicKey, tracker.privateKey);
    const __identity = { pubKey: id.publicKey, sign: async (obj) => signReport(obj, id.privateKey) };
    const pendingReceipts = [
      { segmentId: "s1", bytes: 262144, senderPeerId: "peer-other" },
      { segmentId: "s2", bytes: 99999, senderPeerId: "peer-me" }, // sender == receiver -> skip
    ];
    let sentBody = null, captured = null;
    const runner = new Function(
      "clientId", "httpBytes", "p2pBytes", "uploadBytes", "ownPeerId", "servedByPeer",
      "__identity", "__cert", "pendingReceipts", "MAX_PENDING_RECEIPTS", "cfg", "Date", "setInterval", "fetch",
      `${m[0]}`
    );
    runner(
      "rcpt", 1, 2, 0, () => "peer-me", { "peer-other": 262144 }, __identity, cert, pendingReceipts, 128,
      { metricsUrl: "http://x", reportIntervalMs: 1 }, { now: () => 1 },
      (fn) => { captured = fn; },
      (url, opts) => { sentBody = JSON.parse(opts.body); return Promise.resolve({ catch() {} }); }
    );
    await captured();

    checkTrue("receipts[] attached when identity+cert present", Array.isArray(sentBody.receipts) && sentBody.receipts.length === 1);
    const r = sentBody.receipts[0];
    checkTrue("emitted receipt is the real-peer segment", r && r.segmentId === "s1" && r.senderPeerId === "peer-other");
    checkTrue("receiverPeerId is our own id", r && r.receiverPeerId === "peer-me");
    checkTrue("receipt sig verifies under our pubKey",
      verifyReceipt({ segmentId: r.segmentId, bytes: r.bytes, senderPeerId: r.senderPeerId, receiverPeerId: r.receiverPeerId }, r.sig, id.publicKey));
    checkTrue("the SELF-receipt (sender==receiver) was NOT emitted",
      !sentBody.receipts.some((x) => x.senderPeerId === "peer-me"), "self-dealing dropped client-side");
    checkTrue("pending buffer drained", pendingReceipts.length === 0);

    let body2 = null, cb2 = null;
    runner(
      "rcpt2", 1, 2, 0, () => "peer-me", {}, __identity, null,
      [{ segmentId: "s3", bytes: 1000, senderPeerId: "peer-other" }], 128,
      { metricsUrl: "http://x", reportIntervalMs: 1 }, { now: () => 1 },
      (fn) => { cb2 = fn; },
      (url, opts) => { body2 = JSON.parse(opts.body); return Promise.resolve({ catch() {} }); }
    );
    await cb2();
    checkTrue("no cert -> no receipts attached (server would drop them)", body2.receipts === undefined);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
