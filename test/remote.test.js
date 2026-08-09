#!/usr/bin/env node
/**
 * remote.test.js — remoteVerdict() + the host fingerprint it rests on (iter 70).
 *
 * `npm run verify:remote` is the printed verdict for the ONE milestone that has been user-gated
 * for 56 iterations. Its value is entirely in being TRUSTWORTHY: a check that prints PASS on a
 * loopback run is worse than no check at all, because it manufactures the exact claim HARD RULE 2
 * exists to forbid ("never claim offload was demonstrated unless it ran across >=2 machines").
 *
 * So the assertions that matter most here are the REFUSALS, not the pass:
 *   - 4 viewers, 1 host  -> code 2, REFUSED. This is every loopback run this repo has ever done,
 *     and it is the case a naive `viewers >= 2 && p2pBytes > 0` implementation certifies.
 *   - distinctHosts absent -> code 2. An older metrics server says nothing about hosts, and
 *     silence must not read as "hosts differ".
 *   - IPv4-mapped IPv6 ("::ffff:127.0.0.1") must fingerprint the same as "127.0.0.1", or one
 *     machine reaching the server over both stacks counts as two hosts and fakes the result.
 *
 * Usage: node test/remote.test.js     (exit 0 = pass, 1 = fail)
 */
import { remoteVerdict } from "./verify-offload.js";
import { hostFingerprint } from "../server/metrics.js";

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

// A genuine two-machine read: two viewers, two distinct hosts, real P2P bytes.
const CROSS = { viewers: 2, p2pBytes: 5e6, httpBytes: 20e6, offloadRatio: 0.2, distinctHosts: 2, loopbackClients: 1 };

console.log("remoteVerdict — importable without a live stack or a browser");
checkTrue("remoteVerdict is exported", typeof remoteVerdict === "function");
checkTrue("hostFingerprint is exported from the metrics server", typeof hostFingerprint === "function");

console.log("\nTHE REFUSAL: >=2 viewers on ONE host is NOT a cross-network result");
{
  // This is the shape of every loopback run in this repo — 4 tabs, 80% offload, real P2P bytes.
  // A check that passes here would have "proven" the milestone 60 iterations ago without a
  // second machine ever existing.
  const loopback = { viewers: 4, p2pBytes: 115e6, httpBytes: 30e6, offloadRatio: 0.79, distinctHosts: 1, loopbackClients: 4 };
  const v = remoteVerdict(loopback);
  check("does NOT pass", v.pass, false);
  check("exits 2 (cannot judge), not 1 (failed) and not 0", v.code, 2);
  checkTrue("says the words 'loopback' and 'LAN URL' so the operator knows WHY",
    /loopback/i.test(v.reason) && /LAN URL/i.test(v.reason));
  checkTrue("reports the viewer count it saw, so the refusal is not mistaken for 'nobody connected'",
    v.viewers === 4);
  checkTrue("the fix names a DIFFERENT MACHINE, not a tab or window",
    /different machine/i.test(v.fix) && /tab|window|profile/i.test(v.fix),
    "an operator who opens a third tab has not fixed anything");
  // 100 viewers on one host is still one host. Nothing about scale converts it into evidence.
  const many = remoteVerdict({ ...loopback, viewers: 100 });
  check("100 viewers on one host is STILL refused", many.code, 2);
}

console.log("\nthe pass case: two hosts, real bytes");
{
  const v = remoteVerdict(CROSS);
  check("passes", v.pass, true);
  check("exits 0", v.code, 0);
  checkTrue("states the host count in the verdict", /2 distinct hosts/.test(v.reason));
  checkTrue("names the byte figure", v.reason.includes("5000000"));
  // A pass must still refuse to be quoted as a saving. The ratio counts peer share of a LARGER
  // total (iter 25/26), so certifying "offload proven" as "bill cut by X" is the standing error.
  checkTrue("carries a caveat that this is NOT the bill reduction",
    (v.caveats || []).some((c) => /bill reduction/i.test(c) && /verify:control/.test(c)),
    "the ratio flatters; only the control subtraction is quotable as a saving");
  checkTrue("flags that some viewers sat on the metrics host itself",
    (v.caveats || []).some((c) => /metrics host/i.test(c)),
    "1 of the 2 viewers was loopback in this fixture");
  // With no loopback clients that caveat must disappear, or it becomes noise that gets ignored.
  const clean = remoteVerdict({ ...CROSS, loopbackClients: 0 });
  checkTrue("...and drops that caveat when no viewer is local",
    !(clean.caveats || []).some((c) => /metrics host/i.test(c)));
  checkTrue("but keeps the bill-reduction caveat unconditionally",
    (clean.caveats || []).some((c) => /bill reduction/i.test(c)));
}

