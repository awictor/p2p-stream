/**
 * browser-receipt-probe.cjs — P2P-0084 end-to-end: a real browser earns RECEIPTED (payout-grade)
 * credit through the SHIPPED viewer code (iter 125).
 *
 * receiptedBytes is the ONLY payout-grade tier (certified + per-segment corroborated + non-self).
 * browser-credit-probe (0083) proved the certified tier from a bulk attest; this proves the browser
 * mints a per-segment RECEIPT the server counts as receiptedBytes — the client source of the payable
 * number. No hardcoded keys: key minted in-browser, cert fetched live from /issue.
 *
 * A lone headless viewer has no peers so onSegmentLoaded never fires with a real d.peerId — the
 * shipped receipt path can't trigger naturally. So this probe uses the SHIPPED primitives
 * (__identity.sign + __cert + the exact receipt shape server isReceiptShape demands) to mint one
 * receipt with a synthetic sender and POST it, demonstrating the AUTH+receipt path end to end; the
 * real mesh producing receipts is `npm run verify`.
 *
 * Boots issuer + metrics in-process (PoW ON, TRACKER_PUBKEY wired), serves web/ over http://127.0.0.1,
 * loads the viewer, POSTs a signed receipt, reads /stats. Prints SPIKE_RESULT=GREEN/RED; always exits 0.
 *
 * Run: cd /c/Users/acwic/.claude/skills/playwright-skill && node run.js /c/Users/acwic/p2p-stream/test/browser-receipt-probe.cjs
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
    const POW_BITS = 8;
    const IPORT = 8422, MPORT = 8423;
    issuer = startIssuer(IPORT, identity, POW_BITS);
    process.env.TRACKER_PUBKEY = identity.publicKey;
    const { startMetrics } = await imp("server/metrics.js");
    metrics = startMetrics(MPORT);

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

    // In-page: wait for the shipped identity+cert, then mint + POST a receipt with the shipped
    // __identity.sign, using the exact 4-field shape the server verifies. Synthetic sender/receiver.
    const posted = await page.evaluate(async (mport) => {
      const id = await window.__identityReady;
      const cert = await window.__certReady;
      if (!id) return { ok: false, reason: "no identity" };
      if (!cert) return { ok: false, reason: "no cert (issuer/PoW failed in-browser)" };
      const clientId = "browser-receipt-probe";
      const receipt = { segmentId: "seg-1", bytes: 3_000_000, senderPeerId: "peer-sender", receiverPeerId: "peer-me" };
      const signed = { ...receipt, sig: await id.sign(receipt) };
      // A report may carry receipts without attest; the server recomputes cert status for receipts.
      const res = await fetch(`http://127.0.0.1:${mport}/metrics`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, httpBytes: 1000, p2pBytes: 3_000_000, uploadBytes: 0,
          ts: Date.now(), peerId: "peer-me", pubKey: id.pubKey, cert, receipts: [signed] }),
      });
      return { ok: res.ok, clientId };
    }, MPORT);

    if (!posted.ok) { reason = posted.reason || "report POST failed"; }
    else {
      await new Promise((r) => setTimeout(r, 200));
      const stats = await fetchJson(`http://127.0.0.1:${MPORT}/stats`);
      if (!(stats.receiptedBytes > 0)) reason = `receiptedBytes=${stats.receiptedBytes} (browser receipt not accepted)`;
      else { verdict = "GREEN"; reason = `receiptedBytes=${stats.receiptedBytes} from a browser-minted receipt+cert`; }
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
