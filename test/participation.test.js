#!/usr/bin/env node
/**
 * participation.test.js — unit test for the participation plan and its verdict thresholds.
 *
 * Iter 35 measured that the origin saving decays FASTER than the relayer count (100%→-69%,
 * 50%→-29%, 25%→-7%), which is now a headline claim in the README. That claim rests on two
 * pieces of logic that were inline in a 1000-line async driver and only reachable through a
 * ~10-minute browser sweep:
 *
 *   1. which viewers relay, and what URL each one loads
 *   2. the thresholds that label a row "graceful" vs "collapse"
 *
 * Both are now pure exports. Extracting the first immediately exposed a real footgun:
 * `{p2p:false, relayers:3}` produced THREE relayers, silently overriding an explicit control
 * arm. A run that reports a participation rate it never ran is the most misleading output this
 * harness can produce, so the precedence is asserted here rather than trusted.
 *
 * Usage: node test/participation.test.js     (exit 0 = pass, 1 = fail)
 */
import { participationPlan, participationVerdict } from "./verify-offload.js";

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

const BASE = "http://localhost:5173/index.html";
const plan = (o) => participationPlan({ baseUrl: BASE, ...o });
// Does viewer i load with P2P off?
const isOff = (p, i) => new URL(p.urlFor(i)).searchParams.get("p2p") === "off";

console.log("participation plan — imported from the real verify-offload.js:");
checkTrue("both helpers exported without starting the harness",
  typeof participationPlan === "function" && typeof participationVerdict === "function");

console.log("\ndefault: everyone relays (what every number before iter 35 assumed)");
{
  const p = plan({ viewers: 4 });
  check("all 4 relay", p.relayers, 4);
  check("100%", p.participationPct, 100);
  checkTrue("no viewer gets ?p2p=off", [0, 1, 2, 3].every((i) => !isOff(p, i)));
}

console.log("\nTHE FOOTGUN: p2p:false must WIN over any relayer count");
{
  // This is the bug extraction exposed. The old inline expression checked `relayers === null`
  // first, so an explicit relayer count silently re-enabled P2P on a control arm.
  const p = plan({ viewers: 4, relayers: 3, p2p: false });
  check("p2p:false forces 0 relayers even with relayers:3", p.relayers, 0);
  check("0%", p.participationPct, 0);
  checkTrue("every viewer loads with ?p2p=off", [0, 1, 2, 3].every((i) => isOff(p, i)),
    "a control arm that relays is not a control arm");
}

console.log("\nmixed participation splits per VIEWER, relayers first");
{
  const p = plan({ viewers: 8, relayers: 3 });
  check("3 relayers", p.relayers, 3);
  check("38%", p.participationPct, 38);
  checkTrue("viewers 0-2 relay", [0, 1, 2].every((i) => p.relayerAt(i) && !isOff(p, i)));
  checkTrue("viewers 3-7 freeload", [3, 4, 5, 6, 7].every((i) => !p.relayerAt(i) && isOff(p, i)));
  // Relayers must take the FIRST slots: with a staggered join, a freeloader first has nobody to
  // pull from and skews the early segments to HTTP.
  checkTrue("viewer 0 is a relayer", p.relayerAt(0));
}

console.log("\nrelayer count is clamped, never out of range");
{
  check("more relayers than viewers clamps down", plan({ viewers: 4, relayers: 9 }).relayers, 4);
  check("negative clamps to 0", plan({ viewers: 4, relayers: -3 }).relayers, 0);
  check("fractional floors", plan({ viewers: 8, relayers: 2.7 }).relayers, 2);
  check("zero viewers -> 0% not NaN", plan({ viewers: 0, relayers: 0 }).participationPct, 0);
}

console.log("\nthe window override only goes to viewers that actually relay");
{
  const p = plan({ viewers: 4, relayers: 2, p2pWindow: 120 });
  const win = (i) => new URL(p.urlFor(i)).searchParams.get("p2pWindow");
  check("relayer 0 carries the window", win(0), "120");
  check("relayer 1 carries the window", win(1), "120");
  check("freeloader 2 does NOT", win(2), null);
  checkTrue("and freeloader 2 is p2p=off", isOff(p, 2));
}

console.log("\nexisting query string on the base URL survives");
{
  // A naive "?p2p=off" concatenation would clobber it.
  const p = participationPlan({
    baseUrl: "http://localhost:5173/index.html?swarm=mine", viewers: 2, relayers: 1,
  });
  const u = new URL(p.urlFor(1));
  check("swarm preserved", u.searchParams.get("swarm"), "mine");
  check("and p2p=off added", u.searchParams.get("p2p"), "off");
}

console.log("\nverdict thresholds — these label the PUBLISHED conclusion:");
{
  // Reference row: 100% participation saved 69% (the real iter-35 figure).
  const at = (pct, savedPct, relayers = 4) =>
    participationVerdict({ pct, relayers, savedPct, fullPct: 100, fullSavedPct: 69 });

  check("proportional saving is graceful", at(50, 35).kind, "graceful");
  check("slightly under proportional is still graceful", at(50, 30).kind, "graceful");
  check("clearly under is worse-than-proportional", at(50, 25).kind, "worse-than-proportional");
  check("far under is a collapse", at(50, 10).kind, "collapse");
  // The real measured rows must classify the way the README reports them.
  check("measured 75%/-50% -> graceful", at(75, 50, 6).kind, "graceful");
  check("measured 50%/-29% -> worse", at(50, 29, 4).kind, "worse-than-proportional");
  check("measured 25%/-7% -> collapse", at(25, 7, 2).kind, "collapse");
  checkTrue("expected saving is reported for the log line", at(50, 29).expected > 34);
}

console.log("\na single relayer is NOT MEASURABLE, not a collapse");
{
  // It has no peer to pull from, so 0% is arithmetic. Reporting it as a collapse would be
  // reading a certainty as a finding — which the first iter-35 run did before this guard.
  const v = participationVerdict({ pct: 25, relayers: 1, savedPct: 0, fullPct: 100, fullSavedPct: 69 });
  check("classified not-measurable", v.kind, "not-measurable");
  check("no expectation is invented", v.expected, null);
  const zero = participationVerdict({ pct: 0, relayers: 0, savedPct: 0, fullPct: 100, fullSavedPct: 69 });
  check("zero relayers likewise", zero.kind, "not-measurable");
}

console.log("\nmissing data returns unknown rather than a fabricated verdict");
{
  check("null saving -> unknown",
    participationVerdict({ pct: 50, relayers: 4, savedPct: null, fullPct: 100, fullSavedPct: 69 }).kind,
    "unknown");
  check("null reference -> unknown",
    participationVerdict({ pct: 50, relayers: 4, savedPct: 29, fullPct: 100, fullSavedPct: null }).kind,
    "unknown");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
