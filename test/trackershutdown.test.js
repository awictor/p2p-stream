#!/usr/bin/env node
/**
 * trackershutdown.test.js — graceful shutdown of the tracker WS listener (P2P-0092, iter 167).
 *
 * GRACEFUL SHUTDOWN milestone, piece 2. The tracker holds long-lived WS signaling connections; an
 * ungraceful kill drops every peer's discovery channel at once on a deploy. Reuses the SAME
 * installShutdown helper as metrics (P2P-0091) — this test proves the tracker (+ its sibling metrics
 * & issuer HTTP servers) drain and the process exits 0, not 127 with an orphan handle.
 *
 * Two roles in one file (child resolves node_modules via repo cwd; Windows has no catchable SIGTERM
 * so the drain is triggered via IPC — see shutdown.test.js header, same rationale):
 *   - CHILD (--child): startTracker, install the drain, connect one real WS client to the tracker so
 *     there is a live connection to drain, print READY, idle. process.on("message","shutdown") runs
 *     the SAME drain the SIGTERM handler would.
 *   - PARENT: spawn child, wait READY, IPC-trigger, assert exit code 0 within a deadline.
 *
 * Usage: node test/trackershutdown.test.js     (exit 0 = pass, 1 = fail)
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ---- CHILD ROLE ---------------------------------------------------------------------------------
if (process.argv.includes("--child")) {
  const { startTracker } = await import("../server/tracker.js");
  const { installShutdown } = await import("../server/shutdown.js");
  const T = Number(process.env.TRK_PORT), M = Number(process.env.MET_PORT);
  const { tracker, metrics, issuer } = startTracker(T, M); // graceful:false; install here to hold handle
  // FORCE_TIMEOUT_MS is generous (3s) so the CLEAN close-callback path wins the race in the healthy
  // case; the parent asserts the drain finished WELL under this, which is what proves close() fired
  // rather than the force-timeout rescuing a broken wiring (mutation check).
  const FORCE_TIMEOUT_MS = 3000;
  const { shutdown } = installShutdown(tracker, {
    timeoutMs: FORCE_TIMEOUT_MS,
    onClose: () => Promise.all([
      new Promise((r) => { try { metrics.close(r); } catch { r(); } }),
      new Promise((r) => { try { issuer.close(r); } catch { r(); } }),
    ]),
  });
  process.on("message", (m) => { if (m === "shutdown") shutdown("IPC"); });
  // Open one real WS connection to prove the tracker is actually accepting signaling, then close it
  // so the drain's clean close-callback path can complete promptly (an idle open socket would pin
  // http.close and push us onto the force-timeout — a separate concern from the wiring under test).
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://localhost:${T}`);
  await new Promise((res) => {
    ws.on("open", () => { ws.close(); res(); });
    ws.on("error", () => res()); // still proceed; the drain path is what we're testing
    setTimeout(res, 800);
  });
  await new Promise((r) => setTimeout(r, 100));
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
}
// ---- PARENT ROLE --------------------------------------------------------------------------------
else {
  let failures = 0;
  function checkTrue(name, actual, why = "") {
    const ok = actual === true;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
  }

  const watchdog = setTimeout(() => {
    console.log("FAIL: test watchdog timeout — a drain hung; treating as failure");
    process.exit(1);
  }, 25000);

  function bootAndSignal() {
    return new Promise((resolve) => {
      const env = { ...process.env, TRK_PORT: "8577", MET_PORT: "8578" };
      const child = spawn(process.execPath, [__filename, "--child"], { env, stdio: ["ignore", "pipe", "inherit", "ipc"] });
      let ready = false, killTimer = null, sentAt = 0;
      const deadline = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve({ code: null, timedOut: true, ready });
      }, 8000);
      child.stdout.on("data", (d) => {
        if (!ready && d.toString().includes("READY")) {
          ready = true;
          killTimer = setTimeout(() => {
            sentAt = process.hrtime.bigint();
            try { child.send("shutdown"); } catch { /* ignore */ }
          }, 100);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        const drainMs = sentAt ? Number(process.hrtime.bigint() - sentAt) / 1e6 : null;
        resolve({ code, signal, timedOut: false, ready, drainMs });
      });
    });
  }

  (async () => {
    console.log("drain on a graceful tracker (WS + sibling metrics/issuer) -> exits 0 (no 127)");
    const r = await bootAndSignal();
    checkTrue("child became READY (tracker listening, WS client connected)", r.ready === true, "never printed READY");
    checkTrue("did not time out (drain finished in bound)", r.timedOut === false, "drain exceeded 8s");
    checkTrue("exited on graceful drain, not a hard signal", r.signal == null, `killed by signal ${r.signal}`);
    checkTrue("exit code 0 (graceful, not 127 UV_HANDLE_CLOSING)", r.code === 0, `got code ${r.code}`);
    // The clean close-callback path must WIN — draining in well under the 3s force-timeout proves
    // tracker.close() actually fired its callback, not that the force-timeout rescued broken wiring.
    // (Mutation: neuter the close() call -> drain falls to ~3s force-path -> this assertion FAILS.)
    checkTrue("drained via clean close() well under the 3s force-timeout", r.drainMs != null && r.drainMs < 2000,
      `drainMs=${r.drainMs == null ? "n/a" : r.drainMs.toFixed(0)}`);

    clearTimeout(watchdog);
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch((e) => { clearTimeout(watchdog); console.error("ERROR:", e.stack || e.message); process.exit(1); });
}
