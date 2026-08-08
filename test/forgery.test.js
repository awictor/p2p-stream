#!/usr/bin/env node
/**
 * forgery.test.js — unit test for the upload-forgery signal.
 *
 * A peer's `uploadBytes` is its own claim about itself, forgeable in one line, so the
 * ad-free-for-relay tier cannot pay out on it. Iter 39 added receiver attestation (peers report
 * what OTHERS served them); this covers the comparison that turns those two numbers into a
 * decision: does any viewer claim materially more than its receivers confirm?
 *
 * The threshold IS the product decision here — set it too tight and every honest run cries
 * forgery, too loose and the signal never fires — so it lives in a pure exported function with
 * the boundaries pinned, not inline in a 1000-line driver.
 *
 * Direction is asymmetric on purpose: over-claiming (self >> attested) is the payout risk and is
 * flagged; under-claiming is reported but harmless, since nobody gets paid for bytes they didn't
 * claim. Honest runs measured 0.97–1.03, so only a gross gap counts.
 *
 * Usage: node test/forgery.test.js     (exit 0 = pass, 1 = fail)
 */
import { forgerySignals } from "./verify-offload.js";

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

const MB = 1e6;
const row = (sig, id) => sig.rows.find((r) => r.id === id);

console.log("forgery signal — imported from the real verify-offload.js:");
checkTrue("exported and importable without starting the harness", typeof forgerySignals === "function");

console.log("\nan HONEST run (the measured 0.97 case) must NOT be flagged");
{
  // Real iter-39 figures: self 116.8MB vs attested 113.5MB across 4 viewers.
  const self = { a: 29.2 * MB, b: 29.2 * MB, c: 29.2 * MB, d: 29.2 * MB };
  const att = { a: 28.4 * MB, b: 28.4 * MB, c: 28.4 * MB, d: 28.4 * MB };
  const sig = forgerySignals(self, att);
  check("no suspects", sig.suspects.length, 0);
  checkTrue("every row judged (all above the noise floor)", sig.rows.every((r) => r.judged));
  checkTrue("ratio near 1", Math.abs(row(sig, "a").ratio - 0.972) < 0.01);
}

console.log("\nTHE CASE THAT MATTERS: one liar among honest viewers");
{
  // `b` claims 100MB but receivers confirm 2MB. A swarm-wide total would barely notice.
  const self = { a: 30 * MB, b: 100 * MB, c: 30 * MB };
  const att = { a: 29 * MB, b: 2 * MB, c: 29 * MB };
  const sig = forgerySignals(self, att);
  check("exactly one suspect", sig.suspects.length, 1);
  check("and it is the liar", sig.suspects[0].id, "b");
  checkTrue("the liar is flagged as over-claiming", row(sig, "b").overClaim);
  checkTrue("honest viewers are not flagged", !row(sig, "a").overClaim && !row(sig, "c").overClaim);
  // Aggregate check would have missed it: 160MB claimed vs 60MB attested is a 0.375 swarm ratio,
  // but a single honest-looking total is exactly how one liar hides. Per-client is the point.
  checkTrue("suspect's ratio is far below 1", row(sig, "b").ratio < 0.1);
}

console.log("\nthreshold boundaries — the product decision, pinned");
{
  // Default tolerance 0.25, so flag below 0.75.
  const at = (ratio) => forgerySignals({ x: 10 * MB }, { x: 10 * MB * ratio });
  checkTrue("0.80 is NOT flagged (normal report timing)", !row(at(0.80), "x").overClaim);
  checkTrue("0.76 is NOT flagged (just inside)", !row(at(0.76), "x").overClaim);
  checkTrue("0.70 IS flagged", row(at(0.70), "x").overClaim);
  checkTrue("0.00 IS flagged (claims bytes nobody received)", row(at(0), "x").overClaim);
  // Tolerance is a parameter, so a deployment can tighten it.
  const tight = forgerySignals({ x: 10 * MB }, { x: 9 * MB }, { tolerance: 0.05 });
  checkTrue("a tighter tolerance flags 0.90", row(tight, "x").overClaim);
}

console.log("\nunder-claiming is reported, never flagged");
{
  // Receivers report MORE than the peer admits. Not a payout risk — nobody is paid for bytes
  // they didn't claim — so flagging it would generate alarms with no security meaning.
  const sig = forgerySignals({ x: 10 * MB }, { x: 20 * MB });
  check("no suspects", sig.suspects.length, 0);
  checkTrue("but it is marked as under-claiming", row(sig, "x").underClaim);
}

console.log("\nsmall numbers are NOT judged — ratios there are startup noise");
{
  // A viewer that has served three segments can read 0.5 purely from report timing. Judging
  // those manufactures an alarm on every single run.
  const sig = forgerySignals({ tiny: 300000 }, { tiny: 10000 });
  checkTrue("ratio is terrible", row(sig, "tiny").ratio < 0.1);
  checkTrue("but the row is not judged", !row(sig, "tiny").judged);
  check("and it is not a suspect", sig.suspects.length, 0);
  // Once either side crosses the floor, it becomes judgeable.
  const big = forgerySignals({ tiny: 5 * MB }, { tiny: 10000 });
  checkTrue("above the floor it IS judged", row(big, "tiny").judged);
  check("and flagged", big.suspects.length, 1);
}

console.log("\nedge cases return usable values, never NaN");
{
  const zero = forgerySignals({ x: 0 }, { x: 0 });
  check("0 vs 0 -> null ratio, not NaN", row(zero, "x").ratio, null);
  check("and not a suspect", zero.suspects.length, 0);
  // Attested with no self-report at all: the peer never claimed, so nothing to over-claim.
  const ghost = forgerySignals({}, { g: 5 * MB });
  check("attested-only ratio is Infinity", row(ghost, "g").ratio, Infinity);
  check("not flagged as over-claiming", ghost.suspects.length, 0);
  check("empty input yields no rows", forgerySignals({}, {}).rows.length, 0);
}

console.log("\nunmapped attestations are summed separately, not judged as a client");
{
  // `unmapped:` keys are credits whose serving client is unknown (departed or unannounced).
  // Treating one as a viewer would invent a suspect with no self-report to compare against.
  const sig = forgerySignals({ a: 10 * MB }, { a: 10 * MB, "unmapped:peer-x": 3 * MB });
  check("unmapped bytes surfaced", sig.unmapped, 3 * MB);
  check("but not present as a row", row(sig, "unmapped:peer-x"), undefined);
  check("and no suspect invented", sig.suspects.length, 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
