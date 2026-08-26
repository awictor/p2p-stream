#!/usr/bin/env node
/**
 * compose.test.js — invariants of docker-compose.yml (P2P-0051).
 *
 * This cannot prove the file parses as YAML or that the images run: there is no docker binary in
 * this environment, so `docker compose config` is an unchecked box in manual-qa.md. What it CAN
 * pin is the set of mistakes that fail SILENTLY, which is the only kind worth a test here:
 *
 *   - A RENUMBERED PORT. The viewer derives `${host}:8080/hls/stream.m3u8`, `${host}:8000` and
 *     `${host}:8001` from the page host (web/p2p-config.js). Those four ports are a contract with
 *     the client, not a preference. Change one and the viewer talks to nothing, with no error.
 *   - A MISSING SHARED VOLUME. ffmpeg writes segments, nginx reads them. Without a volume in both
 *     the origin serves an empty directory forever and the viewer just never starts.
 *   - nginx mounted the hls volume READ-WRITE, or the segmenter mounting the repo writable —
 *     both work, and both make it impossible to reason about who produced a file.
 *   - A secret committed to a public repo.
 *
 * The port assertions are derived from web/p2p-config.js rather than hardcoded, so if the viewer's
 * derivation ever changes, this test fails instead of silently agreeing with a stale number.
 *
 * Usage: node test/compose.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const COMPOSE_PATH = path.join(ROOT, "docker-compose.yml");
const CONFIG_PATH = path.join(ROOT, "web", "p2p-config.js");

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

const RAW = readFileSync(COMPOSE_PATH, "utf8");
// Strip comments before asserting. Every design decision in this file is explained in a comment
// that names the REJECTED option ("do not renumber", "read-only: only the segmenter writes here"),
// so a naive substring test matches the prose. Fifth time this has bitten in this repo — assume
// explanatory text contains the wrong value on purpose.
const YML = RAW.split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n");

/**
 * Read the compose file with a REAL YAML parser (P2P-0053). This replaced a hand-rolled block
 * reader written to avoid a dependency — which was the only thing standing between a malformed file
 * and a green suite, since it agreed with itself by construction. `scripts/check-configs.mjs`
 * proves the file parses; this normalises it into the shape the assertions below want.
 *
 * Still NOT the compose schema: only `docker compose config` validates image tags and key names,
 * and that needs a docker binary. What is proven here is parse + structure.
 */
function servicesFrom(doc) {
  const out = {};
  for (const [name, svc] of Object.entries((doc && doc.services) || {})) {
    out[name] = {
      ports: (svc?.ports || []).map(String),
      volumes: (svc?.volumes || []).map(String),
      // Flattened for the substring assertions on command/entrypoint below.
      raw: JSON.stringify(svc || {}),
    };
  }
  return out;
}

const doc = YAML.parse(RAW);
const services = servicesFrom(doc);

const allPublished = Object.values(services).flatMap((s) => s.ports);
// "8080:8080" -> host port 8080
const hostPorts = allPublished.map((p) => Number(String(p).split(":")[0])).filter(Number.isFinite);

// The ports the VIEWER actually derives, read out of the real config rather than hardcoded here.
const CONFIG = readFileSync(CONFIG_PATH, "utf8");
const derivedPorts = [...new Set(
  [...CONFIG.matchAll(/\$\{(?:http|ws)\}:\/\/\$\{host\}:(\d+)/g)].map((m) => Number(m[1]))
)].sort((a, b) => a - b);

console.log("the ports are a CONTRACT with the viewer, derived from web/p2p-config.js");
{
  // Sanity on the derivation itself: if this regex ever stops finding the ports, every assertion
  // below would trivially pass against an empty list.
  check("found the viewer's derived ports in p2p-config.js", derivedPorts.join(","), "8000,8001,8002,8080");
  checkTrue("compose.yml exists", existsSync(COMPOSE_PATH));
  for (const p of derivedPorts) {
    checkTrue(`port ${p} (derived by the viewer) is published`, hostPorts.includes(p),
      "the viewer builds this URL from the page host; unpublished means it talks to nothing");
  }
  // The viewer page itself is not derived — it IS the page host — so it is asserted separately.
  checkTrue("port 5173 (the viewer page) is published", hostPorts.includes(5173));
  // Host:container must MATCH for every one of them. A remap like "9080:8080" publishes the
  // service but the viewer still derives :8080 and fails.
  const mismatched = allPublished.filter((p) => {
    const [h, c] = String(p).split(":");
    return c && h !== c;
  });
  check("no host:container remaps (the viewer derives the CONTAINER port)", mismatched.join(","), "");
}

