/**
 * browser-auth-spike.cjs — capability spike for BROWSER-SIDE AUTH (P2P-0081, iter 119).
 *
 * The whole auth+reward arc (0068-0080) is SERVER-VERIFIED ONLY: no browser has ever generated an
 * ed25519 key, exported it, signed the canonical bytes, and had node's verifyReport accept it. The
 * roadmap kept DEFERRING browser signing to manual-qa on the ASSUMPTION crypto.subtle can't do it.
 * This probes the assumption instead of trusting it.
 *
 * What it does: launch chromium (the playwright skill's), serve a page over http://127.0.0.1 (a
 * SECURE CONTEXT — crypto.subtle needs one), in-page generate an Ed25519 keypair via crypto.subtle,
 * export the spki public key + sign the EXACT canonical bytes node will re-derive, hand both back,
 * and call node server/identity.js verifyReport. Interop is the crux: the browser's spki-DER-base64
 * must match node's spki format byte-for-byte over identical canonical bytes.
 *
 * VERDICT: prints `SPIKE_RESULT=GREEN` (browser can mint credit node accepts -> milestone loop-doable)
 * or `SPIKE_RESULT=RED reason=<...>` (no subtle / Ed25519 unsupported / format mismatch -> deferral
 * to manual-qa was correct). ALWAYS exits 0 with a recorded verdict; never a false pass.
 *
 * Run via the skill (it owns the playwright + chromium install):
 *   cd /c/Users/acwic/.claude/skills/playwright-skill && node run.js /c/Users/acwic/p2p-stream/test/browser-auth-spike.cjs
 */
const http = require("http");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

// The report node will verify. verifyReport(obj,...) signs/verifies over canonicalize(obj), so the
// browser must sign the canonical bytes of THIS object. Keep it a flat, key-sorted object so the
// in-page canonicalizer is trivial and provably matches server/identity.js canonicalize().
const REPORT = { clientId: "spike", msg: "p2p-stream browser-auth spike" };
const CANON = '{"clientId":"spike","msg":"p2p-stream browser-auth spike"}'; // canonicalize(REPORT)

function b64FromBytesInPageSource() {
  // (kept inline in evaluate below; this stub documents intent only)
}

(async () => {
  let verdict = "RED", reason = "unknown";
  let server, browser;
  try {
    // Serve a blank page over 127.0.0.1 so the page is a SECURE CONTEXT (crypto.subtle requires it;
    // a data: URL is an opaque origin and is unreliable for subtle across versions).
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>spike</body></html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    // In-page: is crypto.subtle present, can it do Ed25519, and export spki + sign?
    const out = await page.evaluate(async (canon) => {
      const enc = new TextEncoder();
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (!(self.isSecureContext)) return { ok: false, reason: "not-secure-context" };
      if (!(self.crypto && self.crypto.subtle)) return { ok: false, reason: "no-subtle" };
      let kp;
      try {
        kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      } catch (e) {
        return { ok: false, reason: "ed25519-keygen-unsupported: " + (e && e.name) };
      }
      let spki, sig;
      try {
        spki = await crypto.subtle.exportKey("spki", kp.publicKey);
        sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, enc.encode(canon));
      } catch (e) {
        return { ok: false, reason: "export-or-sign-failed: " + (e && e.name) };
      }
      return {
        ok: true,
        pubKey: b64(spki),
        sig: b64(sig),
        spkiLen: new Uint8Array(spki).length,
        sigLen: new Uint8Array(sig).length,
      };
    }, CANON);

    if (!out.ok) {
      reason = out.reason;
    } else {
      // Byte-length interop check first (node demands spki 44, sig 64).
      if (out.spkiLen !== 44 || out.sigLen !== 64) {
        reason = `format-mismatch spki=${out.spkiLen}(want44) sig=${out.sigLen}(want64)`;
      } else {
        // The skill copies this file to its own temp dir, so __dirname is unreliable — resolve
        // identity.js from an env override or the known repo path (this is a local spike tool).
        const repo = process.env.P2P_REPO || "C:/Users/acwic/p2p-stream";
        const idUrl = pathToFileURL(require("path").resolve(repo, "server", "identity.js"));
        const { verifyReport } = await import(idUrl.href);
        const accepted = verifyReport(REPORT, out.sig, out.pubKey);
        if (accepted === true) { verdict = "GREEN"; reason = "browser ed25519 verifies under node verifyReport"; }
        else { reason = "node verifyReport REJECTED a browser-signed report (interop gap)"; }
      }
    }
  } catch (e) {
    reason = "spike-error: " + (e && (e.stack || e.message));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (server) server.close(); } catch { /* ignore */ }
  }
  console.log(`SPIKE_RESULT=${verdict} reason=${reason}`);
  // Always exit 0: this is a probe that RECORDS a verdict, not a pass/fail gate.
  process.exit(0);
})();
