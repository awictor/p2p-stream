#!/usr/bin/env node
/**
 * shutdown.test.js — graceful shutdown (P2P-0091, iter 166).
 *
 * GRACEFUL SHUTDOWN milestone. Rolling deploys/autoscalers send SIGTERM constantly; a metrics server
 * must drain and exit 0, not trip UV_HANDLE_CLOSING (127) with an open listener handle.
 *
 * Two roles in one file (avoids a second committed helper; child resolves node_modules via repo cwd):
 *   - CHILD (--child): boot startMetrics, install shutdown (registers the real SIGTERM/SIGINT prod
 *     handlers), print READY, then idle. Triggering the drain: on Linux a real SIGTERM works, but
 *     Windows has no catchable SIGTERM — child.kill("SIGTERM") maps to TerminateProcess and the
 *     handler never runs. So the parent triggers the SAME drain function via an IPC message, which
 *     exercises the full server.close -> exit(0) path portably. Real-signal delivery is a Linux prod
 *     property recorded in manual-qa.md.
 *   - PARENT (default): (1) spawn a child, wait for READY, IPC-trigger the drain, assert exit code 0
 *     within a deadline; (2) unit-assert installShutdown is idempotent (a second signal reuses the
 *     one drain promise, exit called once) with an injected fake server + exit.
 *
 * Usage: node test/shutdown.test.js     (exit 0 = pass, 1 = fail)
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ---- CHILD ROLE ---------------------------------------------------------------------------------
if (process.argv.includes("--child")) {
  const { startMetrics } = await import("../server/metrics.js");
  const { installShutdown } = await import("../server/shutdown.js");
  const PORT = Number(process.env.SHUT_PORT);
  const server = startMetrics(PORT); // graceful:false — we install here to hold the trigger handle
  const { shutdown } = installShutdown(server); // registers real SIGTERM/SIGINT (prod path)
  // Portable drain trigger for the test (Windows can't deliver a catchable SIGTERM). This calls the
  // exact same drain the signal handlers do.
  process.on("message", (m) => { if (m === "shutdown") shutdown("IPC"); });
  await new Promise((r) => setTimeout(r, 250));
  process.stdout.write("READY\n");
  // Keep alive; the listener handle already holds the loop open. Only the drain ends it.
  setInterval(() => {}, 1000);
}
// ---- PARENT ROLE --------------------------------------------------------------------------------
else {
  const { installShutdown } = await import("../server/shutdown.js");

  let failures = 0;
  function checkTrue(name, actual, why = "") {
    const ok = actual === true;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${why}`}`);
  }

  function bootAndSignal() {
    return new Promise((resolve) => {
      const env = { ...process.env, SHUT_PORT: "8576" };
      // ipc so the parent can trigger the drain portably (see header — Windows SIGTERM is uncatchable).
      const child = spawn(process.execPath, [__filename, "--child"], { env, stdio: ["ignore", "pipe", "inherit", "ipc"] });
      let ready = false;
      let killTimer = null;
      const deadline = setTimeout(() => {
        // Never drained in time — kill hard so the test can't hang, and report the failure.
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve({ code: null, timedOut: true });
      }, 8000);
      child.stdout.on("data", (d) => {
        if (!ready && d.toString().includes("READY")) {
          ready = true;
          // Give the event loop one tick, then request graceful shutdown via IPC.
          killTimer = setTimeout(() => { try { child.send("shutdown"); } catch { /* ignore */ } }, 100);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, signal, timedOut: false, ready });
      });
    });
  }

  // Watchdog: guarantees a REGRESSION IS CAUGHT BY THE EXIT CODE, not just by printed text. If the
  // drain path breaks and a promise hangs, the unref'd force-timer inside installShutdown won't keep
  // node alive, so the process could otherwise exit 0 with work pending — npm test would miss it.
  // This ref'd timer holds the loop open and forces exit 1 if the whole test overruns.
  const watchdog = setTimeout(() => {
    console.log("FAIL: test watchdog timeout — a drain hung; treating as failure");
    process.exit(1);
  }, 25000);

  (async () => {
    console.log("SIGTERM on a graceful metrics server -> drains + exits 0 (no 127)");
    {
      const r = await bootAndSignal();
      checkTrue("child became READY (listener up)", r.ready === true, "never printed READY");
      checkTrue("did not time out (drain finished in bound)", r.timedOut === false, "drain exceeded 8s");
      checkTrue("exited on graceful drain, not a hard signal", r.signal == null,
        `killed by signal ${r.signal}`);
      checkTrue("exit code 0 (graceful, not 127 UV_HANDLE_CLOSING)", r.code === 0, `got code ${r.code}`);
    }

    console.log("\ninstallShutdown is idempotent — a second signal reuses one drain, exits once");
    {
      let closeCalls = 0;
      const fakeServer = { close(cb) { closeCalls++; setTimeout(cb, 5); } };
      let exitCalls = 0; let exitCode = null;
      const logs = [];
      const { shutdown, dispose } = installShutdown(fakeServer, {
        exit: (c) => { exitCalls++; exitCode = c; },
        log: (l) => logs.push(l),
      });
      const p1 = shutdown("SIGTERM");
      const p2 = shutdown("SIGINT"); // second signal during drain
      checkTrue("second signal returns the SAME promise", p1 === p2, "got a fresh promise");
      await p1;
      // let the injected close() callback fire
      await new Promise((r) => setTimeout(r, 20));
      checkTrue("server.close called exactly once", closeCalls === 1, `got ${closeCalls}`);
      checkTrue("exit called exactly once", exitCalls === 1, `got ${exitCalls}`);
      checkTrue("exit code 0", exitCode === 0, `got ${exitCode}`);
      checkTrue("emitted one shutdown log line", logs.length === 1, `got ${logs.length}`);
      dispose();
    }

    clearTimeout(watchdog);
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
    // exit() (not just exitCode): the child's IPC channel + any lingering handle could otherwise keep
    // the parent alive; we've asserted everything, so leave deterministically with the verdict code.
    process.exit(failures === 0 ? 0 : 1);
  })().catch((e) => { clearTimeout(watchdog); console.error("ERROR:", e.stack || e.message); process.exit(1); });
}
