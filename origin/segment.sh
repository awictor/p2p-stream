#!/usr/bin/env bash
# Origin segmenter: produce LL-HLS CMAF (fMP4) segments from a source into ./hls,
# served statically by nginx (see nginx.conf). This is the CDN stand-in.
#
# Two modes:
#   ./segment.sh loop  <file.mp4>   # loop a local file forever -> live HLS (demo, no OBS needed)
#   ./segment.sh rtmp               # ingest RTMP from OBS at rtmp://<host>:1935/live/stream
#
# Segments land in ./hls/stream.m3u8 + *.m4s. Viewers load stream.m3u8 through hls.js.
set -euo pipefail

MODE="${1:-loop}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/hls"
mkdir -p "$OUT_DIR"

# START FROM A CLEAN DIRECTORY. ffmpeg overwrites seg_00000..N but never removes segments
# NUMBERED ABOVE what this run produces, and `vod` mode has no `delete_segments` at all. So a
# short run after a longer one leaves orphans: measured 99 files on disk against a 15-entry
# playlist — 84 stale segments.
#
# The playlist itself stays correct, so playback is unaffected. The damage is to MEASUREMENT:
# `ls origin/hls/*.m4s | wc -l` is the obvious way to check "is the origin ready yet", and it
# silently reads the orphans as progress. That is how a failure-path test once passed on stale
# fragments from a previous run. Delete segments + playlist, keep the directory.
rm -f "$OUT_DIR"/*.m4s "$OUT_DIR"/*.m3u8 "$OUT_DIR"/init.mp4 2>/dev/null || true

# Prefer local portable ffmpeg (bin/), else fall back to PATH.
FFMPEG="${FFMPEG:-$ROOT/bin/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe}"
[ -x "$FFMPEG" ] || FFMPEG="ffmpeg"

# 2s segments: big enough that peers have time to fetch+relay a segment before a
# neighbor needs it (offload window). Shrink toward LL-HLS parts later for lower latency.
SEG_SECONDS=2
# Deep live window. P2P only engages for segments BEYOND the high-demand zone (nearest
# 15s, always HTTP), and the core also zeroes both download windows unless the viewer
# holds >5 segments ahead. Playlist depth is what buys that runway.
#
# The engine sets liveSyncDurationCount = min(fragments-1, floor(60/SEG_SECONDS)), so with
# 2s segments it caps at 30 no matter how long the playlist is. At LIST_SIZE=30 that gave
# min(29,30)=29 -> the playhead sits 58s back in a 60s window, right on the boundary where
# delete_segments is erasing fragments behind it; measured buffer only reached 14.4s, just
# under the 15s high-demand window. At LIST_SIZE=90 the cap binds at 30 instead, parking the
# playhead 60s back in a 180s window: ~120s of runway that is NOT being deleted underneath.
# Costs disk (90 x ~1MB) and nothing else; ffmpeg still deletes beyond the window.
LIST_SIZE=90

common_hls_flags=(
  -c:v libx264 -preset veryfast -tune zerolatency -g $((SEG_SECONDS*30)) -sc_threshold 0
  -c:a aac -b:a 128k
  -f hls
  -hls_time "$SEG_SECONDS"
  -hls_list_size "$LIST_SIZE"
  -hls_flags delete_segments+independent_segments+program_date_time
  -hls_segment_type fmp4                      # CMAF fMP4 -> feedable to MSE, P2P-addressable
  -hls_fmp4_init_filename "init.mp4"
  -hls_segment_filename "$OUT_DIR/seg_%05d.m4s"
  "$OUT_DIR/stream.m3u8"
)

case "$MODE" in
  loop)
    SRC="${2:?usage: segment.sh loop <file.mp4>}"
    echo "[origin] looping $SRC -> $OUT_DIR/stream.m3u8 (Ctrl-C to stop)"
    # -re = read input at native frame rate (simulate live); -stream_loop -1 = forever
    exec "$FFMPEG" -hide_banner -loglevel warning -re -stream_loop -1 -i "$SRC" "${common_hls_flags[@]}"
    ;;
  rtmp)
    echo "[origin] listening rtmp://0.0.0.0:1935/live/stream -> $OUT_DIR/stream.m3u8"
    echo "         point OBS at that URL, stream key: stream"
    exec "$FFMPEG" -hide_banner -loglevel warning \
      -listen 1 -i "rtmp://0.0.0.0:1935/live/stream" "${common_hls_flags[@]}"
    ;;
  vod)
    # VOD: pre-segment a file into a FULL static playlist (no rolling window, no
    # delete). This gives viewers a deep buffer, which is what actually exercises P2P:
    # the engine only pulls segments beyond the ~5-segment high-demand zone over P2P.
    # A live edge holds only ~3 segments ahead, so on localhost every segment is
    # "urgent" and served by the infinitely-fast origin -> P2P never engages. VOD
    # sidesteps that and demonstrates real peer-to-peer offload. See README.
    SRC="${2:?usage: segment.sh vod <file.mp4>}"
    echo "[origin] segmenting $SRC -> full VOD playlist at $OUT_DIR/stream.m3u8"
    exec "$FFMPEG" -hide_banner -loglevel warning -i "$SRC" \
      -c:v libx264 -preset veryfast -g $((SEG_SECONDS*30)) -sc_threshold 0 \
      -c:a aac -b:a 128k \
      -f hls -hls_time "$SEG_SECONDS" -hls_list_size 0 -hls_playlist_type vod \
      -hls_flags independent_segments \
      -hls_segment_type fmp4 -hls_fmp4_init_filename "init.mp4" \
      -hls_segment_filename "$OUT_DIR/seg_%05d.m4s" \
      "$OUT_DIR/stream.m3u8"
    ;;
  *)
    echo "usage: segment.sh [loop <file.mp4> | rtmp | vod <file.mp4>]" >&2
    exit 1
    ;;
esac
