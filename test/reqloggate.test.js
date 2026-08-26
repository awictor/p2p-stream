#!/usr/bin/env node
/**
 * reqloggate.test.js — the LOG_LEVEL gate on the structured request log (P2P-0090, HARDEN iter 164).
 *
 * reqlog.test.js pins the PURE formatter shape. This pins the RUNTIME GATE that reqlog can't reach:
 * LOG_ON is read from process.env.LOG_LEVEL at startMetrics() boot, so the only honest test boots a
 * real server under a chosen LOG_LEVEL and inspects what actually hits stdout.
 *
 * One file, two roles (avoids a second committed helper + resolves node_modules via cwd=repo):
 *   - CHILD  (argv has --child): boot metrics, fetch /stats once, close, exit. Any request-log line
 *     the middleware writes goes to THIS process's stdout.
 *   - PARENT (default): spawn this file as a child twice — LOG_LEVEL unset (silent) and LOG_LEVEL=info
 *     (emit) — capture each child's stdout, assert the gate. Child log lines are fenced with @@ markers
 *     so the child's own console noise never confuses the parse.
 *
 * Usage: node test/reqloggate.test.js     (exit 0 = pass, 1 = fail)
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ---- CHILD ROLE ---------------------------------------------------------------------------------
if (process.argv.includes("--child")) {
  const { startMetrics } = await import("../server/metrics.js");
  const PORT = Number(process.env.GATE_PORT);
  const server = startMetrics(PORT);
  // Give the listener a beat, hit one route, let "finish" fire, then tear down.
  await new Promise((r) => setTimeout(r, 250));
  try {
    await fetch(`http://localhost:${PORT}/stats`);
  } catch { /* a failed fetch still exercises the middleware on the paths that did respond */ }
  await new Promise((r) => setTimeout(r, 150));
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
}

// ---- PARENT ROLE --------------------------------------------------------------------------------
let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
}

// The middleware writes bare JSON to stdout. To separate it from any other child chatter we can't
// control, we sniff for lines that PARSE as JSON AND carry the 5 contract fields — that is the log.
function extractLogLines(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let j; try { j = JSON.parse(s); } catch { continue; }
    if (j && "method" in j && "path" in j && "status" in j && "ms" in j && "requestId" in j) out.push(j);
  }
  return out;
}

function runChild(logLevel, port) {
  return new Promise((resolve) => {
    const env = { ...process.env, GATE_PORT: String(port) };
    if (logLevel === undefined) delete env.LOG_LEVEL; else env.LOG_LEVEL = logLevel;
    const child = spawn(process.execPath, [__filename, "--child"], { env, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.on("close", () => resolve(buf));
  });
}

(async () => {
  console.log("LOG_LEVEL unset — gate CLOSED, zero request-log lines on stdout");
  {
    const out = await runChild(undefined, 8573);
    const lines = extractLogLines(out);
    checkTrue("no request-log line emitted when LOG_LEVEL unset", lines.length === 0,
      `got ${lines.length}: ${JSON.stringify(lines).slice(0, 200)}`);
  }

  console.log("\nLOG_LEVEL=info — gate OPEN, one JSON line per request with the 5 fields");
  {
    const out = await runChild("info", 8574);
    const lines = extractLogLines(out);
    // Exactly the /stats request we made. (Not >=1: a leak/dupe is a real bug we want to catch.)
    checkTrue("exactly one request-log line emitted", lines.length === 1,
      `got ${lines.length}: ${JSON.stringify(lines).slice(0, 200)}`);
    const j = lines[0] || {};
    checkTrue("line is for GET /stats", j.method === "GET" && j.path === "/stats",
      `got ${JSON.stringify({ method: j.method, path: j.path })}`);
    checkTrue("status is a number", typeof j.status === "number", `got ${typeof j.status}`);
    checkTrue("ms is a number", typeof j.ms === "number", `got ${typeof j.ms}`);
    checkTrue("requestId is a non-empty string", typeof j.requestId === "string" && j.requestId.length > 0,
      `got ${JSON.stringify(j.requestId)}`);
  }

  console.log("\nLOG_LEVEL=off — explicit off is also silent (not just unset)");
  {
    const out = await runChild("off", 8575);
    const lines = extractLogLines(out);
    checkTrue("no request-log line emitted when LOG_LEVEL=off", lines.length === 0,
      `got ${lines.length}`);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exitCode = 1; });
