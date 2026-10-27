#!/usr/bin/env bash
# Checks the VPS scripts: syntax, identical validators, the real build passes, bad payloads fail.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in ops/*; do bash -n "$f"; done
v() { sed -n '/BEGIN validate_payload/,/END validate_payload/p' "$1"; }
diff <(v ops/layercraft-deploy) <(v ops/layercraft-install-root) >/dev/null || { echo "validators differ" >&2; exit 1; }
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
bash tools/pack.sh "$t/ok.tgz" >/dev/null
bash ops/layercraft-install-root --validate-only "$t/ok.tgz" >/dev/null || { echo "real build rejected" >&2; exit 1; }
bad() { # <name> <setup in $t/b>
  rm -rf "$t/b"; mkdir -p "$t/b"; cp VERSION "$t/b/"; echo x > "$t/b/index.html"; ( cd "$t/b" && eval "$2" )
  ( cd "$t/b" && tar -czf "$t/bad.tgz" * ) 2>/dev/null
  if bash ops/layercraft-install-root --validate-only "$t/bad.tgz" >/dev/null 2>&1; then echo "accepted bad payload: $1" >&2; exit 1; fi
}
bad symlink 'mkdir assets && ln -s /etc/passwd assets/a.js'
bad extra 'echo x > evil.sh'
bad hidden 'mkdir assets && echo x > assets/.htaccess'
bad type 'mkdir assets && echo x > assets/run.php'
bad folder 'mkdir -p other && echo x > other/a.js'
bad noindex 'rm index.html'
echo "ops checks pass"
