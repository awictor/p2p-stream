#!/usr/bin/env node
/**
 * config.test.js — unit test for web/p2p-config.js URL derivation and ICE shape.
 *
 * This file had NO coverage despite deciding every server URL and the swarm identity,
 * and two of the worst bugs in this project lived in exactly this kind of config:
 * the `?transport=udp`-on-a-stun:-URL typo that made every RTCPeerConnection throw
 * (nine iterations of 0% offload), and hardcoded `localhost` URLs that silently split
 * the swarm on a second machine.
 *
 * It evaluates the REAL file (no copy of the logic) against a fake `location`, so the
 * assertions cannot drift from what the browser actually runs.
 *
 * Usage: node test/config.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "..", "web", "p2p-config.js"), "utf8");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
function checkTrue(name, actual) {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : " — got falsy"}`);
}

// Run the real config file with a stubbed browser environment and return window.P2P_DEMO.
function load({ protocol = "http:", hostname = "localhost", search = "" } = {}) {
  const win = {};
  const fn = new Function("window", "location", "URLSearchParams", SRC);
  fn(win, { protocol, hostname, search }, URLSearchParams);
  return win.P2P_DEMO;
}

(async () => {
  console.log("localhost defaults:");
  {
    const c = load();
    check("streamUrl", c.streamUrl, "http://localhost:8080/hls/stream.m3u8");
    check("tracker", c.announceTrackers[0], "ws://localhost:8000");
    check("metricsUrl", c.metricsUrl, "http://localhost:8001/metrics");
    check("one tracker entry", c.announceTrackers.length, 1);
    check("reportIntervalMs", c.reportIntervalMs, 3000);
  }

  console.log("\nURLs derive from the page host, so a LAN viewer talks to the LAN host:");
  {
    const c = load({ hostname: "192.168.68.66" });
    check("streamUrl follows host", c.streamUrl, "http://192.168.68.66:8080/hls/stream.m3u8");
    check("tracker follows host", c.announceTrackers[0], "ws://192.168.68.66:8000");
    check("metrics follows host", c.metricsUrl, "http://192.168.68.66:8001/metrics");
  }

  console.log("\nhttps page upgrades http->https and ws->wss (WebRTC/MSE need a secure context):");
  {
    const c = load({ protocol: "https:", hostname: "stream.example.com" });
    checkTrue("streamUrl is https", c.streamUrl.startsWith("https://"));
    checkTrue("tracker is wss", c.announceTrackers[0].startsWith("wss://"));
    checkTrue("metricsUrl is https", c.metricsUrl.startsWith("https://"));
  }

  console.log("\nfile:// (empty hostname) falls back to localhost instead of an empty host:");
  {
    const c = load({ protocol: "file:", hostname: "" });
    check("streamUrl", c.streamUrl, "http://localhost:8080/hls/stream.m3u8");
    checkTrue("no '//:' in URL", !c.streamUrl.includes("//:"));
  }

  console.log("\n?host= overrides the page hostname:");
  {
    const c = load({ hostname: "localhost", search: "?host=10.0.0.5" });
    check("streamUrl", c.streamUrl, "http://10.0.0.5:8080/hls/stream.m3u8");
    check("tracker", c.announceTrackers[0], "ws://10.0.0.5:8000");
  }

  console.log("\nper-service overrides beat both ?host= and the page hostname:");
  {
    const c = load({
      hostname: "localhost",
      search: "?host=10.0.0.5&origin=http://cdn.test/x.m3u8&tracker=wss://t.test&metrics=https://m.test/metrics",
    });
    check("origin override", c.streamUrl, "http://cdn.test/x.m3u8");
    check("tracker override", c.announceTrackers[0], "wss://t.test");
    check("metrics override", c.metricsUrl, "https://m.test/metrics");
  }

  console.log("\nswarmId: default, and ?swarm= override (viewers must agree or they split):");
  {
    check("default", load().swarmId, "p2p-stream-demo-1");
    check("override", load({ search: "?swarm=my-swarm" }).swarmId, "my-swarm");
  }

  console.log("\np2pEnabled: ?p2p=off is the harness control arm, and must FAIL SAFE:");
  {
    // Default and any non-"off" value must leave P2P ON. If a typo silently disabled P2P,
    // a normal verify run would report 0% offload and look like a product regression; and
    // the control arm would stop being a control. Only the exact string "off" disables.
    check("default is enabled", load().p2pEnabled, true);
    check("?p2p=off disables", load({ search: "?p2p=off" }).p2pEnabled, false);
    check("?p2p=on enables", load({ search: "?p2p=on" }).p2pEnabled, true);
    check("?p2p=OFF is NOT off (exact match only)", load({ search: "?p2p=OFF" }).p2pEnabled, true);
    check("?p2p= (empty) stays enabled", load({ search: "?p2p=" }).p2pEnabled, true);
    check("?p2p=false stays enabled", load({ search: "?p2p=false" }).p2pEnabled, true);
    // The flag must not disturb anything else — the control arm has to hit the same origin,
    // tracker and swarm as the real arm, or the two runs are not comparable.
    const off = load({ search: "?p2p=off" });
    const on = load();
    check("same streamUrl in both arms", off.streamUrl, on.streamUrl);
    check("same tracker in both arms", off.announceTrackers[0], on.announceTrackers[0]);
    check("same swarmId in both arms", off.swarmId, on.swarmId);
  }

  console.log("\nICE SERVERS — regression guard on the bug that cost nine iterations:");
  {
    const c = load();
    checkTrue("at least one ICE server", c.iceServers.length >= 1);
    for (const s of c.iceServers) {
      const u = s.urls;
      // A query string is legal ONLY on turn:/turns:. On a stun: URL Chromium rejects the
      // ENTIRE ICE config and every RTCPeerConnection constructor throws, which the engine
      // buries in an "offer-failed" warning — announces then carry offers:[] and no peer
      // can ever connect. This is the exact shape that broke offload for nine iterations.
      const isStun = u.startsWith("stun:");
      checkTrue(`${u} — scheme is stun:/turn:/turns:`, /^(stun|turns?):/.test(u));
      checkTrue(`${u} — no query string on a stun: URL`, !(isStun && u.includes("?")));
      checkTrue(`${u} — has a host`, u.split(":").length >= 2 && u.split(":")[1].length > 0);
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
