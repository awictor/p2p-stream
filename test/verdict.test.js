#!/usr/bin/env node
/**
 * verdict.test.js — the pass/fail decision the whole harness exists to make (iter 60).
 *
 * `offloadVerdict()` was inline until iter 60, and extracting it exposed a real bug: the
 * single-run verdict read `final.p2pBytes` — the CUMULATIVE /stats counter — while the summary
 * object `--sweep` judges on used `dP2p`, the DELTA for that run. Those disagree on a warm
 * metrics server, because the server evicts client entries but never the byte totals (that is
 * deliberate, so `offloadRatio` cannot move backwards). So a run that relayed nothing of its own
 * still saw `final.p2pBytes > 0` from an earlier run and **exited 0 = PASS**.
 *
 * That is the worst possible failure for this file: `npm run verify` exiting 0 is the only thing
 * in the project that counts as proof of offload, and it could be satisfied by a stale number.
 * Both call sites now go through this function, so they cannot diverge again.
 *
 * Usage: node test/verdict.test.js     (exit 0 = pass, 1 = fail)
 */
import { offloadVerdict } from "./verify-offload.js";

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

console.log("offloadVerdict: exit 0 is the ONLY claim of proven offload");
{
  const good = offloadVerdict({ p2pBytes: 50e6, p2pSegments: 120 });
  check("real bytes + real segments passes", good.pass, true);
  check("...with exit code 0", good.code, 0);
  checkTrue("and says why", /peer-to-peer bytes observed/.test(good.reason));
  check("no stale warning on a clean pass", good.staleWarning, null);

  const nothing = offloadVerdict({ p2pBytes: 0, p2pSegments: 0 });
  check("no bytes and no segments fails", nothing.pass, false);
  check("...with exit code 1, not 2 (the stack WAS up)", nothing.code, 1);
  checkTrue("and names the watch window", /watch window/.test(nothing.reason));
}

console.log("\nTHE BUG (iter 60): a carried-over counter must NOT read as a pass");
{
  // The exact condition the old inline verdict got wrong. This run relayed NOTHING — zero delta
  // bytes, zero P2P segments — but the cumulative counter still holds 200MB from an earlier run
  // on the same metrics server. The old code read final.p2pBytes here and exited 0.
  const stale = offloadVerdict({ p2pBytes: 0, p2pSegments: 0, cumulativeP2pBytes: 200e6 });
  check("a run that contributed 0 bytes FAILS even with 200MB cumulative", stale.pass, false);
  check("...exit code 1", stale.code, 1);
  checkTrue("...and the stale counter is called out explicitly",
    stale.staleWarning !== null && /carried-over counter is not proof/.test(stale.staleWarning),
    "silently failing would hide WHY it failed, and the operator would suspect the mesh");
  checkTrue("the warning quotes both numbers so the gap is visible",
    /200000000/.test(stale.staleWarning) && /contributed 0/.test(stale.staleWarning));
  checkTrue("and says how to get a clean read",
    /[Rr]estart the metrics server/.test(stale.staleWarning));

  // A genuine pass must not be given a stale warning just because cumulative > delta — that is
  // the NORMAL case on any warm server and warning about it would train the reader to ignore it.
  const warmPass = offloadVerdict({ p2pBytes: 50e6, p2pSegments: 120, cumulativeP2pBytes: 900e6 });
  check("a passing run on a warm server still passes", warmPass.pass, true);
  check("...and gets NO stale warning (cumulative > delta is normal)", warmPass.staleWarning, null);
}

