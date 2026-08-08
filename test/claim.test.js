#!/usr/bin/env node
/**
 * claim.test.js — unit test for the ONE number this project publishes.
 *
 * `verify-offload.js` is the only accepted proof of offload, and until now it had no tests of
 * its own: the arithmetic that produces "origin egress fell 51%" lived inline in a 600-line
 * async driver that cannot run without four services and a browser. Every external claim —
 * README, roadmap, any pitch — flows through it, so a silent error there misreports the
 * product's entire value proposition while every other test stays green.
 *
 * The defect this covers: the saving was computed as a raw byte subtraction,
 * `(off.httpBytes - on.httpBytes) / off.httpBytes`. That is only valid when both arms obtained
 * the SAME amount of video. When they differ it credits P2P for video the control arm played
 * and the P2P arm did not — overstating the saving by up to ~22 points in a plausible case.
 * Past runs happened to match (472s vs 472s), so the number was right by luck, not by
 * construction. `claimNumbers()` now normalises by video-seconds.
 *
 * Usage: node test/claim.test.js     (exit 0 = pass, 1 = fail)
 */
import { claimNumbers, skewWarning } from "./verify-offload.js";

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

// Importing the harness must NOT launch browsers or require a live stack. If this file runs at
// all, the isMain guard works.
console.log("claim arithmetic — imported from the real verify-offload.js:");
checkTrue("claimNumbers is exported and importable without starting the harness",
  typeof claimNumbers === "function");

console.log("\nthe real measured run (arms obtained equal video)");
{
  // The actual iter-31 figures. Equal video, so normalised and raw agree — this is the case
  // that made the old formula look correct.
  const on = { httpBytes: 74.8e6, heldS: 472 };
  const off = { httpBytes: 151.6e6, heldS: 472 };
  const c = claimNumbers(on, off);
  check("saving is -51% per video-second", c.savedPct, 51);
  check("raw agrees when video is equal", c.rawSavedPct, 51);
  check("no video skew", c.videoSkewPct, 0);
}

console.log("\nTHE BUG: unequal video must NOT inflate the saving");
{
  // Same origin bytes, but the P2P arm obtained 30% less video. The raw subtraction still
  // claims 51%; the truth per video-second is far lower. This is the assertion that fails
  // against the old inline formula.
  const on = { httpBytes: 74.8e6, heldS: 330 };
  const off = { httpBytes: 151.6e6, heldS: 472 };
  const c = claimNumbers(on, off);
  check("raw subtraction would have claimed 51%", c.rawSavedPct, 51);
  check("normalised saving is 29%", c.savedPct, 29);
  checkTrue("normalised is strictly smaller than raw here", c.savedPct < c.rawSavedPct,
    "unequal video inflates the raw number");
  checkTrue("skew is reported so the run can be flagged", c.videoSkewPct >= 30);
}

console.log("\nthe reverse skew must not UNDERSTATE either");
{
  // If the P2P arm obtained MORE video, the raw formula understates the saving. A correct
  // normalisation has to move in both directions, not just guard the flattering case.
  const on = { httpBytes: 74.8e6, heldS: 600 };
  const off = { httpBytes: 151.6e6, heldS: 472 };
  const c = claimNumbers(on, off);
  checkTrue("normalised saving exceeds raw when P2P played more video",
    c.savedPct > c.rawSavedPct);
  check("and it is 61%", c.savedPct, 61);
}

console.log("\nno saving, or a loss, is reported honestly");
{
  const same = claimNumbers({ httpBytes: 100e6, heldS: 100 }, { httpBytes: 100e6, heldS: 100 });
  check("identical arms -> 0%", same.savedPct, 0);
  const worse = claimNumbers({ httpBytes: 150e6, heldS: 100 }, { httpBytes: 100e6, heldS: 100 });
  checkTrue("P2P using MORE origin gives a negative saving, not a clamped 0",
    worse.savedPct < 0, "a hidden clamp would disguise a regression as break-even");
  check("and it is -50%", worse.savedPct, -50);
}

console.log("\ndegenerate inputs return null rather than a fabricated number");
{
  // A missing denominator must not become Infinity/NaN and get printed as a percentage.
  check("zero video-seconds -> null", claimNumbers({ httpBytes: 1e6, heldS: 0 }, { httpBytes: 2e6, heldS: 0 }).savedPct, null);
  check("zero control origin bytes -> null raw", claimNumbers({ httpBytes: 0, heldS: 10 }, { httpBytes: 0, heldS: 10 }).rawSavedPct, null);
  check("missing arm -> null result", claimNumbers(null, { httpBytes: 1e6, heldS: 10 }), null);
  const c = claimNumbers({ httpBytes: 1e6, heldS: 10 }, { httpBytes: 2e6, heldS: 0 });
  check("control with no video -> null saving", c.savedPct, null);
  checkTrue("and never NaN", !Number.isNaN(c.savedPct));
}

console.log("\nsavedBytes stays a raw byte figure (it is quoted as MB, not as a rate)");
{
  const c = claimNumbers({ httpBytes: 74.8e6, heldS: 472 }, { httpBytes: 151.6e6, heldS: 472 });
  check("savedBytes is the plain difference", Math.round(c.savedBytes), 76800000);
}

console.log("\nthe skew WARNING must actually fire (iter 53) — arithmetic is not enough");
{
  // Was a manual-QA box: "force a skewed run and confirm the ⚠ warning fires". The skew
  // ARITHMETIC was already covered above, but nothing checked the harness EMITS anything — so
  // a run with unequal arms could have published a raw subtraction in silence. A correct number
  // that never reaches the reader is not a correct report.
  const skewed = claimNumbers({ httpBytes: 74.8e6, heldS: 330 }, { httpBytes: 151.6e6, heldS: 472 });
  const lines = skewWarning(skewed, 472, 330);
  checkTrue("a 30% skew produces a warning", lines.length > 0, "silence would publish the raw figure");
  checkTrue("it is marked with the ⚠ the operator scans for", lines.some((l) => l.includes("⚠")));
  checkTrue("it states the skew percentage", lines.some((l) => l.includes(`${skewed.videoSkewPct}%`)));
  checkTrue("it names BOTH figures so the gap is visible",
    lines.some((l) => l.includes(`-${skewed.rawSavedPct}%`)) &&
    lines.some((l) => l.includes(`-${skewed.savedPct}%`)),
    "quoting only one number hides which was avoided");
  checkTrue("it says which one to quote", lines.some((l) => /per-video-second/.test(l)));

  // And it must stay QUIET when the arms match, or the warning becomes noise that gets ignored
  // — which is the same failure as not warning at all.
  const equal = claimNumbers({ httpBytes: 74.8e6, heldS: 472 }, { httpBytes: 151.6e6, heldS: 472 });
  check("equal arms produce no warning", skewWarning(equal, 472, 472).length, 0);
  // Just under the 3% threshold: raw and normalised are interchangeable there.
  const tiny = claimNumbers({ httpBytes: 74.8e6, heldS: 465 }, { httpBytes: 151.6e6, heldS: 472 });
  checkTrue("a sub-threshold skew stays quiet", skewWarning(tiny, 472, 465).length === 0,
    `videoSkewPct=${tiny.videoSkewPct} should be <= 3`);
  // No video at all -> videoSkewPct is null, not 0. Warning must not throw or fire on that.
  const none = claimNumbers({ httpBytes: 74.8e6, heldS: 0 }, { httpBytes: 151.6e6, heldS: 0 });
  check("a run with no video-seconds warns nothing (null, not 0)", skewWarning(none, 0, 0).length, 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
