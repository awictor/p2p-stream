#!/usr/bin/env node
/**
 * spread.test.js — per-viewer bandwidth cost and the spread across viewers (P2P-0048).
 *
 * Every cost figure this project publishes is a POOLED MEAN: swarm bytes / swarm video-seconds.
 * The per-viewer inputs (`heldS`, and the ledger's `httpBytes`/`p2pBytes`) have been captured
 * since iter 29 and averaged away at print time, so the tail was measurable the whole time and
 * nobody looked. That matters commercially: an ad-free-for-relay tier would be priced on the
 * mean, and the viewer paying well above it is the one who uninstalls.
 *
 * The two behaviours that make this honest rather than decorative, and both are asserted:
 *   1. A viewer with NO video-seconds is EXCLUDED, not counted as 0. Folding a dead tab in as
 *      zero drags the mean down and invents a rosier spread than reality.
 *   2. A spread under 10% is reported as "the mean was REPRESENTATIVE" — a null result. Printing
 *      "worst viewer 1.02x the mean" as though it were news would manufacture a finding.
 *
 * Usage: node test/spread.test.js     (exit 0 = pass, 1 = fail)
 */
import { viewerSpread, viewerSpreadLines } from "./verify-offload.js";

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
// One viewer: `heldS` seconds of video obtained for `mb` megabytes fetched.
const v = (heldS, mb) => ({ heldS, led: { httpBytes: mb * 1e6, p2pBytes: 0 } });

console.log("viewerSpread: the arithmetic behind the pooled mean");
{
  // Four viewers, all identical: 100MB over 400s = 250 KB/video-s each.
  const even = viewerSpread([v(400, 100), v(400, 100), v(400, 100), v(400, 100)]);
  check("counts every viewer with video", even.n, 4);
  check("mean KB/video-s", Math.round(even.mean), 250);
  check("min == max when even", Math.round(even.min), Math.round(even.max));
  check("spread is 0%", even.spreadPct, 0);
  check("worst pays exactly 1.00x the mean", +even.maxOverMean.toFixed(2), 1);

  // An uneven swarm — the case the pooled mean hides. tab3 obtained only 100s of video for the
  // same 100MB, so it paid 4x what the others did per second of video watched.
  const uneven = viewerSpread([v(400, 100), v(400, 100), v(400, 100), v(100, 100)]);
  check("worst viewer is identified by index", uneven.worst.viewer, 3);
  check("best viewer too", uneven.best.viewer, 0);
  check("worst KB/video-s", Math.round(uneven.worst.kbPerVideoS), 1000);
  // mean of 250,250,250,1000 = 437.5 -> worst is 2.29x the mean, spread (1000-250)/437.5 = 171%
  check("mean is dragged up but still under the worst", Math.round(uneven.mean), 438);
  check("worst-over-mean", +uneven.maxOverMean.toFixed(2), 2.29);
  check("spread percentage", uneven.spreadPct, 171);
  checkTrue("...and the MEAN UNDERSTATES the worst viewer, which is the whole point",
    uneven.mean < uneven.worst.kbPerVideoS,
    "if the mean already equalled the max there would be no tail to report");
}

console.log("\nexclusions: a dead tab must not flatter the numbers");
{
  // THE ASSERTION THAT KEEPS THIS HONEST. A viewer that never played has no cost per
  // video-second. Counting it as 0 KB/video-s would pull the mean down and shrink the apparent
  // spread — i.e. make the product look better because a viewer failed.
  const withDead = viewerSpread([v(400, 100), v(400, 100), v(0, 50)]);
  check("a viewer with 0 video-seconds is excluded from n", withDead.n, 2);
  check("...and counted so the exclusion is visible", withDead.noVideo, 1);
  check("the mean is unaffected by the dead tab", Math.round(withDead.mean), 250);
  const noDead = viewerSpread([v(400, 100), v(400, 100)]);
  check("identical to the same swarm without it", Math.round(withDead.mean), Math.round(noDead.mean));

  // A viewer with no ledger at all (window.__ledger absent — happens in the P2P-off arm before
  // the FRAG_LOADED path installs) must also be skipped rather than treated as zero bytes.
  const noLedger = viewerSpread([v(400, 100), { heldS: 400, led: null }]);
  check("a viewer with no ledger is excluded", noLedger.n, 1);
  check("and counted", noLedger.noVideo, 1);

  // Degenerate inputs must return null, not a fabricated zero-spread.
  check("empty array -> null", viewerSpread([]), null);
  check("null -> null", viewerSpread(null), null);
  check("all viewers dead -> null", viewerSpread([v(0, 10), { heldS: 0, led: null }]), null);
  // Negative heldS is nonsense from a stubbed/broken media element; treat as no video.
  check("negative heldS is excluded, not negated", viewerSpread([v(-5, 10)]), null);
  // Both byte counters missing -> 0 bytes over real video is a legitimate 0, not an exclusion.
  const zeroBytes = viewerSpread([{ heldS: 100, led: { httpBytes: 0, p2pBytes: 0 } }]);
  check("0 bytes over real video-seconds IS counted (a free viewer is a real result)", zeroBytes.n, 1);
  check("...at 0 KB/video-s", zeroBytes.mean, 0);
  // p2pBytes must be included, not just httpBytes — otherwise a heavy relayer looks cheap.
  const bothTransports = viewerSpread([{ heldS: 100, led: { httpBytes: 50e6, p2pBytes: 50e6 } }]);
  check("p2p bytes count toward the viewer's cost", Math.round(bothTransports.mean), 1000);
}

