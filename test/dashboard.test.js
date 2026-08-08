#!/usr/bin/env node
/**
 * dashboard.test.js — unit test for the dashboard's inline rendering logic.
 *
 * The dashboard is the surface a platform actually LOOKS AT to read the offload
 * number, and it had no coverage. If its formatting or percentage maths is wrong the
 * headline claim is misreported to a human even when /stats is perfectly correct.
 *
 * Like config.test.js, this extracts and evaluates the REAL inline <script> from
 * server/dashboard.html against a stubbed DOM/fetch, so it cannot drift from what the
 * browser runs.
 *
 * Usage: node test/dashboard.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, "..", "server", "dashboard.html"), "utf8");

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// Pull the inline script out of the real file and run it with a fake DOM.
function loadDashboard(stats) {
  const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no inline <script> found in dashboard.html");
  const els = {};
  const ids = ["offload", "bar", "viewers", "http", "p2p", "upload"];
  for (const id of ids) els[id] = { textContent: "", style: {} };

  const captured = {};
  const doc = { getElementById: (id) => els[id] };
  const win = {
    document: doc,
    fetch: async () => ({ json: async () => stats }),
    // Capture the tick fn instead of actually polling every 2s.
    setInterval: (fn) => { captured.fn = fn; return 1; },
  };
  const fn = new Function("document", "fetch", "setInterval", "window", m[1] + "\n;return typeof fmt==='function'?fmt:null;");
  const fmt = fn(doc, win.fetch, win.setInterval, win);
  return { els, fmt, tick: captured.fn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("byte formatting:");
  {
    const { fmt } = loadDashboard({});
    check("0 B", fmt(0), "0 B");
    check("512 B", fmt(512), "512 B");
    check("1 KB boundary", fmt(1024), "1.0 KB");
    check("1 MB", fmt(1024 * 1024), "1.0 MB");
    check("1.5 MB", fmt(1024 * 1024 * 1.5), "1.5 MB");
    check("1 GB", fmt(1024 ** 3), "1.0 GB");
    check("1 TB", fmt(1024 ** 4), "1.0 TB");
    // REGRESSION: only `b < 1024` guarded the small case, so a missing or non-numeric
    // field fell through to the divide loop and rendered the literal string "NaN KB"
    // on the dashboard — a broken number is worse than a zero, because it looks like
    // the pipeline failed rather than reporting nothing yet.
    check("undefined -> 0 B, not NaN", fmt(undefined), "0 B");
    check("null -> 0 B", fmt(null), "0 B");
    check("NaN -> 0 B", fmt(NaN), "0 B");
    check("non-numeric string -> 0 B", fmt("abc"), "0 B");
  }

  console.log("\nrenders /stats into the DOM:");
  {
    const { els, tick } = loadDashboard({
      viewers: 4, httpBytes: 94.4 * 1024 * 1024, p2pBytes: 167.5 * 1024 * 1024,
      uploadBytes: 171.1 * 1024 * 1024, offloadRatio: 0.64,
    });
    await tick();
    check("offload rounded to whole percent", els.offload.textContent, "64%");
    check("bar width matches percent", els.bar.style.width, "64%");
    check("viewers", els.viewers.textContent, 4);
    check("http formatted", els.http.textContent, "94.4 MB");
    check("p2p formatted", els.p2p.textContent, "167.5 MB");
    check("upload formatted", els.upload.textContent, "171.1 MB");
  }

  console.log("\nedge ratios round correctly (the headline number):");
  {
    for (const [ratio, want] of [[0, "0%"], [1, "100%"], [0.005, "1%"], [0.004, "0%"], [0.796, "80%"]]) {
      const { els, tick } = loadDashboard({ viewers: 1, httpBytes: 0, p2pBytes: 0, uploadBytes: 0, offloadRatio: ratio });
      await tick();
      check(`ratio ${ratio} -> ${want}`, els.offload.textContent, want);
    }
  }

  console.log("\na failed /stats fetch does not crash the poll loop:");
  {
    const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
    const els = {};
    for (const id of ["offload", "bar", "viewers", "http", "p2p", "upload"]) els[id] = { textContent: "init", style: {} };
    const captured = {};
    const fn = new Function("document", "fetch", "setInterval", "window", m[1]);
    fn({ getElementById: (id) => els[id] }, async () => { throw new Error("server down"); },
       (f) => { captured.fn = f; return 1; }, {});
    let threw = false;
    try { await captured.fn(); } catch { threw = true; }
    check("tick swallows the error", threw, false);
    check("last-known value left intact", els.offload.textContent, "init");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
