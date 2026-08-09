#!/usr/bin/env node
/**
 * twomachine.test.js — the shipped two-machine guide must match the shipped tooling (iter 71).
 *
 * P2P-0059: for 27 iterations the guide told the user to start FOUR services by hand
 * (`npm run origin:loop & npm run nginx & npm run tracker & npm run web &`) even though `npm start`
 * replaced that at iter 27 and prints the LAN banner itself. A checklist that contradicts the
 * tooling it documents is one nobody follows — 33 boxes went unticked for 69 iterations, and the
 * stale four-command form was part of why.
 *
 * The test guards the COMMITTED copy (README's "Running across two machines"), NOT the
 * `.p2p-loop/manual-qa.md` copy, which is gitignored and absent from a fresh clone — a test that
 * read it would go red for everyone who cloned the repo. The one assertion that matters is the
 * NEGATIVE one: the four-command form must never come back. A doc drifting back to superseded
 * instructions is invisible until someone follows them and burns an afternoon.
 *
 * Usage: node test/twomachine.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

// Isolate the section so a stray `origin:loop` mention ELSEWHERE in the README (the npm-scripts
// table legitimately lists it) cannot pass or fail this by accident.
const start = README.indexOf("## Running across two machines");
const rest = README.slice(start + 1);
const end = rest.indexOf("\n## ");
const SECTION = start === -1 ? "" : README.slice(start, end === -1 ? undefined : start + 1 + end);

console.log("the two-machine section exists and is bounded");
checkTrue("README has a 'Running across two machines' section", start !== -1);
checkTrue("...and it is non-trivial", SECTION.length > 200);

console.log("\nit uses the ONE command we ship, not the four-service dance");
{
  checkTrue("tells the user to run `npm start`", /\bnpm start\b/.test(SECTION));
  // THE REGRESSION GUARD. Any of the four backgrounded services being started by hand means the
  // guide has drifted back to the pre-iter-27 form. `&` included so a plain mention of the script
  // name (without launching it) does not trip this.
  const dance = [
    /npm run origin:loop\s*&/,
    /npm run nginx\s*&/,
    /npm run tracker\s*&/,
    /npm run web\s*&/,
  ];
  for (const re of dance) {
    checkTrue(`does NOT contain the superseded form ${re}`, !re.test(SECTION),
      "npm start replaced the four-command dance at iter 27");
  }
  // A tighter statement of the same thing: the exact four-in-a-row chain must be gone.
  checkTrue("the full four-command chain is absent",
    !/origin:loop[\s\S]{0,120}nginx[\s\S]{0,120}tracker[\s\S]{0,120}web\s*&/.test(SECTION));
}

console.log("\nit quotes the real banner start.sh prints, so the user recognises it");
{
  // These strings are emitted verbatim by start.sh. If the banner text there changes, this fails
  // and forces the doc to be updated with it — the doc and the tool cannot silently diverge.
  const START_SH = readFileSync(path.join(ROOT, "start.sh"), "utf8");
  const bannerLine = "ACROSS TWO MACHINES — use this address on EVERY viewer, including this one:";
  checkTrue("start.sh actually prints that banner", START_SH.includes(bannerLine),
    "if this fails, the doc is quoting a banner the tool no longer prints");
  checkTrue("the README quotes the same banner line verbatim", SECTION.includes(bannerLine));
  checkTrue("the README shows both the Viewer and Dashboard lines the banner prints",
    /Viewer\s+http:\/\//.test(SECTION) && /Dashboard\s+http:\/\//.test(SECTION));
}

console.log("\nthe five eyeball boxes are gone — one verify:remote invocation replaces them");
{
  checkTrue("directs the user to `npm run verify:remote`", /npm run verify:remote/.test(SECTION));
  checkTrue("passes STATS_URL so the verdict reads the RIGHT server", /STATS_URL=/.test(SECTION));
  // The whole point of iter 70 is that the user is TOLD the answer. The section must explain the
  // exit codes, not ask the user to interpret dashboard numbers themselves.
  checkTrue("explains what exit 0 means (proven)", /proven/i.test(SECTION));
  checkTrue("explains that a one-host run is refused, not passed",
    /refus/i.test(SECTION) || /one host|single host|same host|distinct host/i.test(SECTION),
    "a loopback run wearing a LAN URL must be called out as NOT a pass");
  // And it must NOT send the user back to eyeballing the dashboard as the verdict. A mention of
  // the dashboard is fine; instructing them to READ OFF a pass/fail from it is the old failure.
  checkTrue("does not tell the user to decide pass/fail by reading dashboard numbers",
    !/dashboard[^.]{0,60}(shows|reads)[^.]{0,40}offload\s*>\s*0/i.test(SECTION),
    "interpreting five numbers by eye is exactly what verify:remote removed");
}

console.log("\nthe same-hostname rule survives (it is the #1 zero-peers cause)");
{
  checkTrue("still warns never to mix localhost with the LAN IP",
    /localhost/i.test(SECTION) && /swarm/i.test(SECTION),
    "mixed hostnames put viewers in different swarms: 0 peers, no error");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
