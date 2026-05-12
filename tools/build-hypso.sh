#!/usr/bin/env bash
# Build pre-rendered hypsometric tint raster PMTiles archives — one
# per ramp preset, or all of them in a batch.
#
# Output:
#   tools/.work/hypso/<ramp-id>/<ramp-id>-<theme>-hypso.pmtiles
#
# The ramp dictionary is read straight out of `src/style/hypso/ramps.js`
# via the Node helper at `tools/dump-ramp.mjs`. That keeps the offline
# raster ramp identical to whatever the live native color-relief layer
# would render, with the same LAB densification.
#
# Usage:
#   tools/build-hypso.sh                      # builds the default ramp (patterson, light)
#   tools/build-hypso.sh --ramp=swissAlpine
#   tools/build-hypso.sh --ramp=all           # builds every preset
#   tools/build-hypso.sh --ramp=patterson --theme=dark
#   tools/build-hypso.sh --ramp=all --theme=both
#
# Environment:
#   DEM        Override the DEM source (default = carpathian-3857.tif).
#   ZOOM       gdaldem→mbtiles tile-zoom range (default = '2..12').
#   DENSIFY    Per-gap densification count (default = expression.js default).
#
# Pipeline per (ramp, theme):
#   1. Run dump-ramp.mjs to emit a gdaldem color-relief input file.
#   2. gdaldem color-relief on the DEM.
#   3. rio mbtiles → mbtiles archive.
#   4. pmtiles convert → final PMTiles archive.
#
# Graceful behaviour: if any step fails we error out for the active
# ramp and continue with the next one (when --ramp=all). At the end we
# print a summary of which archives succeeded and which failed.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# ---------------------------------------------------------------------------
# Argument parsing — handled BEFORE dep checks so --help / --list keep
# working on machines that don't have the GDAL/PMTiles toolchain.
# ---------------------------------------------------------------------------

RAMP_ARG="patterson"
THEME_ARG="light"

for arg in "$@"; do
  case "$arg" in
    --ramp=*)  RAMP_ARG="${arg#--ramp=}" ;;
    --theme=*) THEME_ARG="${arg#--theme=}" ;;
    -h|--help)
      cat <<EOF
build-hypso.sh — render hypsometric tint PMTiles archives.

  --ramp=<id>|all      Pick a ramp preset, or 'all' to render every preset.
  --theme=light|dark|both
  -h, --help

Run 'tools/dump-ramp.mjs --list' to see the available ramp ids.
EOF
      exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2 ;;
  esac
done

need gdaldem rio pmtiles node

# Resolve ramp list.
if [ "$RAMP_ARG" = "all" ]; then
  mapfile -t RAMPS < <("$REPO_ROOT/tools/dump-ramp.mjs" --list)
else
  RAMPS=("$RAMP_ARG")
fi

# Resolve theme list.
case "$THEME_ARG" in
  light|dark) THEMES=("$THEME_ARG") ;;
  both)       THEMES=(light dark) ;;
  *)          echo "unknown --theme=$THEME_ARG (expected light|dark|both)" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# DEM resolution
# ---------------------------------------------------------------------------

WORK_BASE="$(work_dir hypso)"
DEM="${DEM:-$WORK_ROOT/carpathian-dem/carpathian-3857.tif}"
ZOOM="${ZOOM:-2..12}"

if [ ! -f "$DEM" ]; then
  echo "DEM not found: $DEM" >&2
  echo "Run tools/build-carpathian-dem.sh first, or set DEM=/path/to/dem.tif" >&2
  exit 2
fi

# Pull through optional --densify=N — gdaldem's color-relief is itself
# linear-RGB, so we let dump-ramp.mjs densify in LAB space first.
DENSIFY_ARG=""
if [ -n "${DENSIFY:-}" ]; then
  DENSIFY_ARG="--densify=$DENSIFY"
fi

# ---------------------------------------------------------------------------
# Per-ramp pipeline
# ---------------------------------------------------------------------------

declare -a SUCCESS=()
declare -a FAILED=()

build_one() {
  local ramp="$1"
  local theme="$2"

  local work="$WORK_BASE/$ramp"
  mkdir -p "$work"

  local ramp_file="$work/$ramp.$theme.txt"
  local hypso_tif="$work/$ramp.$theme.hypso.tif"
  local mbtiles="$work/$ramp.$theme.mbtiles"
  local archive="$work/$ramp-$theme-hypso.pmtiles"

  echo "==> $ramp ($theme)"

  if ! "$REPO_ROOT/tools/dump-ramp.mjs" "$ramp" --theme="$theme" $DENSIFY_ARG > "$ramp_file"; then
    echo "    dump-ramp.mjs failed for $ramp" >&2
    FAILED+=("$ramp/$theme")
    return 1
  fi

  echo "    Ramp file: $ramp_file ($(wc -l <"$ramp_file") stops)"

  if ! gdaldem color-relief -of GTiff \
        -co COMPRESS=DEFLATE -co TILED=YES \
        -alpha \
        "$DEM" "$ramp_file" "$hypso_tif"; then
    FAILED+=("$ramp/$theme")
    return 1
  fi

  rm -f "$mbtiles"
  if ! rio mbtiles --format png --tile-size 256 --zoom-levels "$ZOOM" "$hypso_tif" "$mbtiles"; then
    FAILED+=("$ramp/$theme")
    return 1
  fi

  rm -f "$archive"
  if ! pmtiles convert "$mbtiles" "$archive"; then
    FAILED+=("$ramp/$theme")
    return 1
  fi

  SUCCESS+=("$archive")
  echo "    -> $archive"
}

for ramp in "${RAMPS[@]}"; do
  for theme in "${THEMES[@]}"; do
    build_one "$ramp" "$theme" || true
  done
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "----------------------------------------------------------------------"
echo "Built ${#SUCCESS[@]} archive(s); ${#FAILED[@]} failed."
echo "----------------------------------------------------------------------"
for a in "${SUCCESS[@]}"; do
  echo "  OK   $a"
done
for f in "${FAILED[@]}"; do
  echo "  FAIL $f"
done

if [ "${#SUCCESS[@]}" -gt 0 ]; then
  cat <<EOF

Upload the archives to any static HTTPS host that supports Range
requests, then map ramp ids → URLs in src/config.js:

  export const HYPSO = Object.freeze({
    ...,
    rasterUrls: Object.freeze({
      patterson:  'pmtiles://https://your-host.example.com/patterson-light-hypso.pmtiles',
      raiszHenry: 'pmtiles://https://your-host.example.com/raiszHenry-light-hypso.pmtiles',
      ...
    }),
  });

The renderer's runtime fallback (src/style/hypso/runtime.js) reads the
URL for the active ramp from this dict when the native color-relief
path isn't available.
EOF
fi

[ "${#FAILED[@]}" -eq 0 ]