console.log("\nboth conditions are load-bearing: bytes AND segments");
{
  // Bytes with no segments means the byte counter moved for a reason the segment listener never
  // saw. That is an accounting bug, and calling it a pass would publish a number nothing backs.
  const noSegs = offloadVerdict({ p2pBytes: 50e6, p2pSegments: 0 });
  check("bytes but zero segments FAILS", noSegs.pass, false);
  checkTrue("...named as an accounting mismatch", /accounting mismatch/.test(noSegs.reason),
    "this is not 'no offload', it is two instruments disagreeing");

  // The reverse: segments reported but no bytes. Same class, opposite direction.
  const noBytes = offloadVerdict({ p2pBytes: 0, p2pSegments: 120 });
  check("segments but zero bytes FAILS", noBytes.pass, false);
  checkTrue("...also an accounting mismatch", /accounting mismatch/.test(noBytes.reason));
  checkTrue("the two mismatch reasons are DISTINGUISHABLE",
    noSegs.reason !== noBytes.reason,
    "opposite bugs must not print the same diagnosis");
}

console.log("\ndegenerate and hostile inputs must not fabricate a pass");
{
  // A missing counter is not a passing counter. `undefined` arithmetic yields NaN, and NaN > 0
  // is false — but that must be by intent, not by luck, so it is asserted.
  check("undefined bytes -> fail", offloadVerdict({ p2pSegments: 120 }).pass, false);
  check("undefined segments -> fail", offloadVerdict({ p2pBytes: 50e6 }).pass, false);
  check("empty object -> fail", offloadVerdict({}).pass, false);
  check("NaN bytes -> fail", offloadVerdict({ p2pBytes: NaN, p2pSegments: 120 }).pass, false);
  check("null bytes -> fail", offloadVerdict({ p2pBytes: null, p2pSegments: 120 }).pass, false);
  // A negative delta is possible if the metrics server restarted mid-run (counters reset to 0,
  // so final < before). It must never be read as offload.
  check("negative bytes -> fail", offloadVerdict({ p2pBytes: -1, p2pSegments: 120 }).pass, false);
  // String inputs: /stats is JSON over the wire, so a schema change could deliver strings.
  check("numeric strings still work", offloadVerdict({ p2pBytes: "50000000", p2pSegments: "120" }).pass, true);
  check("non-numeric strings -> fail", offloadVerdict({ p2pBytes: "lots", p2pSegments: "120" }).pass, false);
  // ONE byte and ONE segment is a pass. The rule is "any real P2P transfer", not a threshold —
  // adding a floor here would silently redefine what the project claims to have proven.
  check("1 byte + 1 segment passes (no hidden threshold)", offloadVerdict({ p2pBytes: 1, p2pSegments: 1 }).pass, true);
}

console.log("\nthe two call sites must use the SAME function (they diverged before)");
{
  // Read the harness source and assert the inline comparison is gone. This is the regression
  // guard: the bug was not a wrong value, it was TWO definitions of "pass" in one file.
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const path = await import("path");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(path.join(dir, "verify-offload.js"), "utf8");
  // Strip BLOCK comments as well as line comments. `offloadVerdict`'s own doc comment quotes the
  // buggy expression verbatim to explain it, so a line-comment-only strip left `final.p2pBytes > 0`
  // in the haystack and this guard failed against correct code. Fourth time in this repo that
  // explanatory prose has contained the wrong value on purpose (start.sh's process.exit, nginx's
  // sendfile, the Caddyfile's rejected alternative) — assume it always does.
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments, incl. the /** doc */ that names the bug
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  checkTrue("no inline `final.p2pBytes > 0` verdict remains",
    !/final\.p2pBytes\s*>\s*0/.test(code),
    "that comparison is the bug — it judges a run on a previous run's counter");
  checkTrue("no inline `dP2p > 0 && p2pSegments > 0` summary remains",
    !/dP2p\s*>\s*0\s*&&\s*p2pSegments\s*>\s*0/.test(code),
    "two hand-written definitions of pass are how they drifted apart");
  // Both sites call the function: the summary's `pass` field and the exit-code branch.
  const calls = (code.match(/offloadVerdict\(/g) || []).length;
  checkTrue("offloadVerdict is called at least 3 times (summary + pass branch + fail branch)",
    calls >= 3, `found ${calls}`);
  checkTrue("the summary's pass field comes from it", /pass: offloadVerdict\(/.test(code));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
