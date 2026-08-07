#!/usr/bin/env bash
# Launch nginx with our conf. Prefers local portable nginx (bin/), else PATH.
# nginx -p sets the prefix; access log + temp dirs are created relative to it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGIN="$ROOT/origin"

NGINX="${NGINX:-$ROOT/bin/nginx-1.27.4/nginx.exe}"
[ -x "$NGINX" ] || NGINX="nginx"

mkdir -p "$ORIGIN/logs" "$ORIGIN/temp" "$ORIGIN/hls"

# -p prefix = origin/ ; all relative paths in nginx.conf resolve under it.
exec "$NGINX" -p "$ORIGIN" -c "$ORIGIN/nginx.conf"
