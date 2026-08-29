#!/usr/bin/env bash
# Capture 1280x800 stills of preview.html (needs a GPU; headless often yields black WebGL).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/store/screenshots"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
port="${PORT:-8765}"
mkdir -p "$out"
cd "$root"
python3 -m http.server "$port" --bind 127.0.0.1 >/tmp/scviz-http.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
sleep 0.4
for mode in pulse ridge bloom magnetosphere; do
  dest="$out/${mode}.png"
  "$chrome" --hide-scrollbars --window-size=1280,800 \
    --screenshot="$dest" \
    "http://127.0.0.1:${port}/preview.html?mode=${mode}&hide=1&seed=1831565813" \
    || true
  echo "$dest"
done
echo "Prefer a headed Chrome window if shots are black. CWS size must be 1280x800 or 640x400."
