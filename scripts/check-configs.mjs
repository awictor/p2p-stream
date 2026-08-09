#!/usr/bin/env node
/**
 * check-configs.mjs — parse every config this repo ships (P2P-0053).
 *
 * WHY. Iters 59 and 61 committed `deploy/Caddyfile` and `docker-compose.yml` with their syntax
 * NEVER CHECKED — no caddy binary, no docker binary, and `yaml` was not even installed, so
 * compose.test.js hand-parsed the one block shape it needed and would have passed on a file
 * `docker` rejects. Between them the two files carried "not validated" in five places. Being
 * honest about a gap is not the same as closing it.
 *
 * And the embarrassing part: **nginx has been vendored in `bin/` since the first iteration** and
 * validates `origin/nginx.conf` in under a second. We owned a validator for one of three configs
 * and never once ran it.
 *
 * What each check can actually prove, stated honestly rather than uniformly:
 *   docker-compose.yml — REAL PARSE via the `yaml` package, plus the structural invariants
 *                        (services present, ports well-formed). Not `docker compose config`, so
 *                        schema/image validity is still unproven.
 *   origin/nginx.conf  — REAL `nginx -t`. This is a full syntax + directive check by the actual
 *                        server, the strongest check in here.
 *   deploy/Caddyfile   — SKIPPED unless a caddy binary exists. `caddy validate` is the only
 *                        thing that can parse Caddyfile syntax; there is no library. Reported as
 *                        SKIP with the reason, never as a pass.
 *
 * Exit 0 = every available check passed. Exit 1 = a config is broken. A SKIP is not a failure,
 * but it is printed loudly so "all green" cannot be mistaken for "all verified".
 *
 * Usage: node scripts/check-configs.mjs      (npm run check:configs)
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import YAML from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const ok = (name, detail) => results.push({ state: "PASS", name, detail });
const bad = (name, detail) => results.push({ state: "FAIL", name, detail });
const skip = (name, detail) => results.push({ state: "SKIP", name, detail });

// ── docker-compose.yml: a real YAML parse ───────────────────────────────────────────────────
{
  const p = path.join(ROOT, "docker-compose.yml");
  if (!existsSync(p)) {
    bad("docker-compose.yml", "missing");
  } else {
    let doc = null;
    try {
      doc = YAML.parse(readFileSync(p, "utf8"));
      ok("docker-compose.yml parses as YAML", `${Object.keys(doc.services || {}).length} services`);
    } catch (e) {
      // YAML errors carry a line/col, which is the whole value of a real parser over a regex.
      bad("docker-compose.yml parses as YAML", e.message.split("\n")[0]);
    }
    if (doc) {
      // Structural checks a hand-rolled reader could not do reliably. Still NOT the compose
      // schema — `docker compose config` remains the only thing that validates image tags and
      // key names, and that needs a docker binary.
      if (doc.services && typeof doc.services === "object") {
        ok("has a services map", Object.keys(doc.services).join(", "));
      } else {
        bad("has a services map", "missing or not a mapping");
      }
      const badPorts = [];
      for (const [name, svc] of Object.entries(doc.services || {})) {
        for (const entry of svc?.ports || []) {
          // Every published port must be "host:container" with both numeric. A bare "8080" is
          // legal compose but assigns a RANDOM host port, which silently breaks the viewer's
          // derived URLs — so it is rejected here on purpose.
          if (!/^\d+:\d+$/.test(String(entry))) badPorts.push(`${name}: ${entry}`);
        }
      }
      if (badPorts.length) bad("every port is host:container", badPorts.join("; "));
      else ok("every port is host:container", "no bare or ranged ports");

      // Named volumes must be declared, or compose treats the name as a relative host path.
      const declared = new Set(Object.keys(doc.volumes || {}));
      const missing = [];
      for (const [name, svc] of Object.entries(doc.services || {})) {
        for (const v of svc?.volumes || []) {
          const src = String(v).split(":")[0];
          // Anything not starting with . or / is a volume NAME, not a bind mount.
          if (!/^[./]/.test(src) && !declared.has(src)) missing.push(`${name}: ${src}`);
        }
      }
      if (missing.length) bad("named volumes are declared", missing.join("; "));
      else ok("named volumes are declared", [...declared].join(", ") || "none used");
    }
  }
}

// ── origin/nginx.conf: the real thing, with the real binary ─────────────────────────────────
{
  // ⚠ `-c` RESOLVES RELATIVE TO `-p`. `-p origin -c origin/nginx.conf` looks for
  // origin/origin/nginx.conf and dies with CreateFile(3), which reads like a missing file.
  // The working form is `-p origin -c nginx.conf`.
  const vendored = path.join(ROOT, "bin", "nginx-1.27.4", "nginx.exe");
  const bin = existsSync(vendored) ? vendored : "nginx";
  try {
    const out = execFileSync(bin, ["-t", "-p", "origin", "-c", "nginx.conf"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    ok("origin/nginx.conf passes nginx -t", (out || "").trim().split("\n").pop() || "syntax is ok");
  } catch (e) {
    const msg = ((e.stderr || "") + (e.stdout || "")).trim();
    // ENOENT means no nginx at all — a SKIP, not a broken config.
    if (e.code === "ENOENT") skip("origin/nginx.conf", "no nginx binary (bin/ empty and none on PATH)");
    else bad("origin/nginx.conf passes nginx -t", msg.split("\n")[0] || e.message);
  }
}

// ── deploy/Caddyfile: only caddy can parse a Caddyfile ──────────────────────────────────────
{
  const p = path.join(ROOT, "deploy", "Caddyfile");
  if (!existsSync(p)) {
    bad("deploy/Caddyfile", "missing");
  } else {
    try {
      // `caddy validate` needs the same env var the file interpolates, or it fails on an empty
      // site address for a reason that has nothing to do with the syntax being wrong.
      const out = execFileSync("caddy", ["validate", "--config", p, "--adapter", "caddyfile"], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, P2P_HOST: process.env.P2P_HOST || "localhost" },
      });
      ok("deploy/Caddyfile passes caddy validate", (out || "").trim().split("\n").pop() || "valid");
    } catch (e) {
      if (e.code === "ENOENT") {
        skip("deploy/Caddyfile", "no caddy binary — `caddy validate` is the ONLY Caddyfile parser, " +
          "so this file's syntax remains UNVERIFIED (see deploy/README.md)");
      } else {
        bad("deploy/Caddyfile passes caddy validate",
          ((e.stderr || e.stdout || e.message) + "").trim().split("\n")[0]);
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────
console.log("config checks:");
for (const r of results) {
  console.log(`  ${r.state}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
const failed = results.filter((r) => r.state === "FAIL");
const skipped = results.filter((r) => r.state === "SKIP");
if (skipped.length) {
  // Printed as its own line so a green run never reads as "everything is verified".
  console.log(`\n⚠ ${skipped.length} config NOT verified (skipped): ${skipped.map((s) => s.name).join(", ")}`);
}
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${failed.length} broken config(s)` +
  `, ${results.filter((r) => r.state === "PASS").length} check(s) passed, ${skipped.length} skipped`);
process.exitCode = failed.length === 0 ? 0 : 1;