console.log("\nthe four services, and one shared volume that makes the origin work at all");
{
  const names = Object.keys(services).sort();
  check("exactly four services", names.join(","), "origin,segmenter,tracker,web");

  // THE LOAD-BEARING ONE. ffmpeg writes segments; nginx reads them. If the volume is missing from
  // either side, nginx serves an empty directory and the viewer never starts — no error anywhere.
  const segHls = services.segmenter.volumes.find((v) => v.startsWith("hls:"));
  const origHls = services.origin.volumes.find((v) => v.startsWith("hls:"));
  checkTrue("the segmenter mounts the hls volume", !!segHls,
    "without it ffmpeg writes into the container's own layer and nginx sees nothing");
  checkTrue("the origin mounts the SAME hls volume", !!origHls);
  check("both mount it at the same path", segHls?.split(":")[1], origHls?.split(":")[1]);
  // Only the producer may write it. Read-only on the consumer is what makes "who wrote this file"
  // answerable at all.
  checkTrue("the origin mounts hls READ-ONLY", !!origHls && origHls.endsWith(":ro"),
    "only the segmenter produces segments; a writable mount makes provenance unprovable");
  checkTrue("the segmenter's hls mount is NOT read-only", !!segHls && !segHls.endsWith(":ro"),
    "it is the producer — a read-only mount here fails at the first write");
  // The volume has to be declared, or compose treats `hls:` as a bind mount to a relative path.
  checkTrue("hls is declared as a named volume", /^volumes:/m.test(YML) && /^\s{2}hls:/m.test(YML),
    "an undeclared name is interpreted as a host path, not a shared volume");

  // The segmenter gets the repo read-only: it should only ever write into hls/.
  checkTrue("the segmenter mounts the repo read-only",
    services.segmenter.volumes.some((v) => /^\.:.*:ro$/.test(v)),
    "its only writable path should be the segment output");
}

console.log("\nthe segmenter runs segment.sh, not a duplicated ffmpeg command line");
{
  const seg = services.segmenter.raw;   // JSON of the service block, from the real parse
  // The encoder flags (2s segments, fMP4, independent_segments, LIST_SIZE 90) are load-bearing and
  // pinned by test/segment.test.js. Duplicating them here would create a second source of truth
  // that no test compares against the first.
  checkTrue("entrypoint invokes origin/segment.sh", /origin\/segment\.sh/.test(seg),
    "duplicating the ffmpeg flags here would fork the encoder config away from segment.test.js");
  checkTrue("no inline ffmpeg flags", !/-hls_time|-hls_segment_type|libx264/.test(YML),
    "those belong in segment.sh, which is tested");
  // MODE/SRC are overridable so `vod` works without editing the file.
  checkTrue("MODE and SRC are env-overridable", /\$\{MODE:-loop\}/.test(YML) && /\$\{SRC:-/.test(YML));
  // nginx must keep its -p prefix, or every relative path in nginx.conf resolves wrong.
  checkTrue("nginx keeps its -p prefix", /-p.{0,4}\/app\/origin/.test(YML),
    "nginx.conf's logs/, temp/ and hls/ paths are all relative to the prefix");
  checkTrue("nginx runs in the foreground", /daemon off/.test(YML),
    "a daemonising nginx exits its container immediately");
}

console.log("\nno secrets (this repo is PUBLIC)");
{
  checkTrue("no token/secret/password/key literals",
    !/(secret|password|passwd|api[_-]?key|token)\s*[:=]\s*\S/i.test(YML));
  checkTrue("no .env file is referenced", !/env_file/.test(YML),
    "an env_file would encourage committing one");
  // The tuning knobs the metrics server reads are deliberately ABSENT: the defaults are the values
  // every published number was measured with, so pinning different ones here would silently
  // invalidate the README.
  checkTrue("does not override MIN_ATTESTERS / MAX_VOUCH_PER_ATTESTER",
    !/MIN_ATTESTERS|MAX_VOUCH_PER_ATTESTER/.test(YML.replace(/^\s*#.*$/gm, "")),
    "the defaults are what every published measurement used");
}

console.log("\nREADME documents the one command, and admits this is unvalidated");
{
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  checkTrue("README gives `docker compose up`", /docker compose up/.test(readme));
  checkTrue("README shows the vod override", /MODE=vod/.test(readme));
  // HARD RULE 2: an unrun config must not read as verified.
  checkTrue("README admits compose is unvalidated",
    /compose[\s\S]{0,200}?(not been (run|validated)|unvalidated|unverified)/i.test(readme),
    "no docker binary was available, so claiming it works would be unearned");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
