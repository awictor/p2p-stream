#!/usr/bin/env node
/**
 * ledger.test.js — unit test for the per-segment fetch ledger in web/index.html.
 *
 * The ledger is what ATTRIBUTED the 1.52x total-byte gap between the P2P-on and P2P-off arms:
 * it reported 1.00 fetches per unique segment and zero duplicates, which is what ruled out a
 * double-counted event and a duplicate fetch and left "more distinct segments" as the cause.
 *
 * That conclusion rests entirely on the ledger being able to report a duplicate AT ALL. An
 * instrument that structurally always reads zero would have produced the same reassuring
 * output while measuring nothing — so these assertions make it prove it can count duplicates,
 * distinguish cross-transport ones, and not double-count a single delivery.
 *
 * It runs the REAL code extracted from web/index.html (same technique as config/dashboard
 * tests), so it cannot drift from what the browser executes.
 *
 * Usage: node test/ledger.test.js     (exit 0 = pass, 1 = fail)
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

// Pull the real ledger block out of the viewer and build a callable copy of it. `new Function`
// rather than eval so the declarations land in a scope we can return out of.
function makeLedger() {
  const m = HTML.match(/const seen = new Map\(\);[\s\S]*?window\.__ledger = \(\) => \{[\s\S]*?\n    \};/);
  if (!m) throw new Error("could not find the ledger block in web/index.html");
  // markPlayed() reads the real <video> element, so stub a document whose currentTime the test
  // controls. `seek()` is how a test moves the playhead and then asks what got marked played.
  // markPlayed() and the ledger both read the real <video>, so stub one whose currentTime AND
  // buffered ranges the test controls. `buffer()` sets what the media element claims to hold —
  // that is what separates "pending" from "wasted".
  const body = `
    let httpBytes = 0, p2pBytes = 0;
    const window = {};
    let ranges = [];
    const media = {
      currentTime: 0,
      buffered: {
        get length() { return ranges.length; },
        start: (i) => ranges[i][0],
        end: (i) => ranges[i][1],
      },
    };
    const document = { querySelector: () => media };
    ${m[0]}
    return {
      track, ledger: window.__ledger,
      seek: (t) => { media.currentTime = t; },
      buffer: (r) => { ranges = r; },
    };
  `;
  return new Function(body)();
}

console.log("segment ledger — extracted from the real web/index.html:");
const { track, ledger, seek } = makeLedger();
checkTrue("ledger block found and callable", typeof track === "function" && typeof ledger === "function");

console.log("\nempty state");
{
  const l = ledger();
  check("no fetches", l.fetches, 0);
  check("no unique segments", l.unique, 0);
  check("no duplicates", l.dupFetches, 0);
}

console.log("\none delivery per segment — the baseline the control arm must show");
{
  track("http://o/seg1.m4s", "http", 1000);
  track("http://o/seg2.m4s", "http", 1000);
  const l = ledger();
  check("2 fetches", l.fetches, 2);
  check("2 unique", l.unique, 2);
  check("no duplicates", l.dupFetches, 0);
  check("no duplicate bytes", l.dupBytes, 0);
  check("fetches/unique is exactly 1", l.fetches / l.unique, 1);
}

console.log("\nCROSS-TRANSPORT duplicate: HTTP and P2P raced the same segment");
{
  // This is the case that would mean real wasted bandwidth. If the ledger cannot see it,
  // its "zero duplicates" reading proves nothing.
  track("http://o/seg1.m4s", "p2p", 1000);
  const l = ledger();
  check("fetch counted", l.fetches, 3);
  check("but NOT a new unique segment", l.unique, 2);
  check("duplicate counted", l.dupFetches, 1);
  check("duplicate bytes attributed", l.dupBytes, 1000);
  check("flagged as cross-transport", l.crossTransport, 1);
  checkTrue("fetches/unique now exceeds 1", l.fetches / l.unique > 1);
}

console.log("\nSAME-TRANSPORT repeat: a refetch or a double-counted event");
{
  track("http://o/seg2.m4s", "http", 1000);
  const l = ledger();
  check("duplicate counted", l.dupFetches, 2);
  // Only seg1 crossed transports; seg2 repeated on http alone. Keeping these apart is what
  // separates "the loaders raced" from "one loader fetched twice" — different bugs.
  check("cross-transport count unchanged", l.crossTransport, 1);
}

console.log("\nsegments with no URL cannot be deduped, and must not corrupt the unique count");
{
  const before = ledger();
  track(undefined, "p2p", 500);
  track("", "p2p", 500);
  const l = ledger();
  check("counted as fetches", l.fetches, before.fetches + 2);
  check("but not as unique segments", l.unique, before.unique);
  check("and not as duplicates", l.dupFetches, before.dupFetches);
}

console.log("\nledger reports the byte counters it was given");
{
  const l = ledger();
  checkTrue("exposes httpBytes", typeof l.httpBytes === "number");
  checkTrue("exposes p2pBytes", typeof l.p2pBytes === "number");
}

console.log("\nPLAYED / PENDING / WASTED — the split that decides whether the 1.55x is tunable:");
{
  const L = makeLedger();
  L.seek(0);
  L.buffer([[0, 6]]);                                  // media holds 0-6s
  L.track("http://o/a.m4s", "p2p", 1000, 0, 2);         // playhead will pass this
  L.track("http://o/b.m4s", "p2p", 1000, 4, 6);         // ahead, but BUFFERED -> pending
  L.track("http://o/far.m4s", "p2p", 1000, 600, 602);   // ahead and NOT buffered -> wasted
  {
    const l = L.ledger();
    check("segment at the playhead is played", l.played, 1);
    check("buffered read-ahead is PENDING, not wasted", l.pending, 1);
    check("unbuffered fetch is WASTED", l.wasted, 1);
    check("and only its bytes are charged as waste", l.wastedBytes, 1000);
  }
  L.seek(5);
  {
    const l = L.ledger();
    check("playhead at 5s has played both buffered segments", l.played, 2);
    check("nothing pending once played", l.pending, 0);
    check("the unbuffered one is still wasted", l.wasted, 1);
  }
  // Monotonic: seeking BACKWARDS must not un-play a segment, or a live seek-to-edge would
  // erase the record and manufacture waste that never happened.
  L.seek(0);
  check("played count never decreases after seeking back", L.ledger().played, 2);
}

console.log("\nTRUNCATION IS NOT WASTE — the bug the control arm caught:");
{
  // An earlier version counted everything ahead of the playhead as wasted, so the HTTP-only
  // control arm read 51% wasted — which was really just its end-of-run buffer. A cut-off run
  // ALWAYS leaves a full buffer of unplayed segments. This is the regression guard.
  const L = makeLedger();
  L.seek(0);
  L.buffer([[0, 62]]);                                 // a full ~60s buffer, as at cutoff
  for (let i = 0; i < 31; i++) L.track(`http://o/s${i}.m4s`, "http", 1000, i * 2, i * 2 + 2);
  const l = L.ledger();
  check("a full buffer at cutoff yields ZERO waste", l.wasted, 0);
  check("all but the played one are pending", l.pending, 30);
  checkTrue("an HTTP-only arm therefore reads ~0% wasted",
    l.wasted / (l.played + l.pending + l.wasted) < 0.05,
    "counting buffered read-ahead as waste made the control arm read 51%");
}

console.log("\nuntimed segments are reported separately, never counted as waste");
{
  // Calling an untimed segment "wasted" would manufacture the exact result this measurement
  // exists to test, so it must land in its own bucket.
  const L = makeLedger();
  L.buffer([[0, 4]]);
  L.track("http://o/x.m4s", "p2p", 1000);              // no timing at all
  L.track("http://o/y.m4s", "p2p", 1000, 0, 2);
  const l = L.ledger();
  check("untimed counted as untimed", l.noTiming, 1);
  check("not counted as wasted", l.wasted, 0);
  check("timed+played still counted", l.played, 1);
  check("untimed bytes excluded from wasted bytes", l.wastedBytes, 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
