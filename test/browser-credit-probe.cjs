/**
 * browser-credit-probe.cjs — P2P-0083 end-to-end: a real browser earns CERTIFIED credit through the
 * SHIPPED viewer code (iter 122).
 *
 * Proves the payable path in a browser, not just in node tests: the shipped web/index.html generates
 * an ed25519 key (P2P-0082), fetches a tracker cert from /issue (P2P-0079, solving the PoW if set),
 * signs the canonical {clientId, attest}, and the metrics server counts it as certifiedAttestedBytes.
 *
 * A LONE headless viewer has no peers, so its real `attest` map is empty and would earn 0 — that is
 * correct (no relay happened). This probe therefore drives the SHIPPED primitives (__identity.sign +
 * __cert + the exact report shape) with a synthetic attest to demonstrate the AUTH path end to end;
 * the real mesh producing attest is covered by `npm run verify`. No hardcoded keys — the key is
 * minted in-browser and the cert is fetched live from the issuer.
 *
 * Boots issuer + metrics IN-PROCESS (TRACKER_PUBKEY wired from the issuer identity, PoW ON to prove
 * the browser solves it), serves web/ over http://127.0.0.1 (secure context), loads the viewer,
 * POSTs a signed+certified report from the page, and reads /stats. Prints SPIKE_RESULT=GREEN/RED;
 * always exits 0.
 *
 * Run: cd /c/Users/acwic/.claude/skills/playwright-skill && node run.js /c/Users/acwic/p2p-stream/test/browser-credit-probe.cjs
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const REPO = process.env.P2P_REPO || "C:/Users/acwic/p2p-stream";
const WEB = path.join(REPO, "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const imp = (rel) => import(pathToFileURL(path.resolve(REPO, rel)).href);

(async () => {
  let verdict = "RED", reason = "unknown";
  let issuer, metrics, web, browser;
  try {
    const { loadTrackerIdentity, startIssuer } = await imp("server/tracker.js");
    const identity = loadTrackerIdentity({});
    // PoW ON (small) so the probe exercises the browser solver too, not just the no-PoW path.
    const POW_BITS = 8;
    const IPORT = 8412, MPORT = 8413;
    issuer = startIssuer(IPORT, identity, POW_BITS);

    // Metrics must verify certs against this identity's pubkey — set BEFORE importing metrics.
    process.env.TRACKER_PUBKEY = identity.publicKey;
    const { startMetrics } = await imp("server/metrics.js");
    metrics = startMetrics(MPORT);

    // Serve web/ with a P2P_DEMO stub pointing issuer/metrics at our in-process ports.
    web = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/" || rel === "") rel = "/index.html";
      const fp = path.join(WEB, rel);
      if (!fp.startsWith(WEB) || !fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
      let body = fs.readFileSync(fp);
      if (rel === "/index.html") {
        const stub = `<script>window.P2P_DEMO={swarmId:"probe",announceTrackers:[],rtcConfig:{},` +
          `metricsUrl:"http://127.0.0.1:${MPORT}/metrics",issuerUrl:"http://127.0.0.1:${IPORT}",reportIntervalMs:999999};</script>`;
        body = Buffer.from(body.toString("utf8").replace("</head>", stub + "</head>"), "utf8");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(body);
    });
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    const wport = web.address().port;

    browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${wport}/index.html`);

    // In-page: wait for the shipped identity + cert, then POST a signed+certified report with a
    // synthetic attest (a lone viewer has no real peers). Uses ONLY the shipped __identity/__cert.
    const posted = await page.evaluate(async (mport) => {
      const id = await window.__identityReady;
      const cert = await window.__certReady;
      if (!id) return { ok: false, reason: "no identity" };
      if (!cert) return { ok: false, reason: "no cert (issuer/PoW failed in-browser)" };
      const clientId = "browser-credit-probe";
      const attest = { "peer-relay": 4000000 };
      const sig = await id.sign({ clientId, attest });
      const res = await fetch(`http://127.0.0.1:${mport}/metrics`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, httpBytes: 1000, p2pBytes: 4000000, uploadBytes: 0,
          ts: Date.now(), peerId: "peer-self", attest, pubKey: id.pubKey, sig, cert }),
      });
      return { ok: res.ok, clientId, pubKey: id.pubKey, certLen: cert.length };
    }, MPORT);

    if (!posted.ok) { reason = posted.reason || "report POST failed"; }
    else {
      await new Promise((r) => setTimeout(r, 200));
      const stats = await fetchJson(`http://127.0.0.1:${MPORT}/stats`);
      if (!(stats.signedAttestedBytes > 0)) reason = `signedAttestedBytes=${stats.signedAttestedBytes} (browser sig not accepted)`;
      else if (!(stats.certifiedAttestedBytes > 0)) reason = `certifiedAttestedBytes=${stats.certifiedAttestedBytes} (cert not accepted)`;
      else { verdict = "GREEN"; reason = `certifiedAttestedBytes=${stats.certifiedAttestedBytes} from a browser-minted key+cert (signed=${stats.signedAttestedBytes})`; }
    }
  } catch (e) {
    reason = "probe-error: " + (e && (e.stack || e.message));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    for (const s of [issuer, metrics, web]) { try { if (s) s.close(); } catch { /* ignore */ } }
  }
  console.log(`SPIKE_RESULT=${verdict} reason=${reason}`);
  process.exit(0);
})();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    require("http").get(url, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
