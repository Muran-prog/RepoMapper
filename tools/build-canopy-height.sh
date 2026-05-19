#!/usr/bin/env bash
# Build the ETH Global Canopy Height (Lang et al. 2023) raster PMTiles
# archive that backs the canopy-height-tint relief layer.
#
# Source: Lang, Jetz, Schindler, Wegner — "A high-resolution canopy
# height model of the Earth", Nature Ecology & Evolution (2023).
# 10 m float32 raster of canopy top height in metres, 0 = no canopy.
# License: CC BY 4.0 (attribution required).
#
# Distribution mirrors:
#
#   1. ETH GitHub releases (preferred) —
#      https://github.com/langnico/global-canopy-height-model/releases
#      3°×3° GeoTIFF tiles named
#        ETH_GlobalCanopyHeight_10m_2020_<lat><lon>_Map.tif
#      where <lat><lon> encodes the SW corner (e.g. N48E021).
#
#   2. AWS Open Data fallback —
#      s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/
#      Format may differ (Meta CHM); the script doesn't try this
#      automatically because the schema is incompatible with the
#      gdaldem ramp this build expects. Pointing ETH_CHM_DIR at a
#      local pre-warped GeoTIFF (any source) skips the network step.
#
# Output:
#   tools/.work/canopy-height/<region>-canopy.pmtiles
#
# Usage:
#   tools/build-canopy-height.sh                                 # default ukraine bbox, both themes
#   tools/build-canopy-height.sh --region=carpathian
#   tools/build-canopy-height.sh --region=ukraine --theme=light
#   tools/build-canopy-height.sh --bbox=22.0,47.6,27.0,49.5      # explicit override
#   ETH_CHM_DIR=/path/to/local/chm tools/build-canopy-height.sh  # skip download
#
# Environment:
#   ZOOM        rio mbtiles tile-zoom range (default '8..13').
#   ETH_CHM_DIR If set, read GeoTIFFs from this directory instead of
#               downloading from the GitHub release. Tile naming must
#               still match ETH_GlobalCanopyHeight_10m_2020_<lat><lon>_Map.tif.
#   ETH_RELEASE_TAG  Release tag to download from (default 'v1.0').
#
# Pipeline per (theme):
#   1. Read bbox (CARPATHIAN.bbox / Ukraine default / --bbox=…).
#   2. Enumerate 3°×3° tiles inside the bbox.
#   3. curl -L the GitHub release tiles into .work/canopy-height/raw/
#      (skipped if ETH_CHM_DIR is set).
#   4. gdalbuildvrt + gdalwarp into EPSG:3857.
#   5. gdaldem color-relief with the table from dump-canopy-ramp.mjs.
#   6. rio mbtiles → mbtiles archive.
#   7. pmtiles convert → final PMTiles.
#
# License reminder: ETH Global Canopy Height is CC BY 4.0. The
# renderer's `TERRAIN.canopyHeight.attribution` carries the canonical
# attribution string and the MapLibre attribution control surfaces it
# whenever the source is active. Operators redistributing the
# resulting tiles must keep the attribution visible.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# ---------------------------------------------------------------------------
# Argument parsing — runs BEFORE dep checks so --help works on minimal hosts.
# ---------------------------------------------------------------------------

REGION_ARG="ukraine"
THEME_ARG="both"
BBOX_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    --region=*) REGION_ARG="${arg#--region=}" ;;
    --theme=*)  THEME_ARG="${arg#--theme=}" ;;
    --bbox=*)   BBOX_OVERRIDE="${arg#--bbox=}" ;;
    -h|--help)
      cat <<EOF
build-canopy-height.sh — render ETH Global Canopy Height 10 m PMTiles.

  --region=ukraine|carpathian   Pick a preset bbox. Default: ukraine.
  --bbox=W,S,E,N                Comma-separated override (decimal degrees).
                                Takes precedence over --region.
  --theme=light|dark|both       Build one or both colour tables. Default: both.
  -h, --help

Source: ETH GitHub release (Lang et al. 2023). Set ETH_CHM_DIR to
read locally cached GeoTIFFs instead of downloading.
The colour table is taken from src/style/canopy-height-ramps.js via
tools/dump-canopy-ramp.mjs — there's no hard-coded ramp here.
EOF
      exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2 ;;
  esac
done

need curl gdalbuildvrt gdalwarp gdaldem rio pmtiles node python3

ETH_RELEASE_TAG="${ETH_RELEASE_TAG:-v1.0}"
ETH_RELEASE_URL_BASE="https://github.com/langnico/global-canopy-height-model/releases/download/${ETH_RELEASE_TAG}"

# ---------------------------------------------------------------------------
# bbox resolution
# ---------------------------------------------------------------------------

REGION_NAME="$REGION_ARG"
if [ -n "$BBOX_OVERRIDE" ]; then
  REGION_NAME="custom"
  IFS=',' read -r BBOX_W BBOX_S BBOX_E BBOX_N <<< "$BBOX_OVERRIDE"
