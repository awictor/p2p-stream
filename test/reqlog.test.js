#!/usr/bin/env node
/**
 * reqlog.test.js — structured request log (P2P-0090, iter 163).
 *
 * SERVER OBSERVABILITY. One JSON line per request (method/path/status/ms/requestId) so ops can
 * correlate + read latency from a pipeline. Pins the PURE formatter shape (the contract downstream
 * parsers depend on) and the LOG_LEVEL gate (silent by default so tests/CI aren't flooded).
 *
 * Usage: node test/reqlog.test.js     (exit 0 = pass, 1 = fail)
 */
import { buildLogLine } from "../server/metrics.js";

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

console.log("buildLogLine — pure, exactly the 5-field contract, valid JSON");
{
  const line = buildLogLine({ method: "POST", path: "/metrics", status: 200, ms: 1.23, requestId: "abc123" });
  checkTrue("returns a string", typeof line === "string");
  let j = null; let threw = false;
  try { j = JSON.parse(line); } catch { threw = true; }
  checkTrue("is valid JSON (round-trips)", threw === false && j !== null);
  check("method", j.method, "POST");
  check("path", j.path, "/metrics");
  check("status is a number", j.status, 200);
  check("ms is a number", j.ms, 1.23);
  check("requestId present", j.requestId, "abc123");
  // The contract is EXACTLY these five — a drift (extra/renamed field) breaks downstream parsers.
  check("exactly the 5 contract fields, no more", Object.keys(j).sort().join(","),
    "method,ms,path,requestId,status");
}

console.log("\nno trailing newline (the caller adds it, not the formatter)");
{
  const line = buildLogLine({ method: "GET", path: "/healthz", status: 200, ms: 0.1, requestId: "x" });
  checkTrue("no trailing \\n in the pure line", !line.endsWith("\n"));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
