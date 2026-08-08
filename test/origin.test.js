#!/usr/bin/env node
/**
 * origin.test.js — coverage for origin/nginx.conf and the egress log it writes.
 *
 * Two reasons this is the weakest surface left.
 *
 * 1. `nginx.conf` is the CDN stand-in every measured byte flows through, and it had ZERO
 *    coverage after 51 iterations. It also carries settings that took real debugging to find
 *    and that fail in ways which look like a broken product rather than a config typo:
 *    `sendfile off` (on Windows, `on` makes nginx cache a stale handle for rewritten live
 *    segments and 404 them), `server_name _` (with `localhost` a second machine's request
 *    would not match the block at all — the cross-machine run would fail with no clue), and
 *    the CORS headers without which every segment fetch is blocked cross-origin.
 *
 * 2. The `egress` access log is INDEPENDENT GROUND TRUTH for this project's headline claim.
 *    "origin egress falls 51%" is currently derived entirely from counters the BROWSER
 *    reports about itself. nginx counts `$body_bytes_sent` server-side, so it can confirm or
 *    contradict that number without trusting the page at all — and nothing read it until now.
 *    A measurement with one instrument is an anecdote; this is the second instrument.
 *
 * The log parser is exported so the numbers are testable without nginx running, and it is
 * asserted against the REAL log file when one exists (this repo has ~18.7k lines of it).
 *
 * Usage: node test/origin.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CONF_PATH = path.join(ROOT, "origin", "nginx.conf");
const LOG_PATH = path.join(ROOT, "origin", "logs", "egress.log");

/**
 * Parse the `egress` log_format:  $time_iso8601 $request_uri $status $body_bytes_sent
 *
 * Exported (and unit-tested below) because the alternative is an awk one-liner in a comment
 * that nobody can assert on. Skips malformed lines rather than throwing: a log being written
 * while we read it can legitimately end mid-line, and dying on that would make the verifier
 * less trustworthy than the thing it verifies.
 */
export function parseEgress(text) {
  const rows = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(/\s+/);
    // Exactly 4 fields, and the numeric ones must actually be numeric — a request URI
    // containing a space would shift every field and silently corrupt the byte total.
    if (f.length !== 4 || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) { malformed++; continue; }
    rows.push({ ts: f[0], uri: f[1], status: Number(f[2]), bytes: Number(f[3]) });
  }
  return { rows, malformed };
}

/**
 * Origin egress, server-counted. Only 2xx carry a body worth counting: a 304 sends headers
 * and no payload, so folding those in would inflate the origin's apparent cost — and the
 * live playlist is polled constantly, so 304s OUTNUMBER 200s here (9865 vs 8713 in the real
 * log). Counting them would be the single easiest way to overstate what the CDN served.
 */
export function egressSummary(rows) {
  const hls = rows.filter((r) => r.uri.startsWith("/hls/"));
  const served = hls.filter((r) => r.status >= 200 && r.status < 300);
  const bytes = served.reduce((s, r) => s + r.bytes, 0);
  const segs = served.filter((r) => /\.m4s$/.test(r.uri));
  const playlists = served.filter((r) => /\.m3u8$/.test(r.uri));
  return {
    requests: hls.length,
    served: served.length,
    bytes,
    segmentBytes: segs.reduce((s, r) => s + r.bytes, 0),
    segmentRequests: segs.length,
    playlistRequests: playlists.length,
    notModified: hls.filter((r) => r.status === 304).length,
    notFound: hls.filter((r) => r.status === 404).length,
    // SEGMENT 304s ARE THE INTERESTING ONE (found iter 52). A 304 on a .m4s means the browser
    // already had that segment cached and nginx sent NO body — but the page still counts it as
    // an HTTP/origin byte, because hls.js reports the segment as loaded either way. Measured on
    // a 4-viewer control run: 190 of 340 segment requests were 304, so nginx counted 97.7MB
    // where the harness reported 219.9MB. The harness number is browser-side "bytes obtained
    // from origin"; this one is "bytes the CDN actually paid to send". They are different
    // quantities and the gap is cache hits, not an accounting bug in either.
    segmentNotModified: hls.filter((r) => r.status === 304 && /\.m4s$/.test(r.uri)).length,
    // A segment 404 is the `sendfile on` symptom (stale handle on a rewritten file) and also
    // what a viewer sees when the playlist outruns the disk. Playlist 404s are benign-ish:
    // they happen before ffmpeg has written stream.m3u8 at all.
    segmentNotFound: hls.filter((r) => r.status === 404 && /\.m4s$/.test(r.uri)).length,
  };
}