console.log("\nviewerSpreadLines: the >=10% finding vs the <10% null result");
{
  const uneven = viewerSpreadLines(viewerSpread([v(400, 100), v(400, 100), v(400, 100), v(100, 100)]));
  checkTrue("prints something", uneven.length > 0);
  checkTrue("names the worst tab", uneven.some((l) => /tab3/.test(l)));
  checkTrue("marks it in the per-viewer list", uneven.some((l) => /<- WORST/.test(l)));
  checkTrue("prints min/mean/max together", uneven.some((l) => /min .* mean .* max/.test(l)));
  checkTrue("states the multiple of the mean", uneven.some((l) => /2\.29x the mean/.test(l)));
  checkTrue("warns that pricing on the mean underprices that viewer",
    uneven.some((l) => /underprices/.test(l)),
    "the commercial consequence is the reason this measurement exists");
  checkTrue("names churn as the risk", uneven.some((l) => /churn/.test(l)));

  // The NULL RESULT. An even swarm must be reported as "the mean was representative", NOT as a
  // spread finding — otherwise every run manufactures a dramatic-sounding number out of noise.
  const even = viewerSpreadLines(viewerSpread([v(400, 100), v(400, 100), v(400, 100)]));
  checkTrue("an even swarm says the mean was REPRESENTATIVE",
    even.some((l) => /REPRESENTATIVE/.test(l)),
    "a 0% spread is a null result and must read as one");
  checkTrue("...and says so explicitly as a null result", even.some((l) => /null result/.test(l)));
  checkTrue("an even swarm does NOT warn about underpricing",
    !even.some((l) => /underprices/.test(l)),
    "crying tail on an even swarm would make the warning worthless");
  checkTrue("it also notes the null may not survive a real network",
    even.some((l) => /real network/.test(l)));

  // Just over and just under the threshold — the boundary is where a wrong comparison hides.
  // 250,250,275: mean 258.3, spread (275-250)/258.3 = 10% -> finding.
  const at10 = viewerSpreadLines(viewerSpread([v(400, 100), v(400, 100), v(400, 110)]));
  checkTrue("a 10% spread is a finding (>= not >)", at10.some((l) => /underprices/.test(l)),
    "the documented threshold is 10%, inclusive");
  // 250,250,262.5: mean 254.2, spread 5% -> null.
  const at5 = viewerSpreadLines(viewerSpread([v(400, 100), v(400, 100), v(400, 105)]));
  checkTrue("a 5% spread is the null result", at5.some((l) => /REPRESENTATIVE/.test(l)));

  // A single viewer has no spread. Reporting "0% spread, worst pays 1.00x" for N=1 would be
  // arithmetic dressed as measurement — the same class as the iter-35 single-relayer row.
  const solo = viewerSpreadLines(viewerSpread([v(400, 100)]));
  checkTrue("N=1 says there is no spread to report", solo.some((l) => /no spread to report/.test(l)));
  checkTrue("N=1 does not claim the mean was representative",
    !solo.some((l) => /REPRESENTATIVE/.test(l)),
    "with one sample there is nothing for the mean to represent");
  checkTrue("N=1 marks no WORST viewer", !solo.some((l) => /<- WORST/.test(l)));

  // Exclusions must be stated in the output, not just counted internally.
  const withDead = viewerSpreadLines(viewerSpread([v(400, 100), v(400, 100), v(0, 50)]));
  checkTrue("an excluded viewer is reported in the lines",
    withDead.some((l) => /excluded/.test(l)),
    "a silent exclusion is a silently altered mean");

  check("null spread -> no lines", viewerSpreadLines(null).length, 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