elif [ "$REGION_ARG" = "carpathian" ]; then
  IFS=$' \t\n' read -r BBOX_W BBOX_S BBOX_E BBOX_N < <(carpathian_bbox)
elif [ "$REGION_ARG" = "ukraine" ]; then
  # Pan-Ukraine bbox — same shape as build-worldcover.sh so operators
  # can swap regions between the two builds without surprise.
  BBOX_W=22.0
  BBOX_S=44.0
  BBOX_E=40.5
  BBOX_N=52.5
else
  echo "unknown --region=$REGION_ARG (expected ukraine|carpathian)" >&2
  exit 2
fi

for v in "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N"; do
  if ! printf '%s' "$v" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
    echo "invalid bbox value: $v" >&2
    exit 2
  fi
done

echo "Region: $REGION_NAME"
echo "BBox  : W=$BBOX_W S=$BBOX_S E=$BBOX_E N=$BBOX_N"

case "$THEME_ARG" in
  light|dark) THEMES=("$THEME_ARG") ;;
  both)       THEMES=(light dark) ;;
  *)          echo "unknown --theme=$THEME_ARG (expected light|dark|both)" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Working dirs.
# ---------------------------------------------------------------------------

WORK="$(work_dir canopy-height)"
RAW_DIR="$WORK/raw"
WARPED="$WORK/$REGION_NAME-canopy-3857.tif"
mkdir -p "$RAW_DIR"

# ---------------------------------------------------------------------------
# Step 1: enumerate the 3°×3° canopy-height tiles inside the bbox.
#
# ETH names the 3°×3° blocks by the SW corner of the tile, integer
# multiple of 3°. We expand the bbox outward to the next 3° multiple
# (floor for SW, ceil for NE) so partial-tile coverage at the edges
# is still pulled.
# ---------------------------------------------------------------------------

floor3() {
  python3 - <<PY
import math
print(int(math.floor($1 / 3.0) * 3))
PY
}
ceil3() {
  python3 - <<PY
import math
print(int(math.ceil($1 / 3.0) * 3))
PY
}

LAT_LO=$(floor3 "$BBOX_S")
LAT_HI=$(ceil3 "$BBOX_N")
LON_LO=$(floor3 "$BBOX_W")
LON_HI=$(ceil3 "$BBOX_E")

# Tile-name helper. Given the SW corner (lat, lon), produce
# `N48E021` / `S03W045` style strings (zero-padded lat 2-digit,
# lon 3-digit — same convention ETH uses).
tile_name() {
  local lat="$1" lon="$2"
  local lat_dir="N" lon_dir="E"
  if [ "$lat" -lt 0 ]; then lat_dir="S"; lat=$(( -lat )); fi
  if [ "$lon" -lt 0 ]; then lon_dir="W"; lon=$(( -lon )); fi
  printf '%s%02d%s%03d' "$lat_dir" "$lat" "$lon_dir" "$lon"
}

declare -a TILE_NAMES=()
lat="$LAT_LO"
while [ "$lat" -lt "$LAT_HI" ]; do
  lon="$LON_LO"
  while [ "$lon" -lt "$LON_HI" ]; do
    name="$(tile_name "$lat" "$lon")"
    TILE_NAMES+=("ETH_GlobalCanopyHeight_10m_2020_${name}_Map.tif")
    lon=$(( lon + 3 ))
  done
  lat=$(( lat + 3 ))
done

echo "Need ${#TILE_NAMES[@]} canopy-height tile(s)"

# ---------------------------------------------------------------------------
# Step 2: source the tiles.
#
# Priority:
#   1. ETH_CHM_DIR (if set) — copy from a local pre-downloaded cache.
#   2. ETH GitHub release — curl -L from the release asset URL.
#
# Tiles legitimately absent from the release (open ocean blocks where
# ETH didn't ship a raster) are skipped without aborting the build.
# ---------------------------------------------------------------------------

declare -a PRESENT=()
declare -a MISSING=()
for t in "${TILE_NAMES[@]}"; do
  local_path="$RAW_DIR/$t"
  if [ -s "$local_path" ]; then
    PRESENT+=("$local_path")
    continue
  fi

  if [ -n "${ETH_CHM_DIR:-}" ]; then
    # Local cache mode — never hits the network.
    if [ -s "$ETH_CHM_DIR/$t" ]; then
      cp -n "$ETH_CHM_DIR/$t" "$local_path"
      PRESENT+=("$local_path")
    else
      echo "  (missing from ETH_CHM_DIR: $t)" >&2
      MISSING+=("$t")
    fi
    continue
  fi

  echo "  curl $ETH_RELEASE_URL_BASE/$t"
  # -L: follow redirects (GitHub serves release assets via a redirect
  #     to amazonaws.com signed URLs).
  # -f: fail on HTTP 4xx/5xx so we can branch on the exit status.
  # --retry 3 --retry-delay 2: minor resilience to flaky networks.
  if curl -fL --retry 3 --retry-delay 2 \
       -A 'cart-build-canopy-height/1.0 (+https://github.com/Muran-prog/RepoMapper)' \
       -o "$local_path" \
       "$ETH_RELEASE_URL_BASE/$t" \
       2>/dev/null; then
    PRESENT+=("$local_path")
  else
    echo "    (release asset not present — skipping)" >&2
    MISSING+=("$t")
    rm -f "$local_path"
  fi
