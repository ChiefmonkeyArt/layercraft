#!/usr/bin/env bash
# Pack dist/ plus VERSION into the release tarball the VPS installer accepts.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(realpath -m "${1:-layercraft-release.tar.gz}")"
[[ -f dist/index.html ]] || { echo "build first: npx vite build" >&2; exit 1; }
cp VERSION dist/VERSION
( cd dist && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort | tar --owner=0 --group=0 --numeric-owner --no-recursion -czf "$out" -T - )
echo "$out $(du -h "$out" | cut -f1)"
