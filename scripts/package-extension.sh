#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/store/dist"
name="scviz"
version="$(python3 -c "import json; print(json.load(open('$root/manifest.json'))['version'])")"
mkdir -p "$out"
zipfile="$out/${name}-${version}.zip"
rm -f "$zipfile"
(
  cd "$root"
  zip -r "$zipfile" \
    manifest.json \
    background.js \
    icons \
    src \
    -x "*.DS_Store" \
    -x "src/**/.DS_Store"
)
echo "Wrote $zipfile ($(wc -c < "$zipfile" | tr -d ' ') bytes)"
echo "Load unpacked from a unzip of this archive, or upload it to the Chrome Web Store."
