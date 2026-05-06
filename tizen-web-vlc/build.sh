#!/usr/bin/env bash
# Package VLC TV Web App as a .wgt for Samsung Tizen TV.
#
# Output: dist/madebypatk-vlctv.wgt
#
# Sign the resulting .wgt with your Samsung distributor cert before installing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/tizen-web-vlc"
OUT="${ROOT}/dist/madebypatk-vlcweb.wgt"

# Use the existing app icon from the native attempt
cp -f "${ROOT}/res/vlctv.png" "${SRC}/icon.png"

mkdir -p "${ROOT}/dist"
rm -f "${OUT}"

cd "${SRC}"
zip -rq "${OUT}" \
    config.xml \
    index.html \
    icon.png \
    css \
    js

# Quick sanity-check: warn if Debug is still enabled in a "release" build
if grep -q '^    var DEBUG    = true;' js/debug.js 2>/dev/null; then
    echo "  (debug telemetry to 192.168.2.22:9999 is ENABLED — flip the flag in js/debug.js to disable for release)"
fi

ls -lh "${OUT}"
echo ""
echo "Sign and install:"
echo "  sdb connect 192.168.2.23"
echo "  sdb install ${OUT}"