done

if [ "${#PRESENT[@]}" -eq 0 ]; then
  echo "no canopy-height tiles downloaded — bbox may be over open ocean," >&2
  echo "or the GitHub release tag '$ETH_RELEASE_TAG' may not exist." >&2
  echo "Try setting ETH_CHM_DIR to a local cache, or override ETH_RELEASE_TAG." >&2
  exit 2
fi
echo "Sourced ${#PRESENT[@]} tile(s); ${#MISSING[@]} missing/over-ocean"

# ---------------------------------------------------------------------------
# Step 3: build a VRT mosaic + warp into EPSG:3857.
#
# The native canopy-height raster is float32 metres. We keep it
# float32 through the warp so gdaldem color-relief can interpolate
# stops at sub-metre precision (matters for the 1 m → 5 m → 15 m
# transition between young growth and mature stands).
# ---------------------------------------------------------------------------

VRT="$WORK/$REGION_NAME-canopy.vrt"
gdalbuildvrt -overwrite "$VRT" "${PRESENT[@]}"

# Reproject + clip. 14 m resolution at mid-Carpathian latitude ≈
# native 10 m source — preserves the tight stand-edge transitions
# that drive the visual feel of старі смерекові смуги Чорногори.
gdalwarp \
  -overwrite \
  -t_srs EPSG:3857 \
  -te "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N" \
  -te_srs EPSG:4326 \
  -tr 14 14 \
  -r bilinear \
  -multi -wo NUM_THREADS=ALL_CPUS \
  -co COMPRESS=DEFLATE -co TILED=YES -co BIGTIFF=IF_SAFER \
  "$VRT" "$WARPED"

# ---------------------------------------------------------------------------
# Step 4-7: per-theme colour-relief + tiling + PMTiles.
# ---------------------------------------------------------------------------

ZOOM="${ZOOM:-8..13}"
declare -a SUCCESS=()
declare -a FAILED=()

build_one() {
  local theme="$1"

  local ramp_file="$WORK/canopy.$theme.txt"
  local tinted_tif="$WORK/$REGION_NAME-canopy.$theme.tif"
  local mbtiles="$WORK/$REGION_NAME-canopy.$theme.mbtiles"
  local archive="$WORK/$REGION_NAME-canopy.$theme.pmtiles"
  # The brief's expected filename: <region>-canopy.pmtiles. When both
  # themes are built we keep the per-theme variants; the "default"
  # archive is always the LIGHT theme (matches DEFAULT_THEME).
  local final_archive="$WORK/$REGION_NAME-canopy.pmtiles"

  echo "==> theme=$theme"

  # Step 4: colour table from canopy-height-ramps.js → gdaldem ramp.
  # The dump script enforces "first stop alpha must be 0" so a future
  # ramp edit can't accidentally produce a build that tints meadows.
  if ! "$REPO_ROOT/tools/dump-canopy-ramp.mjs" \
        --theme="$theme" \
        --output="$ramp_file"; then
    FAILED+=("$theme")
    return 1
  fi

  # Step 5: gdaldem color-relief on the warped raster. -alpha so the
  # transparent value-0 stop carries a 0 alpha channel through to the
  # PNG output. Without -alpha gdaldem ignores the 5th column.
  if ! gdaldem color-relief \
        -of GTiff \
        -alpha \
        -co COMPRESS=DEFLATE -co TILED=YES -co BIGTIFF=IF_SAFER \
        "$WARPED" "$ramp_file" "$tinted_tif"; then
    FAILED+=("$theme")
    return 1
  fi

  # Step 6: tile to MBTiles (zoom 8-13 by default — matches
  # TERRAIN.canopyHeight.minzoom/maxzoom).
  rm -f "$mbtiles"
  if ! rio mbtiles \
        --format PNG \
        --tile-size 256 \
        --zoom-levels "$ZOOM" \
        "$tinted_tif" "$mbtiles"; then
    FAILED+=("$theme")
    return 1
  fi

  # Step 7: convert to PMTiles.
  rm -f "$archive"
  if ! pmtiles convert "$mbtiles" "$archive"; then
    FAILED+=("$theme")
    return 1
  fi

  # Light = canonical default — always copy into the unsuffixed name.
  if [ "$theme" = "light" ]; then
    cp -f "$archive" "$final_archive"
  fi

  SUCCESS+=("$archive")
  echo "    -> $archive"
}

for theme in "${THEMES[@]}"; do
  build_one "$theme" || true
done

# ---------------------------------------------------------------------------
# Summary + final URL hint.
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

final_archive="$WORK/$REGION_NAME-canopy.pmtiles"
if [ -f "$final_archive" ]; then
  final_url_hint "$final_archive" "TERRAIN.canopyHeight.url"
fi

[ "${#FAILED[@]}" -eq 0 ]
