#!/usr/bin/env node
/**
 * deploy.test.js — routing invariants of deploy/Caddyfile (P2P-0050).
 *
 * This cannot prove the Caddyfile parses — there is no caddy binary in this environment, and
 * `caddy validate` is an unchecked box in manual-qa.md. What it CAN do is pin the mistakes that
 * fail SILENTLY, which are the ones worth a test:
 *
 *   - A missing or mis-prefixed `/tracker` route presents as "peers never connect". No HTTP
 *     error, no console message; offload just reads 0% and looks like a broken product.
 *   - Stripping `/hls/` would 404 every segment, because nginx serves `location /hls/`.
 *   - NOT stripping `/dashboard` would 404, because that page is Express's `/` handler.
 *   - A hardcoded hostname would work for whoever committed it and nobody else.
 *   - A credential in a world-readable repo is the one mistake that cannot be undone.
 *
 * `handle` vs `handle_path` is the whole game here: `handle_path` STRIPS the matched prefix,
 * `handle` preserves it. Each backend wants one or the other, and getting it backwards produces
 * a 404 or a dead swarm rather than a parse error.
 *
 * Usage: node test/deploy.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CADDY_PATH = path.join(ROOT, "deploy", "Caddyfile");
const DEPLOY_DOC = path.join(ROOT, "deploy", "README.md");

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

const RAW = readFileSync(CADDY_PATH, "utf8");
// Strip comments before asserting on directives. Every design decision here is EXPLAINED in a
// comment that names the rejected alternative ("the obvious alternative is to terminate TLS
// port-for-port", "a manual Connection/Upgrade header block ... would break"), so a naive
// substring test would match the prose and pass on a broken config. Third time this trap has
// come up in this repo (start.sh's process.exit guard, nginx.conf's sendfile).
const CONF = RAW.split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n");

/**
 * Which directive block proxies a given backend port, and whether that block strips the prefix.
 * Returns { blocks: [{ matcher, strips }] } so a route can be asserted on BOTH counts.
 */
function routesTo(port) {
  const blocks = [];
  const re = /handle(_path)?\s+([^\s{]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(CONF)) !== null) {
    if (m[3].includes(`127.0.0.1:${port}`)) {
      blocks.push({ matcher: m[2] || "", strips: m[1] === "_path" });
    }
  }
  // The bare `handle { ... }` fallback has no matcher and is matched by the same regex with an
  // empty matcher group, which is what we want for the viewer route.
  return blocks;
}

console.log("deploy/Caddyfile — every backend is reachable exactly once");
{
  checkTrue("the file exists", existsSync(CADDY_PATH));
  // All four services the viewer talks to. A missing one is a service nobody can reach over TLS.
  for (const [name, port] of [["viewer", 5173], ["origin", 8080], ["tracker", 8000], ["metrics", 8001]]) {
    const b = routesTo(port);
    checkTrue(`${name} (:${port}) is proxied`, b.length >= 1,
      "an unproxied backend is unreachable over https");
  }
  // Exactly one route per backend, EXCEPT metrics which legitimately serves three paths
  // (/metrics, /stats, /dashboard) — asserted explicitly rather than waved past.
  check("viewer has one route", routesTo(5173).length, 1);
  check("origin has one route", routesTo(8080).length, 1);
  check("tracker has one route", routesTo(8000).length, 1);
  check("metrics has three (/metrics, /stats, /dashboard)", routesTo(8001).length, 3);
}

console.log("\nprefix handling: handle_path STRIPS, handle PRESERVES — backwards is a 404");
{
  // nginx serves `location /hls/`, so the prefix MUST survive. Stripping it 404s every segment,
  // which reads as "the origin is broken" rather than "the proxy is misconfigured".
  const hls = routesTo(8080)[0];
  checkTrue("/hls/ route exists with an /hls matcher", !!hls && hls.matcher.startsWith("/hls"));
  check("...and does NOT strip the prefix (nginx expects /hls/)", hls ? hls.strips : null, false);

  // The tracker listens at the ROOT of :8000, so /tracker must be removed. THE SILENT ONE:
  // getting this wrong yields no HTTP error, just a swarm where nobody ever connects.
  const tracker = routesTo(8000)[0];
  checkTrue("/tracker route exists", !!tracker && tracker.matcher.startsWith("/tracker"));
  check("...and DOES strip the prefix (tracker is at the backend root)", tracker ? tracker.strips : null, true);

  // Express routes are literally POST /metrics and GET /stats, so those pass through unchanged.
  const metricsBlocks = routesTo(8001);
  const kept = metricsBlocks.filter((b) => !b.strips).map((b) => b.matcher).sort();
  const stripped = metricsBlocks.filter((b) => b.strips).map((b) => b.matcher).sort();
  check("/metrics and /stats keep their prefix", kept.join(","), "/metrics*,/stats*");
  check("/dashboard strips it (it is Express's GET /)", stripped.join(","), "/dashboard*");

  // The viewer is the catch-all and must be the bare `handle` with no matcher — a matcher here
  // would leave every other path unrouted.
  const viewer = routesTo(5173)[0];
  check("viewer is the catch-all with no matcher", viewer ? viewer.matcher : "MISSING", "");
}

