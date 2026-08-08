#!/usr/bin/env bash
# start.sh — bring the whole stack up with one command.
#
# Replaces the four-terminal dance in the README. Starts the origin segmenter, nginx,
# the tracker+metrics server and the viewer web server, then WAITS FOR REAL READINESS
# before printing URLs — readiness means "the playlist has enough fragments that the
# offload harness is meaningful", not "the process launched". A booting server is not
# a working stream, and handing someone a URL that 404s is the fastest way to make a
# working project look broken.
#
# Usage:
#   bash start.sh                       # loop origin/sample.mp4 as a fake live stream
#   bash start.sh vod origin/vod.mp4    # one-shot VOD segmenting (no ~180s live fill wait)
#   bash start.sh rtmp                  # ingest OBS at rtmp://localhost:1935/live/stream
#
# Ctrl-C stops everything it started (and only what it started).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE="${1:-loop}"
SRC="${2:-}"
LOGS="$ROOT/origin/logs"
mkdir -p "$LOGS"

# Live mode needs enough fragments for P2P to have runway; VOD is segmented up front so
# the playlist is complete the moment ffmpeg exits. Below this the harness measures noise.
MIN_FRAGS=20
READY_TIMEOUT=300

pids=()
# Both INT and EXIT fire on Ctrl-C, so guard or the teardown prints twice and reads like
# something went wrong on the way out.
cleaned=0
cleanup() {
  [ "$cleaned" -eq 1 ] && return
  cleaned=1
  echo ""
  echo "[start] shutting down..."
  rm -f "$ROOT/.probe.mjs" 2>/dev/null
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null; done
  # nginx daemonises off our process tree, so a kill on our PIDs never reaches it.
  "$ROOT/bin/nginx-1.27.4/nginx.exe" -p "$ROOT/origin" -c "$ROOT/origin/nginx.conf" -s stop 2>/dev/null \
    || nginx -p "$ROOT/origin" -c "$ROOT/origin/nginx.conf" -s stop 2>/dev/null || true
  echo "[start] done."
}
trap cleanup EXIT INT TERM

# Probe helpers. Node rather than curl (curl is not guaranteed on Windows, node is a hard
# prereq), and via a real SCRIPT FILE rather than `node -e`: an inline -e string has to survive
# both bash and node quoting, and a URL interpolated into it fails in ways that look exactly
# like "the service is down". That cost this script its first run — it tore down a stack that
# was serving 200s. The URL is passed as argv, never interpolated into code.
PROBE="$ROOT/.probe.mjs"
cat > "$PROBE" <<'PROBEJS'
// Sets process.exitCode and RETURNS — never calls process.exit(). Calling process.exit()
// while node still holds an open fetch handle trips a Windows libuv assertion
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") and exits 127 AFTER the fetch
// already succeeded. That made every origin probe here look like a dead service and tore
// down a healthy stack. Measured, not theorised.
const url = process.argv[2];
const want = process.argv[3]; // "frags" -> print fragment count instead of status
try {
  const r = await fetch(url);
  if (want === "frags") {
    const t = await r.text();
    console.log((t.match(/\.m4s/g) || []).length);
    process.exitCode = 0;
  } else {
    process.exitCode = r.ok ? 0 : 1;
  }
} catch {
  if (want === "frags") console.log(0);
  process.exitCode = 1;
}
PROBEJS

wait_http() {
  local url="$1" name="$2" tries="${3:-60}"
  for ((i = 0; i < tries; i++)); do
    if node "$PROBE" "$url" 2>/dev/null; then
      echo "[start] ok    $name"
      return 0
    fi
    sleep 1
  done
  echo "[start] FAILED $name did not come up ($url)" >&2
  echo "[start]        check origin/logs/ — the service may have logged the reason." >&2
  return 1
}

echo "[start] mode=$MODE  logs in origin/logs/"

# 1) Origin segmenter. VOD is a one-shot that must FINISH before nginx has anything to serve;
#    loop/rtmp keep running and fill the playlist as they go.
if [ "$MODE" = "vod" ]; then
  [ -n "$SRC" ] || { echo "[start] vod mode needs a source file: bash start.sh vod origin/vod.mp4" >&2; exit 1; }
  echo "[start] segmenting $SRC (one-shot, this takes a minute)..."
  if ! bash origin/segment.sh vod "$SRC" > "$LOGS/segment.log" 2>&1; then
    echo "[start] FAILED segmenting — see origin/logs/segment.log" >&2
    exit 1
  fi
  echo "[start] ok    segmenter (vod complete)"
else
  bash origin/segment.sh "$MODE" ${SRC:+"$SRC"} > "$LOGS/segment.log" 2>&1 &
  pids+=($!)
  echo "[start] ok    segmenter (pid ${pids[-1]}, filling playlist)"
fi

# 2) nginx origin.
bash origin/run-nginx.sh > "$LOGS/nginx-start.log" 2>&1 &
pids+=($!)

# 3) Tracker (also starts the metrics server in-process on :8001).
node server/tracker.js > "$LOGS/tracker.log" 2>&1 &
pids+=($!)

# 4) Viewer web server.
npx http-server web -p 5173 -c-1 --cors > "$LOGS/web.log" 2>&1 &
pids+=($!)

echo "[start] waiting for services..."
# Cheap ones first, so a genuine config error surfaces in seconds instead of behind a long wait.
wait_http "http://localhost:8001/stats"      "metrics  :8001" 30 || exit 1
wait_http "http://localhost:5173/index.html" "viewer   :5173" 30 || exit 1
# The playlist is the SLOW one and 60s is not enough: ffmpeg buffers before it writes
# stream.m3u8 at all, so in live mode the file first appeared ~90s in. A too-short timeout here
# tore down a perfectly healthy stack and reported "origin did not come up" — measured, not
# guessed (nginx logged CreateFile ... stream.m3u8 failed while ffmpeg was still starting).
echo "[start]       origin playlist can take ~90s to first appear in live mode..."
wait_http "http://localhost:8080/hls/stream.m3u8" "origin   :8080" 240 || exit 1

# Fragment count is the real readiness signal. A playlist that exists but holds 2 fragments
# will "play" and measure ~0% offload, which reads as a broken product rather than an
# impatient operator — so wait for it and SAY what we are waiting for.
echo "[start] waiting for >= $MIN_FRAGS fragments (P2P needs runway to be measurable)..."
for ((i = 0; i < READY_TIMEOUT; i++)); do
  n=$(node "$PROBE" "http://localhost:8080/hls/stream.m3u8" frags 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge "$MIN_FRAGS" ]; then
    echo "[start] ok    playlist ($n fragments)"
    break
  fi
  if [ $((i % 15)) -eq 0 ] && [ "$i" -gt 0 ]; then
    echo "[start]       $n/$MIN_FRAGS fragments (~2s of video per fragment)..."
  fi
  sleep 1
done

cat <<EOF

  READY
  ------------------------------------------------------------
  Viewer      http://localhost:5173      <- open this in 2+ tabs
  Dashboard   http://localhost:8001      <- offload % lives here
  Origin      http://localhost:8080/hls/stream.m3u8
  Tracker     ws://localhost:8000

  Measure it:
    npm run verify           real P2P bytes, pass/fail
    npm run verify:control   P2P on vs off — the honest bill reduction

  Ctrl-C stops everything.
  ------------------------------------------------------------

EOF

wait