console.log("\ncause-specific diagnoses, one cause at a time");
{
  const none = remoteVerdict({ ...CROSS, viewers: 0, distinctHosts: 0 });
  check("0 viewers -> exit 1", none.code, 1);
  checkTrue("says nobody is reporting", /no viewers/i.test(none.reason));

  const one = remoteVerdict({ ...CROSS, viewers: 1, distinctHosts: 1, p2pBytes: 0 });
  check("1 viewer -> exit 1", one.code, 1);
  checkTrue("explains that a lone peer has nobody to relay with", /nobody to relay/i.test(one.reason));
  checkTrue("...and that 0% is therefore arithmetic, not a measurement",
    /arithmetic/i.test(one.reason),
    "reporting it as a failure would blame the product for a certainty");
  // The 1-viewer case must be distinguishable from the loopback refusal: same low numbers, wholly
  // different fix (open a second viewer vs use a second machine).
  checkTrue("its fix is about the SECOND VIEWER not arriving, not about machines",
    /second machine/i.test(one.fix) && /firewall|METRICS_URL/.test(one.fix));

  const noBytes = remoteVerdict({ ...CROSS, p2pBytes: 0 });
  check("2 hosts but zero P2P bytes -> exit 1", noBytes.code, 1);
  checkTrue("names the host count so the operator knows the hard part already worked",
    /2 hosts/.test(noBytes.reason));
  // THE STANDING RULE from iters 1-10: a 0% report checks PEER CONNECTS first. Six buffer
  // hypotheses are dead in history.md, so this text must not send anyone back to them.
  checkTrue("points at peer connects FIRST", /peer connects/i.test(noBytes.fix));
  checkTrue("and explicitly says NOT buffer settings", /NOT buffer/i.test(noBytes.fix),
    "six buffer/window hypotheses are already dead — the diagnosis must not resurrect them");

  // Every non-pass carries an actionable fix. A verdict that says only "failed" reproduces the
  // eyeball-the-dashboard problem this command exists to remove.
  for (const [label, v] of [["0 viewers", none], ["1 viewer", one], ["no bytes", noBytes]]) {
    checkTrue(`${label} carries a non-empty fix`, typeof v.fix === "string" && v.fix.length > 20);
  }
}

console.log("\nunjudgeable inputs are code 2 — silence must never read as success");
{
  const noStats = remoteVerdict(null);
  check("no /stats response -> exit 2", noStats.code, 2);
  check("...and does not pass", noStats.pass, false);
  checkTrue("tells the operator to start the stack on the ORIGIN machine", /npm start/.test(noStats.fix));

  // THE DANGEROUS CASE: an older metrics server with no host reporting. If a missing field were
  // read as "hosts differ", this would print PASS on the exact setup it exists to reject.
  const old = remoteVerdict({ viewers: 4, p2pBytes: 115e6, offloadRatio: 0.79 });
  check("distinctHosts absent -> exit 2", old.code, 2);
  check("...and does not pass", old.pass, false);
  checkTrue("names distinctHosts as the missing field", /distinctHosts/.test(old.reason));
  const nulled = remoteVerdict({ viewers: 4, p2pBytes: 115e6, distinctHosts: null });
  check("distinctHosts null is treated the same as absent", nulled.code, 2);
  // Garbage must not throw — this runs unattended in a checklist.
  check("a non-object -> exit 2", remoteVerdict("nope").code, 2);
  check("undefined -> exit 2", remoteVerdict(undefined).code, 2);
}

console.log("\nhostFingerprint: it must not leak addresses, and must not split one machine in two");
{
  const salt = Buffer.from("fixed-test-salt");
  const v4 = hostFingerprint("127.0.0.1", salt);
  const mapped = hostFingerprint("::ffff:127.0.0.1", salt);
  // THE BUG THIS PREVENTS: express reports IPv4-mapped IPv6 for a v4 client. If the two spellings
  // hashed differently, one machine reaching the server over both stacks would count as two hosts
  // and fake a cross-network pass.
  check("IPv4-mapped IPv6 hashes the SAME as plain IPv4", mapped.host, v4.host);
  checkTrue("both are recognised as loopback", v4.loopback === true && mapped.loopback === true);
  checkTrue("case is normalised", hostFingerprint("::FFFF:127.0.0.1", salt).host === v4.host);
  check("bracketed form is stripped", hostFingerprint("[::1]", salt).loopback, true);
  check("::1 is loopback", hostFingerprint("::1", salt).loopback, true);
  check("any 127.x is loopback", hostFingerprint("127.10.0.9", salt).loopback, true);

  const lan = hostFingerprint("192.168.1.42", salt);
  check("a LAN address is NOT loopback", lan.loopback, false);
  checkTrue("a different address gives a different hash", lan.host !== v4.host);
  checkTrue("the same address gives a stable hash", hostFingerprint("192.168.1.42", salt).host === lan.host);

  // The hash is what gets published on /stats, which every viewer can read. A raw address there
  // would leak every viewer's IP to all the others.
  checkTrue("the fingerprint does not contain the address", !lan.host.includes("192.168"),
    "/stats is world-readable to the swarm");
  checkTrue("it is a fixed-width hex digest", /^[0-9a-f]{12}$/.test(lan.host));
  // A DIFFERENT salt must give a different hash, or the digest is a lookup table for the whole
  // IPv4 space rather than an anonymisation.
  checkTrue("a different salt gives a different hash for the same address",
    hostFingerprint("192.168.1.42", Buffer.from("other-salt")).host !== lan.host,
    "an unsalted hash of a 32-bit space is an encoding, not anonymisation");

  check("empty input -> null", hostFingerprint(""), null);
  check("non-string -> null", hostFingerprint(undefined), null);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