console.log("\nwebsockets: the tracker route is the one that fails without an error");
{
  // Caddy upgrades websockets automatically, and a MANUAL Connection/Upgrade header block would
  // break plain HTTP to the same path. So the assertion is the inverse of the usual one: the
  // config must NOT hand-roll the handshake.
  checkTrue("no hand-rolled Connection/Upgrade headers",
    !/header_up\s+Connection/i.test(CONF) && !/header_up\s+Upgrade/i.test(CONF),
    "Caddy does the upgrade itself; a manual block breaks non-ws requests to the same path");
  // The comment must say WHY, because the absence of a thing is invisible to the next reader.
  checkTrue("and the file explains that Caddy handles the upgrade",
    /[Uu]pgrade/.test(RAW) && /automatic/i.test(RAW),
    "an absent header block looks like an omission unless it says otherwise");
}

console.log("\nno secrets, no hardcoded host (this repo is PUBLIC)");
{
  checkTrue("hostname comes from an env placeholder", /\{\$P2P_HOST\}/.test(CONF),
    "a hardcoded host works for whoever committed it and nobody else");
  // Look for anything credential-shaped. This is the one mistake that cannot be walked back
  // once pushed to a public repo.
  checkTrue("no basicauth hash", !/basic_?auth/i.test(CONF));
  checkTrue("no email address (Caddy ACME account)", !/[\w.]+@[\w.]+\.\w+/.test(CONF));
  checkTrue("no inline TLS key or cert path outside the repo root",
    !/tls\s+[^\s{]+\s+[^\s{]+/.test(CONF),
    "an inline `tls cert key` pair means someone put files somewhere unmanaged");
  checkTrue("no token/secret/password literals",
    !/(secret|password|passwd|api[_-]?key|token)\s*[:=]/i.test(CONF));
  // A real hostname committed by accident is the likeliest slip, since the docs show examples.
  checkTrue("no real-looking hostname in the CONFIG (examples belong in the docs)",
    !/\b(?!example\.com)[a-z0-9-]+\.(com|net|io|dev|tv)\b/.test(CONF),
    "example.com is fine; a live host is a leak of someone's infrastructure");
}

console.log("\ndeploy/README.md documents what the config cannot enforce");
{
  checkTrue("the doc exists", existsSync(DEPLOY_DOC));
  const doc = readFileSync(DEPLOY_DOC, "utf8");
  checkTrue("gives the P2P_HOST run command", /P2P_HOST=\S+\s+caddy run/.test(doc));
  // The viewer's DEFAULT derived URLs are wrong under path routing. If the doc omits the
  // override URL, a deployer follows the instructions exactly and gets a broken viewer.
  checkTrue("gives the viewer URL with all three overrides",
    /\?origin=/.test(doc) && /tracker=wss:/.test(doc) && /metrics=https:/.test(doc),
    "path routing breaks the viewer's default URLs; the override line IS the config");
  // The swarm rule is the failure with no error message, and TLS adds a second URL form that
  // makes it easier to violate.
  checkTrue("restates the swarm-identity rule", /swarm/i.test(doc) && /0 peers/.test(doc),
    "mixing https and LAN-IP URLs silently splits the swarm");
  checkTrue("states which ports must be open (80/443 only)", /\b80 and 443\b/.test(doc));
  // HARD RULE 2: an unrun config must not read as verified.
  // Assert the SUBSTANCE, not one phrasing. Iter 65 replaced the prose caveat with a
  // verified/unverified table, and the old regex (`not (validated|been run)|unrun`) stopped
  // matching even though the doc still admitted the gap twice — a test pinned to wording rather
  // than meaning fails on a documentation improvement. What must be true: the doc says the
  // Caddyfile is unverified AND says why (no caddy binary / no other parser).
  checkTrue("admits the Caddyfile is NOT validated or served",
    /(not .{0,40}(validated|been run|served)|unrun|only Caddyfile parser|never served)/i.test(doc),
    "no caddy binary was available, so claiming it works would be unearned");
  checkTrue("...and names the reason (no caddy binary / no library)",
    /no caddy binary|no library|only .{0,20}parser/i.test(doc),
    "an unexplained gap reads as an oversight rather than a tool limitation");
  checkTrue("says secrets come from env, not the repo", /secret/i.test(doc) && /\$P2P_HOST/.test(doc));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
