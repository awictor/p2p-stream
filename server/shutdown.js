// Graceful shutdown (P2P-0091). Rolling deploys and autoscalers send SIGTERM constantly; a server
// that drops live viewers or exits non-zero on every restart is un-deployable. This wires
// SIGTERM/SIGINT to server.close() so in-flight requests drain, the listener stops accepting, and
// the process exits 0 — instead of a bare process.exit() that trips libuv's UV_HANDLE_CLOSING and
// exits 127 with an open handle (see patterns.md).
//
// Threat/robustness note: this is a LIVENESS/deploy concern, not a security control. It does NOT
// defend against a malicious slow-loris holding a connection open past the drain window — that is
// exactly what `timeoutMs` bounds: after the deadline we force-destroy remaining sockets so a stuck
// or hostile peer cannot block the exit indefinitely.

// Install SIGTERM/SIGINT handlers that gracefully close `server`.
//   server    - an http.Server (or ws server exposing .close(cb))
//   signals   - which signals trigger the drain (default SIGTERM + SIGINT)
//   timeoutMs - hard deadline; if close() hasn't finished by then, force-destroy sockets and finish
//   onClose   - optional hook run after the server has closed (e.g. close a WS server too)
//   exit      - process.exit by default; injectable so a test can observe the code without dying
//   log       - where the one drain line goes; injectable, defaults to console.error (stderr)
// Returns { shutdown, dispose }: `shutdown(signal)` runs the drain once (idempotent, returns the
// same promise on repeat calls); `dispose()` removes the handlers so a test can boot many servers
// in one process without leaking listeners.
export function installShutdown(server, {
  signals = ["SIGTERM", "SIGINT"],
  timeoutMs = 10000,
  onClose,
  exit = (code) => process.exit(code),
  log = (line) => process.stderr.write(line + "\n"),
} = {}) {
  let draining = null; // the in-flight drain promise; set once, so a second signal is a no-op

  function shutdown(signal) {
    // Idempotent: a second SIGTERM (or SIGINT after SIGTERM) must not start a second close() —
    // double server.close() calls back with an ERR_SERVER_NOT_RUNNING and would double-count.
    if (draining) return draining;
    draining = new Promise((resolve) => {
      log(`{"event":"shutdown","signal":${JSON.stringify(signal || null)}}`);
      let settled = false;
      const finish = async (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (typeof onClose === "function") await onClose(); } catch { /* best-effort */ }
        resolve(code);
        exit(code);
      };
      // Bounded force-timeout: if a lingering connection keeps the server open past the deadline,
      // stop waiting and exit anyway. .unref() so the timer itself never keeps the loop alive.
      const timer = setTimeout(() => finish(0), timeoutMs);
      if (timer.unref) timer.unref();
      // Normal path: close() fires its callback once all connections have ended.
      server.close(() => finish(0));
    });
    return draining;
  }

  const handlers = signals.map((sig) => {
    const h = () => shutdown(sig);
    process.on(sig, h);
    return [sig, h];
  });

  function dispose() {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  }

  return { shutdown, dispose };
}
