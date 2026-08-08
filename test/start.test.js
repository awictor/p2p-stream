#!/usr/bin/env node
/**
 * start.test.js — unit test for start.sh's readiness logic.
 *
 * `start.sh` is the first thing a new adopter runs, and it shipped with no coverage at all
 * despite its probe logic having already produced three separate defects (a libuv exit-127
 * false negative, a too-short origin timeout, a double teardown). Its whole job is to REFUSE
 * to say READY until the stack really is — so the failure mode that matters is printing READY
 * when it should not, which is exactly what a human running it once would not notice.
 *
 * Two things are asserted, both against the REAL script text / REAL probe file so they cannot
 * drift from what bash executes:
 *   1. The probe emits exactly ONE integer in `frags` mode. It prints 0 AND exits non-zero on
 *      failure, so a caller writing `$(node probe ... || echo 0)` gets "0\n0" and bash then
 *      dies with "integer expression expected".
 *   2. The fragment-wait loop must not fall through to READY when it times out.
 *
 * Usage: node test/start.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = readFileSync(path.join(ROOT, "start.sh"), "utf8");

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

// Extract the heredoc'd probe script out of start.sh and run it for real. Same trick as
// config.test.js/dashboard.test.js: test the shipped text, not a reimplementation of it.
function extractProbe() {
  const m = SRC.match(/cat > "\$PROBE" <<'PROBEJS'\n([\s\S]*?)\nPROBEJS/);
  if (!m) throw new Error("could not find the PROBEJS heredoc in start.sh");
  return m[1];
}

console.log("start.sh — the probe script extracted from the real heredoc:");
const probeSrc = extractProbe();
const probePath = path.join(ROOT, ".probe.test.mjs");
writeFileSync(probePath, probeSrc);

try {
  checkTrue("heredoc found and non-empty", probeSrc.length > 50);
  // The libuv trap that made a successful fetch report exit 127. Guard the fix, not the bug.
  // Match CODE only. `process.exit(` also appears inside `process.exitCode` and inside the
  // comment that explains the trap, so strip comments and the exitCode identifier first —
  // otherwise the guard fails on correct code (it did, twice) and would pass on nothing.
  const probeCode = probeSrc
    .replace(/\/\/[^\n]*/g, "")          // line comments (they name process.exit() on purpose)
    .replace(/process\.exitCode/g, "");
  checkTrue("probe never calls process.exit() (libuv exit-127 trap)",
    !/process\.exit\s*\(/.test(probeCode),
    "process.exit() with an open fetch handle exits 127 AFTER success");
  checkTrue("probe sets process.exitCode instead", /process\.exitCode\s*=/.test(probeSrc));

  // Port 9 (discard) is reserved and never serves HTTP, so this is a reliable "down" target
  // without needing to bind anything.
  const DEAD = "http://127.0.0.1:9/nope";

  const run = (args) => {
    try {
      const out = execFileSync(process.execPath, [probePath, ...args], { encoding: "utf8" });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: e.stdout || "" };
    }
  };

  console.log("\nstatus mode: exit code reflects reachability");
  {
    const r = run([DEAD]);
    check("unreachable URL exits 1", r.code, 1);
    check("and prints nothing", r.out.trim(), "");
  }

  console.log("\nfrags mode: must emit exactly ONE integer, even on failure");
  {
    const r = run([DEAD, "frags"]);
    // THE BUG: printing 0 *and* exiting non-zero makes the caller's `|| echo 0` append a
    // second 0, so bash sees "0\n0" and dies with "[: 0 0: integer expression expected".
    // Whichever way it is fixed (exit 0, or don't print), the caller must get one integer.
    const lines = r.out.trim().split(/\r?\n/).filter((s) => s.length);
    check("prints exactly one line", lines.length, 1);
    check("that line is 0", lines[0], "0");
    checkTrue("a shell `$(probe || echo 0)` yields ONE integer",
      !(r.code !== 0 && lines.length === 1 && lines[0] === "0"),
      "prints 0 AND exits non-zero, so `|| echo 0` doubles it");
  }

  console.log("\nreadiness must not fall through to READY on timeout");
  {
    // The fragment wait is a bounded for-loop. If it exhausts its tries, control must NOT
    // reach the READY banner — that would print exactly the lie the script exists to avoid.
    const loop = SRC.match(/for \(\(i = 0; i < READY_TIMEOUT[\s\S]*?\ndone/);
    checkTrue("fragment-wait loop found", !!loop);
    const afterLoop = loop ? SRC.slice(SRC.indexOf(loop[0]) + loop[0].length) : "";
    const readyIdx = afterLoop.indexOf("READY");
    const between = readyIdx === -1 ? "" : afterLoop.slice(0, readyIdx);
    // Something between the loop end and the banner has to detect "never got there":
    // a guard on the counter/flag that exits, or an explicit failure branch.
    checkTrue("timeout is detected before READY is printed",
      /exit 1|FAILED|ready=0|\$ready|timed out/i.test(between),
      "loop just ends and READY prints unconditionally");
  }

  console.log("\ntunables are declared and sane");
  {
    const minFrags = Number((SRC.match(/^MIN_FRAGS=(\d+)/m) || [])[1]);
    const timeout = Number((SRC.match(/^READY_TIMEOUT=(\d+)/m) || [])[1]);
    checkTrue("MIN_FRAGS >= 20 (below this the harness measures noise)", minFrags >= 20);
    // Live mode needs ~90s before the playlist even appears, plus 20 fragments x ~2s.
    checkTrue("READY_TIMEOUT leaves room for a live fill (>=180)", timeout >= 180);
    checkTrue("origin wait allows for ffmpeg's ~90s buffering",
      /wait_http "http:\/\/localhost:8080[^\n]*"\s+(1[2-9]\d|[2-9]\d\d)/.test(SRC),
      "origin probe tries too few times; 60 was measured as too short");
  }

  console.log("\nteardown");
  {
    checkTrue("cleanup is guarded against running twice",
      /cleaned=1/.test(SRC) && /\[ "\$cleaned" -eq 1 \] && return/.test(SRC),
      "INT and EXIT both fire on Ctrl-C");
    checkTrue("nginx is stopped explicitly (it daemonises off our pid tree)",
      /-s stop/.test(SRC));
    checkTrue("the runtime probe file is removed on exit", /rm -f "\$ROOT\/\.probe\.mjs"/.test(SRC));
  }
  console.log("\ntwo-machine banner: the launcher must advertise the LAN address (iter 45)");
  {
    // The localhost block is correct for one box and WRONG across machines: the swarm id includes
    // hash(streamUrl), so a localhost viewer and a LAN-IP viewer land in DIFFERENT swarms and sit
    // at 0 peers with NO error. Following the banner as printed was therefore the fastest route to
    // a silent failure, which is exactly the kind of thing a stranger hits first.
    checkTrue("detects a LAN address", /networkInterfaces/.test(SRC) && /LAN=\$\(node -e/.test(SRC));
    checkTrue("skips internal interfaces (loopback is useless to a second machine)",
      /!x\.internal/.test(SRC));
    checkTrue("prints the viewer URL on that address", /http:\/\/\$LAN:5173/.test(SRC));
    checkTrue("prints the dashboard URL too", /http:\/\/\$LAN:8001/.test(SRC));
    checkTrue("states the do-NOT-mix rule, since mixing fails silently",
      /Do NOT mix localhost/.test(SRC),
      "the failure mode is 0 peers with no error, so the warning has to be explicit");
    checkTrue("mentions the firewall prompt that otherwise filters every port",
      /Firewall/i.test(SRC));
    // A machine with no non-internal IPv4 must say so rather than printing `http://:5173`.
    checkTrue("handles having no LAN address instead of emitting a broken URL",
      /no non-internal IPv4 found/.test(SRC),
      "an empty $LAN would render http://:5173");
    checkTrue("and guards it with a non-empty test", /if \[ -n "\$LAN" \]/.test(SRC));
  }
} finally {
  try { unlinkSync(probePath); } catch { /* already gone */ }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
