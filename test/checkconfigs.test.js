#!/usr/bin/env node
/**
 * checkconfigs.test.js — the config gate must not silently stop gating (iter 64).
 *
 * `scripts/check-configs.mjs` became the FIRST thing `npm test` runs at iter 63, and it had no
 * coverage of its own. Its failure mode is the worst available for a gate: **a check that stops
 * running still exits 0 and prints PASS.** Verified by deleting the nginx block — the script
 * happily reported "PASS: 0 broken config(s), 4 check(s) passed" and exited 0. Nothing anywhere
 * would have noticed that `origin/nginx.conf` had stopped being validated.
 *
 * So this asserts the gate's own COMPLETENESS, not just its behaviour on good input:
 *   - Every config the repo ships is named in the script. A new config that nobody wired in is
 *     the same silent hole.
 *   - The expected number of checks actually ran.
 *   - A FAIL is reachable per config, and SKIP is a distinct third state (a skip must never be
 *     counted as a pass — see iter 63).
 *
 * It runs the REAL script as a subprocess against REAL files, then again against deliberately
 * broken copies in a temp dir, because a gate asserted only on the happy path is decoration.
 *
 * Usage: node test/checkconfigs.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-configs.mjs");
const SRC = readFileSync(SCRIPT, "utf8");

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

// Run the real script in a given working directory. Never throws: a non-zero exit is the
// interesting case, so it is returned rather than propagated.
// IMPORTANT: check-configs.mjs derives its ROOT from its OWN file location
// (`path.dirname(import.meta.url) + "/.."`), NOT from cwd. So pointing it at a temp tree means
// running the COPY inside that tree — passing a different cwd does nothing at all. That mistake
// made every broken-input case below silently re-check the real repo and "pass".
function run(dir = ROOT) {
  const script = path.join(dir, "scripts", "check-configs.mjs");
  try {
    const out = execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

console.log("the gate passes on the REAL repo, and reports what it checked");
const live = run();
{
  check("exits 0 on the real configs", live.code, 0);
  // Every config this repo ships must be NAMED in the output. This is the completeness assertion:
  // a config nobody wired in is invisible, and so is a check that was deleted.
  for (const cfg of ["docker-compose.yml", "origin/nginx.conf", "deploy/Caddyfile"]) {
    checkTrue(`${cfg} appears in the report`, live.out.includes(cfg),
      "an unmentioned config is one nobody is checking");
  }
  // Count the state lines. Deleting a check drops this number while the script still exits 0 —
  // which is exactly what happened when the nginx block was removed as an experiment.
  const states = (live.out.match(/^\s{2}(PASS|FAIL|SKIP)\s/gm) || []).length;
  check("exactly 6 checks ran (5 pass + 1 skip)", states, 6);
  checkTrue("the summary counts them", /\d+ check\(s\) passed/.test(live.out));
}

console.log("\nSKIP is a THIRD state and must never read as a pass");
{
  // The Caddyfile cannot be parsed without a caddy binary (`caddy validate` is the only parser),
  // so it legitimately skips here. What must never happen is a skip being silently folded into
  // the pass count or omitted from the summary.
  checkTrue("the Caddyfile is SKIP, not PASS", /SKIP\s+deploy\/Caddyfile/.test(live.out),
    "no caddy binary exists here, so a PASS would be a lie");
  checkTrue("skips get their own loud summary line", /NOT verified \(skipped\)/.test(live.out),
    "a green run must not read as 'everything verified'");
  checkTrue("the skip states WHY", /no caddy binary/.test(live.out));
  // A skip is not a failure, so the exit code stays 0 — but the two must be distinguishable in
  // the output, or the operator cannot tell verified from unverified.
  check("a skip does not fail the gate", live.code, 0);
}

console.log("\nevery config has a REACHABLE failure — broken input must exit 1");
{
  // Work on a COPY so the real repo is never left broken by a crashed test run. Only the files
  // the script reads are copied; node_modules is resolved from the parent, which works because
  // node walks upward looking for it.
  const tmp = path.join(ROOT, ".checkcfg-tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  mkdirSync(path.join(tmp, "origin"), { recursive: true });
  mkdirSync(path.join(tmp, "deploy"), { recursive: true });
  try {
    cpSync(SCRIPT, path.join(tmp, "scripts", "check-configs.mjs"));
    cpSync(path.join(ROOT, "origin", "nginx.conf"), path.join(tmp, "origin", "nginx.conf"));
    cpSync(path.join(ROOT, "deploy", "Caddyfile"), path.join(tmp, "deploy", "Caddyfile"));
    cpSync(path.join(ROOT, "docker-compose.yml"), path.join(tmp, "docker-compose.yml"));
    // nginx -t writes logs and temp dirs under its prefix; without these it fails for the wrong
    // reason and the test would "pass" on an unrelated error.
    mkdirSync(path.join(tmp, "origin", "logs"), { recursive: true });
    mkdirSync(path.join(tmp, "origin", "temp"), { recursive: true });
    // The script prefers `bin/nginx-1.27.4/nginx.exe` relative to ITS OWN root, so the temp tree
    // needs a copy or the nginx check SKIPs — and skipping the strongest check in here would make
    // this test weaker than it looks. nginx.exe is ~4MB and copies in well under a second.
    // (`bin/` is gitignored, so on a fresh clone it is absent and the check legitimately skips;
    // that branch is detected below and printed rather than silently counted as a pass.)
    const realNginx = path.join(ROOT, "bin", "nginx-1.27.4", "nginx.exe");
    if (existsSync(realNginx)) {
      mkdirSync(path.join(tmp, "bin", "nginx-1.27.4"), { recursive: true });
      cpSync(realNginx, path.join(tmp, "bin", "nginx-1.27.4", "nginx.exe"));
      // nginx resolves its own `conf/` and `mime.types` relative to the prefix we pass (-p origin),
      // and origin/nginx.conf declares no `include`, so no support files are needed.
    }
    const baseline = run(tmp);
    const nginxAvailable = !/SKIP\s+origin\/nginx\.conf/.test(baseline.out);

    // 1. Malformed YAML must fail. This is the check the hand-rolled reader could not do.
    // My first fixture here — `services:\n  a:\n   image: x` — was NOT invalid: odd indentation
    // still parses cleanly to {services:{a:{image:"x"}}}, so the assertion tested nothing and
    // reported the script as broken when the FIXTURE was wrong. A tab IS rejected ("Tabs are not
    // allowed as indentation at line 2"). Verify a fixture is actually invalid before blaming code.
    writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n\ta:\n\t\timage: x\n");
    let r = run(tmp);
    check("malformed YAML exits 1", r.code, 1);
    checkTrue("...and says it is a parse error", /parses as YAML/.test(r.out) && /FAIL/.test(r.out));
    // A real parser reports position; that is the whole reason for the dependency.
    checkTrue("...with a line number", /line \d+/.test(r.out),
      "position is what a real parse buys over a regex");

    // 2. A bare port must fail. Legal compose, but it assigns a RANDOM host port and silently
    //    breaks every URL the viewer derives from the page host.
    cpSync(path.join(ROOT, "docker-compose.yml"), path.join(tmp, "docker-compose.yml"));
    const compose = readFileSync(path.join(tmp, "docker-compose.yml"), "utf8");
    writeFileSync(path.join(tmp, "docker-compose.yml"), compose.replace('"8080:8080"', '"8080"'));
    r = run(tmp);
    check("a bare port exits 1", r.code, 1);
    checkTrue("...named as host:container", /host:container/.test(r.out));

    // 3. An undeclared named volume must fail — compose would treat it as a relative host path,
    //    so ffmpeg and nginx would silently stop sharing the segment directory.
    writeFileSync(path.join(tmp, "docker-compose.yml"),
      compose.replace(/^volumes:\r?\n(  \w[^\n]*\r?\n)+/m, "volumes:\n  origin-logs:\n  origin-temp:\n"));
    r = run(tmp);
    check("an undeclared volume exits 1", r.code, 1);
    checkTrue("...naming the volume", /hls/.test(r.out));

    // 4. A broken nginx.conf must fail — only meaningful if nginx is actually reachable.
    cpSync(path.join(ROOT, "docker-compose.yml"), path.join(tmp, "docker-compose.yml"));
    if (!nginxAvailable) {
      console.log("  SKIP  broken nginx.conf — no nginx binary reachable from the temp dir");
    } else {
      const conf = readFileSync(path.join(tmp, "origin", "nginx.conf"), "utf8");
      writeFileSync(path.join(tmp, "origin", "nginx.conf"), conf.replace("sendfile      off;", "sendfile      off"));
      r = run(tmp);
      check("a broken nginx.conf exits 1", r.code, 1);
      checkTrue("...with nginx's own error text", /nginx:/.test(r.out) && /sendfile/.test(r.out),
        "quoting the server's message beats inventing one");
    }

    // 5. A MISSING config must fail, not skip. Absent is not the same as uncheckable.
    cpSync(path.join(ROOT, "origin", "nginx.conf"), path.join(tmp, "origin", "nginx.conf"));
    rmSync(path.join(tmp, "docker-compose.yml"));
    r = run(tmp);
    check("a missing compose file exits 1", r.code, 1);
    checkTrue("...reported as missing", /missing/.test(r.out),
      "a deleted config must not silently become a skip");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nthe script's own structure: a deleted check must be detectable");
{
  // THE BUG THIS FILE EXISTS FOR. Deleting a whole check block leaves the script exiting 0 with a
  // cheerful PASS — verified by experiment at iter 64. The count assertion above is the real
  // guard; these pin the pieces it depends on so the count cannot be quietly satisfied.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  for (const cfg of ["docker-compose.yml", "nginx.conf", "Caddyfile"]) {
    checkTrue(`the script names ${cfg}`, code.includes(cfg),
      "a config the script never mentions is a config nobody checks");
  }
  checkTrue("exit code is driven by the FAIL count",
    /process\.exitCode\s*=\s*failed\.length === 0 \? 0 : 1/.test(code),
    "anything else lets a broken config through");
  checkTrue("skips are counted separately from passes",
    /state === "SKIP"/.test(code) && /state === "PASS"/.test(code));
  // nginx's -c is relative to -p; getting this wrong looks like a missing file (CreateFile 3).
  checkTrue("nginx is invoked as -p origin -c nginx.conf",
    /"-p",\s*"origin",\s*"-c",\s*"nginx\.conf"/.test(code),
    "`-c origin/nginx.conf` with `-p origin` resolves to origin/origin/nginx.conf");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
