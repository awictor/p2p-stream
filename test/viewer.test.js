#!/usr/bin/env node
/**
 * viewer.test.js — the two untested load-bearing surfaces in web/index.html.
 *
 * `web/index.html` is the largest real source in the repo (24.5KB) and only its per-segment
 * ledger was covered (ledger.test.js). Two other blocks decide whether a viewer works at all,
 * and both are directly implicated in the open cross-machine milestone:
 *
 *   1. THE `clientId` FALLBACK CHAIN. `crypto.randomUUID` is SECURE-CONTEXT ONLY, so on
 *      http://<lan-ip>:5173 — exactly the URL the two-machine run requires — it is `undefined`
 *      and calling it throws "crypto.randomUUID is not a function" BEFORE the player is built.
 *      That killed every off-localhost viewer once already. The fix is a three-step chain, and
 *      nothing tested that the second and third steps actually work.
 *
 *   2. THE METRICS REPORT PAYLOAD. Every number this project publishes arrives at the server
 *      through this one JSON body. A renamed or dropped key does not break playback and does
 *      not throw — it silently zeroes a published figure. `metrics.test.js` asserts the SERVER
 *      side of the same contract, so a mismatch between the two is exactly the gap.
 *
 * Same technique as config/dashboard/ledger tests: run the REAL extracted source against a
 * stubbed environment, so the assertions cannot drift from what the browser executes.
 *
 * Usage: node test/viewer.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

// Extract the REAL clientId IIFE and run it against a chosen `window.crypto`. Returns the id
// the shipped code would produce in that environment.
function makeClientId(cryptoStub) {
  const m = HTML.match(/const clientId = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  if (!m) throw new Error("could not find the clientId block in web/index.html");
  // `crypto` is referenced bare (not window.crypto) on the call lines, so it has to exist as a
  // free variable too — which is itself part of the contract being tested.
  const fn = new Function("window", "crypto", "Uint8Array", `${m[0]} return clientId;`);
  // Return the THROWN error rather than propagating it. The bug this file exists to guard makes
  // the block throw, so letting it escape would kill the run at the first assertion and hide
  // every later one — a crashed suite reports less than a failing one. Verified: reinstating the
  // unguarded `crypto.randomUUID()` call throws the historical
  // "crypto.randomUUID is not a function" here, and it must surface as a FAIL, not a stack trace.
  try {
    return fn({ crypto: cryptoStub }, cryptoStub, Uint8Array);
  } catch (e) {
    return { threw: e.message };
  }
}
// Every assertion below wants a string; a thrown error must fail loudly rather than stringify
// into something that accidentally satisfies a regex.
const idOf = (r) => (typeof r === "string" ? r : `THREW: ${r.threw}`);

console.log("clientId: the fallback chain that has to survive a NON-secure context");
{
  // Step 1 — the happy path. localhost and https both provide randomUUID.
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  check("randomUUID is used when available", idOf(makeClientId({ randomUUID: () => uuid })), uuid);

  // Step 2 — randomUUID absent, getRandomValues present. This is the case that matters:
  // getRandomValues is ALSO secure-context-gated in principle, but browsers ship it more
  // widely, so it is the first fallback rather than the last.
  const gv = idOf(makeClientId({
    getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; },
  }));
  check("falls back to getRandomValues -> 32 hex chars", gv.length, 32);
  checkTrue("...and it is hex only", /^[0-9a-f]{32}$/.test(gv), `got ${gv}`);
  // THE BUG THIS GUARDS: `toString(16)` on a byte < 16 yields ONE char, so without
  // padStart(2,"0") the id is short and two different byte arrays can collide.
  check("byte 0 is encoded as '00', not '0' (padStart)", gv.slice(0, 4), "0001");

  // Step 3 — no crypto at all. THE ORIGINAL CRASH: this is what an off-localhost viewer sees,
  // and calling randomUUID() there threw before the player was ever constructed.
  const weak = idOf(makeClientId(undefined));
  checkTrue("no crypto at all still returns an id instead of throwing", typeof weak === "string" && weak.length > 8,
    "this is the off-localhost case that killed every LAN-IP viewer");
  checkTrue("the weak id is recognisable as the fallback (v- prefix)", weak.startsWith("v-"),
    "a prefix makes the degraded case visible in the dashboard rather than silent");

  // An empty crypto object must degrade too — `window.crypto` existing does not imply either
  // method exists, and a truthiness-only check would throw here.
  const empty = idOf(makeClientId({}));
  checkTrue("an EMPTY crypto object degrades rather than throwing", empty.startsWith("v-"),
    "window.crypto can exist with neither method");

  // Uniqueness across calls, in every mode. Colliding ids merge two viewers into one row on the
  // dashboard, which silently halves the reported viewer count and doubles one client's bytes.
  const a = idOf(makeClientId(undefined)), b = idOf(makeClientId(undefined));
  checkTrue("two weak ids differ", a !== b, `${a} vs ${b}`);
  let distinct = new Set();
  for (let i = 0; i < 50; i++) distinct.add(idOf(makeClientId(undefined)));
  check("50 weak ids are all distinct", distinct.size, 50);

  // The source must not reference randomUUID unguarded anywhere in that block — the guard is
  // the whole point, and a later edit could reintroduce a bare call.
  const block = HTML.match(/const clientId = \(\(\) => \{[\s\S]*?\}\)\(\);/)[0];
  checkTrue("randomUUID is only called behind a typeof guard",
    /typeof crypto\.randomUUID === "function"/.test(block),
    "an unguarded call throws in a non-secure context, before the player exists");
  checkTrue("getRandomValues is likewise guarded",
    /typeof crypto\.getRandomValues === "function"/.test(block));
}

console.log("\nmetrics report: the ONE payload every published number travels in");
{
  // Extract the real POST body expression and evaluate it with known values. If a key is
  // renamed or dropped here, playback is unaffected and nothing throws — the server just
  // records zero, and a published figure quietly becomes wrong.
  // The base report is built as `const report = {…}` (P2P-0083 then conditionally adds pubKey/sig/
  // cert). Extract that object literal — the base counters are the contract metrics.test.js checks.
  const m = HTML.match(/const report = \{[\s\S]*?\n      \};/);
  if (!m) throw new Error("could not find the report object in web/index.html");
  const expr = m[0].replace(/^const report = /, "").replace(/;$/, "");
  // The literal uses `attest` (the snapshot const built one line above, iter 124); inject that name.
  const fn = new Function(
    "clientId", "httpBytes", "p2pBytes", "uploadBytes", "ownPeerId", "attest", "Date",
    `return ${expr};`
  );
  // fn returns the report OBJECT directly (the literal is no longer wrapped in JSON.stringify).
  const body = fn(
    "c1", 111, 222, 333, () => "peer-abc", { "peer-x": 999 }, { now: () => 1700000000000 }
  );

  // The server reads exactly these keys — metrics.test.js asserts the other side of this
  // contract, so a rename in either file must fail one of the two suites.
  check("clientId", body.clientId, "c1");
  check("httpBytes", body.httpBytes, 111);
  check("p2pBytes", body.p2pBytes, 222);
  check("uploadBytes", body.uploadBytes, 333);
  check("ts is a number the SERVER can compare against its own clock", typeof body.ts, "number");
  // peerId joins engine identity to clientId. Without it, receiver-attested credit cannot be
  // mapped to a tracked viewer and the whole attestation feature reports `unmapped:`.
  check("peerId comes from ownPeerId()", body.peerId, "peer-abc");
  check("attest carries the per-peer witness map", body.attest["peer-x"], 999);
  // Exactly these keys, no more: an unexpected key is not harmful but it means the two sides
  // have drifted, and this is the cheapest place to notice.
  check("no unexpected keys", Object.keys(body).sort().join(","),
    "attest,clientId,httpBytes,p2pBytes,peerId,ts,uploadBytes");

  // ownPeerId() must be tolerated returning null — the engine has no public getter for it and
  // it is read defensively. A null must serialise, not throw or vanish the whole body.
  const nullPeer = fn("c1", 1, 2, 3, () => null, {}, { now: () => 1 });
  check("a null peerId still produces a valid body", nullPeer.peerId, null);
  check("...with the byte counters intact", nullPeer.httpBytes, 1);
}

console.log("\nownPeerId: reads a path with no public getter, so it must never throw");
{
  const m = HTML.match(/const ownPeerId = \(\) => \{[\s\S]*?\};/);
  if (!m) throw new Error("could not find ownPeerId in web/index.html");
  // Same capture as makeClientId: removing the try/catch makes this THROW on every missing
  // rung, and a crash would hide the rest of the file instead of failing five assertions.
  const build = (win) => {
    try { return new Function("window", `${m[0]} return ownPeerId;`)(win)(); }
    catch (e) { return `THREW: ${e.message}`; }
  };
  check("reads engine.core.peerId", build({ __hls: { p2pEngine: { core: { peerId: "p9" } } } }), "p9");
  // Every rung of that chain can be missing depending on when the report interval fires
  // relative to engine setup, and this runs on a timer from the first tick.
  check("no __hls yet -> null, not a throw", build({}), null);
  check("no p2pEngine -> null", build({ __hls: {} }), null);
  check("no core -> null", build({ __hls: { p2pEngine: {} } }), null);
  check("core with no peerId -> null", build({ __hls: { p2pEngine: { core: {} } } }), null);
  // `|| null` matters: an empty string would be sent as "" and become a Map key on the server.
  check("empty-string peerId normalises to null", build({ __hls: { p2pEngine: { core: { peerId: "" } } } }), null);
}

console.log("\nbrowser canonicalize BYTE-MATCHES server/identity.js (P2P-0082) — the signed bytes must agree");
{
  // The browser signs canonicalize(report); node verifies canonicalize(report). If the two ever
  // diverge, EVERY browser signature silently fails to verify and certified credit quietly drops to
  // 0 — no error, just a dead reward tier. Extract the REAL browser canonicalize and compare its
  // output to node's on shapes that exercise key-sorting, nesting, arrays, and dropped-undefined.
  const bm = HTML.match(/const canonicalize = \(obj\) => \{[\s\S]*?\n    \};/);
  if (!bm) throw new Error("could not find browser canonicalize in web/index.html");
  const browserCanon = new Function(`${bm[0]} return canonicalize;`)();
  const { canonicalize: nodeCanon } = await import("../server/identity.js");
  const samples = [
    { clientId: "rcv", attest: { "peer-b": 4000000, "peer-a": 1000 } }, // key sort at 2 levels
    { b: 2, a: 1, c: { z: 9, y: 8 } },                                   // nested sort
    { arr: [3, 1, { k: "v", a: "b" }], s: "x" },                         // array order preserved, obj sorted
    { keep: 1, drop: undefined },                                        // undefined dropped
    { segmentId: "s1", bytes: 262144, senderPeerId: "A", receiverPeerId: "B" }, // a real receipt
  ];
  for (let i = 0; i < samples.length; i++) {
    check(`canonicalize sample #${i} matches node byte-for-byte`, browserCanon(samples[i]), nodeCanon(samples[i]));
  }
  // Guard the interop invariant directly: identical output means a browser sig verifies under node.
  checkTrue("both drop undefined identically (not {\"drop\":undefined})",
    !browserCanon({ keep: 1, drop: undefined }).includes("drop") && browserCanon({ keep: 1, drop: undefined }) === nodeCanon({ keep: 1, drop: undefined }));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
