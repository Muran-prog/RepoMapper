#!/usr/bin/env bash
# Common helpers sourced by every build-*.sh script.
#
# Centralises:
#   • bash safety flags (-euo pipefail, IFS)
#   • prerequisite checks (`need cmd1 cmd2 …`)
#   • bbox extraction from src/config.js (CARPATHIAN.bbox)
#   • work-directory creation under tools/.work/<name>/
#   • final-URL hint print

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/tools"
WORK_ROOT="$TOOLS_DIR/.work"
mkdir -p "$WORK_ROOT"

# --- prerequisite check ----------------------------------------------------
need() {
  local missing=0
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "missing dependency: $c" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "install the tools above and re-run." >&2
    exit 127
  fi
}

# --- read CARPATHIAN.bbox from src/config.js -------------------------------
# Returns "w s e n" space-separated. Greps the bbox: [w, s, e, n] line from
# the frozen CARPATHIAN object — keep that line formatted accordingly.
carpathian_bbox() {
  local cfg="$REPO_ROOT/src/config.js"
  if [ ! -f "$cfg" ]; then
    echo "could not find $cfg" >&2
    return 1
  fi
  # Match e.g.  bbox: [22.0, 47.6, 27.0, 49.5],
  awk '
    /^export const CARPATHIAN/ { inside = 1 }
    inside && /bbox:[[:space:]]*\[/ {
      gsub(/[^0-9.,\-]/, "")
      gsub(/,/, " ")
      print
      exit
    }
  ' "$cfg"
}

# --- working-directory factory --------------------------------------------
work_dir() {
  local name="$1"
  local d="$WORK_ROOT/$name"
  mkdir -p "$d"
  echo "$d"
}

# --- final URL hint --------------------------------------------------------
final_url_hint() {
  local archive="$1"
  local config_key="$2"
  cat <<EOF

----------------------------------------------------------------------
Built: $archive
----------------------------------------------------------------------
Upload to any static HTTPS host that supports Range requests, then set:

   $config_key = 'pmtiles://https://your-host.example.com/$(basename "$archive")';

in src/config.js. Reload the map to pick up the new source.
EOF
}
