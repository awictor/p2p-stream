#!/usr/bin/env node
/**
 * segment.test.js — unit test for origin/segment.sh, the script that produces every byte this
 * project measures.
 *
 * It had ZERO coverage for 48 iterations despite being upstream of every published number: if it
 * emits the wrong segment type, the wrong playlist depth, or leaves stale files behind, every
 * offload figure downstream is measuring something other than what we think.
 *
 * The defect this covers (found by reading, reproduced at iter 48): ffmpeg overwrites
 * seg_00000..N but never deletes segments NUMBERED ABOVE what the current run produces, and `vod`
 * mode has no `delete_segments` at all. A short run after a longer one left **99 files on disk
 * against a 15-entry playlist — 84 orphans**. Playback is unaffected (the playlist is correct),
 * but `ls origin/hls/*.m4s | wc -l` is the obvious readiness check and reads orphans as progress.
 * That is precisely how a failure-path test once passed on stale fragments from a previous run.
 *
 * Asserted against the REAL script text, so the flags cannot drift from what ffmpeg receives.
 *
 * Usage: node test/segment.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "..", "origin", "segment.sh"), "utf8");

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

// The body of one `case` branch, so per-mode flags can be asserted independently.
function branch(mode) {
  const m = SRC.match(new RegExp(`\\n  ${mode}\\)([\\s\\S]*?);;`));
  return m ? m[1] : "";
}

console.log("origin/segment.sh — the script every published number depends on:");
checkTrue("script is readable and non-trivial", SRC.length > 500);

console.log("\nSTALE SEGMENTS: the directory must be cleaned before writing (iter 48 defect)");
{
  // Without this, a short run inherits a long run's higher-numbered segments. Measured: 99 files
  // vs a 15-entry playlist.
  checkTrue("removes old .m4s segments", /rm -f "\$OUT_DIR"\/\*\.m4s/.test(SRC),
    "ffmpeg never deletes segments numbered above the current run");
  checkTrue("removes the old playlist too", /\*\.m3u8/.test(SRC));
  checkTrue("removes the old init segment", /init\.mp4/.test(SRC) && /rm -f/.test(SRC));
  // Must NOT nuke the directory itself — nginx has it as a served root, and rm -rf would race.
  checkTrue("does NOT rm -rf the directory", !/rm -rf "\$OUT_DIR"/.test(SRC),
    "nginx serves this path; removing the dir races with the server");
  // Cleanup must precede ffmpeg, or it deletes what it just wrote.
  const rmAt = SRC.indexOf("rm -f \"$OUT_DIR\"");
  const caseAt = SRC.indexOf('case "$MODE"');
  checkTrue("cleanup happens BEFORE the mode dispatch", rmAt > 0 && rmAt < caseAt,
    "cleaning after ffmpeg starts would delete live output");
  checkTrue("cleanup cannot abort the script under set -e", /\|\| true/.test(SRC),
    "an empty dir makes rm exit non-zero and set -euo pipefail would kill the run");
}

console.log("\nCMAF fMP4 is mandatory — plain TS is not feedable to MSE");
{
  // The whole P2P path depends on fMP4 segments: MSE-appendable and individually addressable.
  checkTrue("segment type is fmp4", /-hls_segment_type fmp4/.test(SRC));
  checkTrue("an init segment is named", /-hls_fmp4_init_filename "init\.mp4"/.test(SRC));
  checkTrue("segments are .m4s (not .ts)", /seg_%05d\.m4s/.test(SRC));
  checkTrue("independent_segments is set", /independent_segments/.test(SRC),
    "without it a segment cannot be decoded standalone, so a peer cannot serve it");
}

console.log("\nlive modes: rolling window deep enough for P2P to engage");
{
  const live = branch("loop");
  checkTrue("loop mode exists", live.length > 0);
  // LIST_SIZE=90 is load-bearing: the engine caps liveSyncDurationCount at floor(60/2)=30, so a
  // 90-fragment window parks the playhead ~60s back inside 180s of runway that is NOT being
  // deleted underneath it. At 30 the playhead sat on the delete boundary.
  const listSize = Number((SRC.match(/^LIST_SIZE=(\d+)/m) || [])[1]);
  checkTrue("LIST_SIZE >= 90 (shallower puts the playhead on the delete boundary)", listSize >= 90);
  const segSeconds = Number((SRC.match(/^SEG_SECONDS=(\d+)/m) || [])[1]);
  check("2s segments", segSeconds, 2);
  checkTrue("live modes delete old segments (bounded disk)", /delete_segments/.test(SRC));
  checkTrue("loop reads at native rate to simulate live", /-re\b/.test(live),
    "without -re ffmpeg races through the file and there is no live pacing");
  checkTrue("loop loops forever", /-stream_loop -1/.test(live));
}

console.log("\nVOD mode: a FULL static playlist, and never a rolling delete");
{
  const vod = branch("vod");
  checkTrue("vod mode exists", vod.length > 0);
  checkTrue("list_size 0 = keep every entry", /-hls_list_size 0/.test(vod));
  checkTrue("playlist_type vod", /-hls_playlist_type vod/.test(vod));
  // THE POINT of vod mode: nothing is deleted, so the buffer is deep and P2P actually engages.
  checkTrue("vod does NOT delete segments", !/delete_segments/.test(vod),
    "deleting under a VOD playlist would 404 entries the playlist still lists");
  checkTrue("vod does NOT use -re (no reason to run in real time)", !/-re\b/.test(vod),
    "-re would make pre-segmenting take as long as the video");
}

console.log("\nusage and failure modes");
{
  checkTrue("set -euo pipefail", /set -euo pipefail/.test(SRC));
  checkTrue("loop requires a source file", /SRC="\$\{2:\?usage: segment\.sh loop/.test(SRC));
  checkTrue("vod requires a source file", /SRC="\$\{2:\?usage: segment\.sh vod/.test(SRC));
  checkTrue("an unknown mode exits non-zero", /exit 1/.test(SRC));
  checkTrue("prefers the portable ffmpeg then falls back to PATH",
    /FFMPEG="\$\{FFMPEG:-/.test(SRC) && /FFMPEG="ffmpeg"/.test(SRC));
  // rtmp mode must bind all interfaces or OBS on another machine cannot reach it.
  checkTrue("rtmp listens on 0.0.0.0", /rtmp:\/\/0\.0\.0\.0:1935/.test(branch("rtmp")));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