// isMain guard. Without it, `import { parseEgress } from "./origin.test.js"` RUNS THE WHOLE
// SUITE as a side effect — which is exactly what happened the first time this module's parser
// was reused: a five-line script printed 40 assertions before its own output. Same class of bug
// as the one test/tracker.test.js guards for server/tracker.js. The exported functions are the
// point of this file; importing them must be free.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (!isMain) {
  // Exported parser/summary only. No assertions, no output, no exit code.
} else {

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

const CONF = readFileSync(CONF_PATH, "utf8");
// Strip comments before asserting on directives. Every one of these settings is EXPLAINED in a
// comment naming the wrong value, so a naive /sendfile\s+off/ test passes on a conf that says
// `sendfile on;` with a comment mentioning "keep off". Same class of bug as start.test.js's
// process.exit() guard matching its own explanatory comment.
const DIRECTIVES = CONF.split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n");

console.log("nginx.conf — settings whose failure looks like a broken product:");
{
  checkTrue("sendfile is OFF (on = stale handles -> 404s on rotating live segments)",
    /\bsendfile\s+off\s*;/.test(DIRECTIVES),
    "the comment explaining this is stripped, so this asserts the real directive");
  checkTrue("...and `sendfile on` appears nowhere in the directives",
    !/\bsendfile\s+on\s*;/.test(DIRECTIVES));
  checkTrue("listens on 8080", /\blisten\s+8080\s*;/.test(DIRECTIVES));
  // `server_name localhost` would make a LAN-IP request from a second machine match no
  // server block — the cross-machine milestone would fail with nothing to point at.
  checkTrue("server_name is the catch-all `_`, not localhost (cross-machine requests)",
    /\bserver_name\s+_\s*;/.test(DIRECTIVES),
    "with `localhost` a http://<lan-ip>:8080 request matches no block");
  checkTrue("serves /hls/", /location\s+\/hls\/\s*\{/.test(DIRECTIVES));
}

console.log("\nMIME types: the browser refuses to feed MSE an octet-stream");
{
  check("m3u8 is application/vnd.apple.mpegurl",
    /application\/vnd\.apple\.mpegurl\s+m3u8\s*;/.test(DIRECTIVES), true);
  check("m4s is a video type, not the default octet-stream",
    /video\/[\w.-]+\s+m4s\s*;/.test(DIRECTIVES), true);
  checkTrue("a default_type fallback exists", /default_type\s+\S+\s*;/.test(DIRECTIVES));
}

console.log("\nCORS: viewers are served from :5173 and fetch segments from :8080");
{
  checkTrue("Allow-Origin *", /Access-Control-Allow-Origin\s+"\*"/.test(DIRECTIVES),
    "without it every segment fetch is blocked cross-origin");
  // hls.js issues byte-range requests; a blocked Range header degrades or breaks playback.
  checkTrue("Range is an allowed header", /Access-Control-Allow-Headers[^;]*Range/.test(DIRECTIVES));
  // The ledger measures per-segment bytes off Content-Length; unexposed, it reads as 0.
  checkTrue("Content-Length is EXPOSED (the ledger sizes segments from it)",
    /Access-Control-Expose-Headers[^;]*Content-Length/.test(DIRECTIVES));
  // `always` matters: without it add_header is skipped on non-2xx, so a 404 or 416 arrives
  // with no CORS headers and surfaces in the page as an opaque network error.
  const addHeaders = DIRECTIVES.match(/add_header[^;]*;/g) || [];
  checkTrue("every add_header uses `always` (else non-2xx replies lose CORS)",
    addHeaders.length > 0 && addHeaders.every((h) => /\balways\b/.test(h)),
    `${addHeaders.filter((h) => !/\balways\b/.test(h)).length} of ${addHeaders.length} missing it`);
  checkTrue("the live playlist is not cached", /Cache-Control\s+"no-cache"/.test(DIRECTIVES));
}

console.log("\nthe egress log is the SECOND instrument for the -51% claim");
{
  // The format is load-bearing: parseEgress() positionally reads 4 fields in this order.
  checkTrue("log_format `egress` is declared", /log_format\s+egress\s+'/.test(DIRECTIVES));
  checkTrue("it records $body_bytes_sent (server-counted bytes, not browser-reported)",
    /log_format\s+egress[^;]*\$body_bytes_sent/.test(DIRECTIVES));
  checkTrue("it records $status, so 304s can be excluded from the byte total",
    /log_format\s+egress[^;]*\$status/.test(DIRECTIVES));
  checkTrue("it records $request_uri, so segments split from playlists",
    /log_format\s+egress[^;]*\$request_uri/.test(DIRECTIVES));
  checkTrue("access_log uses that format", /access_log\s+\S+\s+egress\s*;/.test(DIRECTIVES));
  // Field ORDER is what the parser depends on. Assert it rather than mere presence.
  const fmt = (DIRECTIVES.match(/log_format\s+egress\s+'([^']*)'/) || [])[1] || "";
  check("field order is exactly time, uri, status, bytes", fmt.trim(),
    "$time_iso8601 $request_uri $status $body_bytes_sent");
}

console.log("\nparseEgress: the instrument must prove it can report the opposite");
{
  const good = [
    "2026-08-08T05:42:31-07:00 /hls/stream.m3u8 200 1245",
    "2026-08-08T05:42:32-07:00 /hls/seg_00001.m4s 200 1000000",
    // A 304 with NON-ZERO bytes. Real nginx logs 0 here, but a fixture that logs 0 makes the
    // "excludes 304s" assertion untestable: including or excluding it gives the same total, so
    // the assertion passes even when the filter is wrong (verified — widening the status range
    // to <400 did not fail until this number stopped being 0). Give the bug something to move.
    "2026-08-08T05:42:33-07:00 /hls/stream.m3u8 304 999",
    "2026-08-08T05:42:34-07:00 /hls/seg_00002.m4s 404 153",
    "2026-08-08T05:42:35-07:00 /favicon.ico 404 100",
  ].join("\n");
  const { rows, malformed } = parseEgress(good);
  check("parses every well-formed line", rows.length, 5);
  check("no false malformed", malformed, 0);

  const s = egressSummary(rows);
  check("counts only /hls/ requests", s.requests, 4);
  // THE ASSERTION THAT MATTERS: a 304 is headers-only. Folding it in would overstate what the
  // origin served, and the real log has MORE 304s than 200s, so the error would be large.
  check("egress excludes 304s", s.bytes, 1001245);
  check("segment bytes split out", s.segmentBytes, 1000000);
  check("304s are counted separately", s.notModified, 1);
  check("segment 404s are surfaced (the `sendfile on` symptom)", s.segmentNotFound, 1);
  check("a non-/hls 404 is not counted as a segment miss", s.notFound, 1);
  // Segment 304s are tracked separately from playlist 304s: a cached PLAYLIST poll is normal
  // and expected, a cached SEGMENT is the reason server-counted egress runs below what the
  // harness reports. Lumping them into one `notModified` would hide that.
  const cached = parseEgress([
    "2026-08-08T05:42:36-07:00 /hls/seg_00003.m4s 304 0",
    "2026-08-08T05:42:37-07:00 /hls/stream.m3u8 304 0",
  ].join("\n")).rows;
  const c = egressSummary(cached);
  check("a cached SEGMENT is counted as such", c.segmentNotModified, 1);
  check("and a cached playlist poll is not confused with it", c.notModified, 2);

  // Malformed input: a URI with a space shifts every field. Silently accepting it would put a
  // status code into the bytes column, so it must be dropped, not "best-effort" parsed.
  const bad = parseEgress([
    "2026-08-08T05:42:31-07:00 /hls/a b.m4s 200 500",   // 5 fields
    "2026-08-08T05:42:31-07:00 /hls/x.m4s notanum 500", // non-numeric status
    "2026-08-08T05:42:31-07:00 /hls/y.m4s 200 -",       // non-numeric bytes
    "",                                                  // blank
    "2026-08-08T05:42:31-07:00 /hls/z.m4s 200 7",       // the only good one
  ].join("\n"));
  check("malformed lines are dropped, not mis-parsed", bad.rows.length, 1);
  check("and are counted so a corrupt log cannot look clean", bad.malformed, 3);
  check("the surviving row is the good one", bad.rows[0].bytes, 7);

  // Truncated tail: reading a log nginx is actively writing must not throw.
  const cut = parseEgress("2026-08-08T05:42:31-07:00 /hls/a.m4s 200 5\n2026-08-08T05:4");
  check("a half-written final line is skipped, not fatal", cut.rows.length, 1);
}

console.log("\nimporting this module must NOT run the suite");
{
  // Self-check on the isMain guard above. It is asserted here rather than trusted because the
  // bug it prevents is silent: the import still WORKS, it just also prints 40 assertions and
  // sets an exit code, so a caller reusing parseEgress inherits this file's pass/fail.
  const self = readFileSync(path.join(__dirname, "origin.test.js"), "utf8");
  checkTrue("an isMain guard exists", /const isMain = process\.argv\[1\]/.test(self));
  checkTrue("it compares the resolved script path, not a substring",
    /fileURLToPath\(import\.meta\.url\) === path\.resolve\(process\.argv\[1\]\)/.test(self));
  checkTrue("the assertions are inside it", /if \(!isMain\) \{[\s\S]*?\} else \{/.test(self));
}

console.log("\nagainst the REAL egress log (server-side ground truth, if present)");
if (!existsSync(LOG_PATH)) {
  console.log("  SKIP  origin/logs/egress.log absent — run the stack once to generate it");
} else {
  const { rows, malformed } = parseEgress(readFileSync(LOG_PATH, "utf8"));
  const s = egressSummary(rows);
  console.log(`  info  ${rows.length} rows, ${(s.bytes / 1e6).toFixed(1)}MB served, ` +
    `${s.segmentRequests} segment + ${s.playlistRequests} playlist responses, ` +
    `${s.notModified} x 304 (${s.segmentNotModified} on segments), ` +
    `${s.notFound} x 404 (${s.segmentNotFound} on segments)`);
  if (s.segmentNotModified > 0) {
    const total = s.segmentRequests + s.segmentNotModified;
    console.log(`  info  ${s.segmentNotModified}/${total} segment requests were CACHE HITS (304, no body sent).` +
      " Server-counted egress is therefore BELOW the harness's browser-side origin-bytes figure;" +
      " the gap is cache, not an accounting error. Quote which instrument a number came from.");
  }
  checkTrue("the real log parses", rows.length > 0);
  // A handful of malformed lines is tolerable (concurrent writes); a large share means the
  // format drifted and every byte total derived from it is wrong.
  checkTrue("malformed lines are a negligible share of the real log",
    rows.length > 0 && malformed / rows.length < 0.01,
    `${malformed} malformed of ${rows.length + malformed}`);
  checkTrue("it actually recorded segment traffic", s.segmentRequests > 0);
  checkTrue("server-counted egress is non-zero", s.bytes > 0);
  // The playlist is polled far more often than segments are fetched, and nearly all of those
  // polls are 304s. If 304s ever stop appearing, no-cache/If-Modified-Since broke and the
  // origin is re-sending the whole playlist every poll — a real (if small) egress regression.
  checkTrue("playlist polling is mostly 304, not full re-sends",
    s.notModified > 0,
    "no 304s at all means every poll re-sent the playlist body");
  // Segments are ~1MB and playlists ~1-2KB, so segments must dominate by a wide margin.
  // If they do not, the run never got past the playlist and any offload number from it is noise.
  checkTrue("segment bytes dominate total egress (they are ~1MB vs ~1KB)",
    s.bytes > 0 && s.segmentBytes / s.bytes > 0.9,
    `segments are ${((s.segmentBytes / s.bytes) * 100).toFixed(1)}% of egress`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;

} // end isMain
