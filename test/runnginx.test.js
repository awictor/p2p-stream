#!/usr/bin/env node
/**
 * runnginx.test.js — origin/run-nginx.sh, the last file in the repo with zero coverage (iter 68).
 *
 * 524 bytes, invoked by `npm run nginx` and by `start.sh`, and it decides two things that fail in
 * ways nobody would attribute to it:
 *
 *   1. THE PREFIX/CONF PAIR. `nginx -p` sets the prefix that EVERY relative path in nginx.conf
 *      resolves against — `logs/egress.log`, `temp/client`, `alias hls/`. Probed live this fire:
 *      - `-p origin -c origin/nginx.conf` → `CreateFile() "origin/origin/nginx.conf" failed (3)`,
 *        which reads like a missing file rather than a doubled prefix (iter 63 hit exactly this).
 *      - an ABSOLUTE `-c` with the WRONG `-p` parses the conf fine and then dies on
 *        `could not open error log file: CreateFile() "./logs/error.log" failed (3)`.
 *      So the conf path and the prefix are independent, and BOTH have to be right.
 *
 *   2. WHICH BINARY RUNS. `bin/` is gitignored, so a fresh clone has no vendored nginx and must
 *      fall back to PATH. If the fallback breaks, the failure is "nginx: not found" on someone
 *      else's machine only.
 *
 * It also has to create `logs/`, `temp/` and `hls/` BEFORE exec — nginx does not create them, and
 * the alert above is what an operator sees if they are missing.
 *
 * `check-configs.mjs` launches nginx too (`-p origin -c nginx.conf`, relative). The two spellings
 * differ legitimately — absolute is prefix-independent, relative resolves under `-p` — so what is
 * asserted is that **both resolve to the same file**, not that the strings match.
 *
 * Usage: node test/runnginx.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SH_PATH = path.join(ROOT, "origin", "run-nginx.sh");
const CHECK_PATH = path.join(ROOT, "scripts", "check-configs.mjs");

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

const RAW = readFileSync(SH_PATH, "utf8");
// Strip comments before asserting on commands. The script's comments explain the prefix mechanism
// and name paths, so a naive substring test matches prose. Sixth instance of this trap in this
// repo — assume explanatory text contains the value being searched for.
const SH = RAW.split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n");

console.log("run-nginx.sh — the prefix/conf pair, which fails in ways nobody attributes to it");
{
  checkTrue("the script exists", existsSync(SH_PATH));
  // -p must be the ORIGIN dir, because nginx.conf's logs/, temp/ and hls/ are relative to it.
  // A wrong prefix parses the conf and THEN dies on ./logs/error.log — verified live.
  checkTrue("passes -p with the origin dir", /-p\s+"\$ORIGIN"/.test(SH),
    "nginx.conf's logs/, temp/ and alias hls/ all resolve against the prefix");
  checkTrue("passes -c with a conf path", /-c\s+"\$ORIGIN\/nginx\.conf"/.test(SH),
    "an absolute -c is prefix-independent; a relative one must sit UNDER -p");
  // ORIGIN itself has to be derived from the script's own location, not from cwd, or
  // `npm run nginx` from a subdirectory launches with the wrong prefix.
  checkTrue("ORIGIN is derived from the script's own path, not cwd",
    /ROOT="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/.test(SH) && /ORIGIN="\$ROOT\/origin"/.test(SH),
    "a cwd-relative prefix breaks when invoked from anywhere else");
  // The directories nginx will not create for itself.
  for (const d of ["logs", "temp", "hls"]) {
    checkTrue(`creates ${d}/ before launching`, new RegExp(`mkdir -p[^\\n]*\\$ORIGIN/${d}`).test(SH),
      "nginx does not create these; a missing logs/ is an alert on stderr and no server");
  }
  const mkdirIdx = SH.indexOf("mkdir -p");
  const execIdx = SH.indexOf("exec ");
  checkTrue("...and does so BEFORE exec", mkdirIdx !== -1 && execIdx !== -1 && mkdirIdx < execIdx,
    "after exec is never");
}

console.log("\nbinary selection: bin/ is gitignored, so PATH fallback is the fresh-clone path");
{
  checkTrue("prefers the vendored binary", /NGINX="\$\{NGINX:-\$ROOT\/bin\/nginx-1\.27\.4\/nginx\.exe\}"/.test(SH));
  // The fallback is what runs on any machine that did not download bin/ — which is every fresh
  // clone, since bin/ is gitignored.
  checkTrue("falls back to PATH when it is absent or not executable",
    /\[ -x "\$NGINX" \] \|\| NGINX="nginx"/.test(SH),
    "bin/ is gitignored, so a fresh clone has no vendored nginx");
  checkTrue("NGINX is overridable from the environment", /\$\{NGINX:-/.test(SH),
    "an operator with nginx elsewhere should not have to edit the script");
  checkTrue("uses exec so the container/shell gets nginx's own exit code", /^exec /m.test(SH),
    "without exec, start.sh's kill targets the wrapper and nginx survives");
}

console.log("\nit must agree with check-configs.mjs about WHICH conf and WHICH prefix");
{
  // The two use different spellings on purpose: run-nginx.sh passes an absolute -c (prefix-
  // independent), check-configs.mjs passes a relative one (resolved under -p). Asserting the
  // strings matched would forbid a legitimate difference, so assert they RESOLVE the same.
  const CHECK = readFileSync(CHECK_PATH, "utf8");
  const m = CHECK.match(/"-p",\s*"([^"]+)",\s*"-c",\s*"([^"]+)"/);
  checkTrue("check-configs passes an explicit -p and -c", !!m);
  if (m) {
    const [, checkPrefix, checkConf] = m;
    // check-configs runs with cwd = ROOT, so its prefix is ROOT-relative.
    const checkResolved = path.resolve(ROOT, checkPrefix, checkConf);
    // run-nginx.sh's absolute form resolves to ORIGIN/nginx.conf regardless of cwd.
    const shResolved = path.resolve(ROOT, "origin", "nginx.conf");
    check("both resolve to the SAME conf file", checkResolved, shResolved);
    check("and check-configs' prefix is the origin dir",
      path.resolve(ROOT, checkPrefix), path.resolve(ROOT, "origin"));
  }
  // THE BUG iter 63 hit: a relative -c that repeats the prefix. Neither file may contain it.
  checkTrue("neither file uses the doubled form `-c origin/nginx.conf` with `-p origin`",
    !/-p\s+"?origin"?\s+-c\s+"?origin\//.test(SH) && !/"-p",\s*"origin",\s*"-c",\s*"origin\//.test(CHECK),
    'that yields CreateFile() "origin/origin/nginx.conf" failed (3), which reads like a missing file');
}

console.log("\nthe shipped command ACTUALLY works (run it, do not just read it)");
{
  // Reading the script proves the strings; running nginx proves the pair. Use -t so nothing binds
  // a port — this is a config test, not a server launch.
  const vendored = path.join(ROOT, "bin", "nginx-1.27.4", "nginx.exe");
  const bin = existsSync(vendored) ? vendored : "nginx";
  const origin = path.join(ROOT, "origin");
  const run = (args) => {
    try {
      const out = execFileSync(bin, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: ((e.stderr || "") + (e.stdout || "")).trim() };
    }
  };
  const probe = run(["-v"]);
  if (probe.code !== 0 && /ENOENT/.test(String(probe.out))) {
    console.log("  SKIP  live nginx checks — no nginx binary (bin/ absent and none on PATH)");
  } else {
    // The exact pair run-nginx.sh execs.
    const ok = run(["-t", "-p", origin, "-c", path.join(origin, "nginx.conf")]);
    check("the shipped -p/-c pair passes nginx -t", ok.code, 0);

    // A WRONG prefix with the same absolute conf: parses, then cannot open its own log. This is
    // why -p is asserted separately from -c rather than treated as one setting.
    const badPrefix = run(["-t", "-p", ROOT, "-c", path.join(origin, "nginx.conf")]);
    checkTrue("a WRONG -p fails even though the conf path is right", badPrefix.code !== 0,
      "nginx.conf's logs/ and temp/ are prefix-relative, so -p is load-bearing on its own");
    checkTrue("...and the error names the log path, not the conf",
      /logs[\\/]error\.log|logs\/error\.log/.test(badPrefix.out),
      `the failure is about the prefix; got: ${badPrefix.out.split("\n")[0]}`);

    // The doubled-prefix mistake, run for real so the recorded error text stays accurate.
    const doubled = run(["-t", "-p", "origin", "-c", "origin/nginx.conf"]);
    checkTrue("the doubled relative form really does fail", doubled.code !== 0);
    checkTrue("...with a path that shows the prefix twice", /origin[\\/]origin[\\/]nginx\.conf/.test(doubled.out),
      `expected origin/origin/nginx.conf in: ${doubled.out.split("\n")[0]}`);
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
