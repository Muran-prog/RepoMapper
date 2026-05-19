#!/usr/bin/env bash
# Build the ESA WorldCover landcover-tint raster PMTiles archive.
#
# Source: ESA WorldCover 10 m global land-cover product (v200, 2021).
# Distributed via the AWS Open Data registry — anonymous access through
# the public S3 bucket s3://esa-worldcover/v200/2021/map/.
#
# Tile naming on the bucket follows
#   ESA_WorldCover_10m_2021_v200_<lat><lon>_Map.tif
# where the south-west corner of each 3°×3° tile is encoded as
# `N48E021`, `N51E033`, etc.
#
# Output:
#   tools/.work/worldcover/<region>-worldcover.pmtiles
#
# Per the brief, the renderer composes a multiply-blend overlay above
# the hillshade stack (and below texture-shading) using this raster as
# its source. The colour table is emitted by `tools/dump-worldcover-ramp.mjs`,
# which reads `src/style/worldcover-ramps.js` directly so the offline
# pixels match the live MapLibre tokens at every theme.
#
# Usage:
#   tools/build-worldcover.sh                                   # default ukraine bbox, both themes
#   tools/build-worldcover.sh --region=carpathian
#   tools/build-worldcover.sh --region=ukraine --theme=light
#   tools/build-worldcover.sh --bbox=22.0,47.6,27.0,49.5        # explicit override
#
# Environment:
#   ZOOM       rio mbtiles tile-zoom range (default '6..13').
#   AWS_PROFILE / AWS_DEFAULT_REGION are passed through to `aws s3 cp`.
#
# Pipeline per (theme):
#   1. Read bbox from CARPATHIAN.bbox / Ukraine default / --bbox=…
#   2. Enumerate 3° × 3° WorldCover tiles inside the bbox.
#   3. aws s3 cp --no-sign-request → local .work/worldcover/raw/
#   4. gdalbuildvrt to merge them, gdalwarp into EPSG:3857.
#   5. gdaldem color-relief with the table from dump-worldcover-ramp.mjs.
#   6. rio mbtiles → mbtiles archive.
#   7. pmtiles convert → final PMTiles archive.
#
# License: ESA WorldCover 10 m 2021 v200 is published under
# Creative Commons BY 4.0. Attribution is required wherever the
# resulting tiles are rendered. The renderer's source descriptor in
# src/config.js carries the canonical attribution string.

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
build-worldcover.sh — render ESA WorldCover 10 m landcover-tint PMTiles.

  --region=ukraine|carpathian   Pick a preset bbox. Default: ukraine.
  --bbox=W,S,E,N                Comma-separated override (decimal degrees).
                                Takes precedence over --region.
  --theme=light|dark|both       Build one or both colour tables. Default: both.
  -h, --help

The colour table is taken from src/style/worldcover-ramps.js via
tools/dump-worldcover-ramp.mjs — there's no hard-coded ramp here.
EOF
      exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2 ;;
  esac
done

need aws gdalbuildvrt gdalwarp gdaldem rio pmtiles node

# ---------------------------------------------------------------------------
# bbox resolution
# ---------------------------------------------------------------------------
#
# Order:
#   1. --bbox=W,S,E,N override (treated as a custom region named 'custom').
#   2. --region=carpathian → CARPATHIAN.bbox from src/config.js.
#   3. --region=ukraine    → UKRAINE_BOUNDS expansion (default).
#
# We always print the resolved bbox so an operator running with verbose
# logs can sanity-check the inputs before the AWS download fires.

REGION_NAME="$REGION_ARG"
if [ -n "$BBOX_OVERRIDE" ]; then
  REGION_NAME="custom"
  IFS=',' read -r BBOX_W BBOX_S BBOX_E BBOX_N <<< "$BBOX_OVERRIDE"
elif [ "$REGION_ARG" = "carpathian" ]; then
  # _lib.sh sets IFS=$'\n\t' globally so plain `read` won't split on
  # the spaces in carpathian_bbox's "w s e n" output. Override IFS for
  # this single read so the four numbers land in distinct variables.
  IFS=$' \t\n' read -r BBOX_W BBOX_S BBOX_E BBOX_N < <(carpathian_bbox)
elif [ "$REGION_ARG" = "ukraine" ]; then
  # Pan-Ukraine bbox covering Carpathians → Donbas with a small cushion
  # so coastline tiles aren't clipped. Keeps the raw S3 download to
  # ~250 MB total (each WorldCover tile is ~5-7 MB compressed).
  BBOX_W=22.0
  BBOX_S=44.0
  BBOX_E=40.5
  BBOX_N=52.5
else
  echo "unknown --region=$REGION_ARG (expected ukraine|carpathian)" >&2
  exit 2
fi

# Validate we got four numbers.
for v in "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N"; do
  if ! printf '%s' "$v" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
    echo "invalid bbox value: $v" >&2
    exit 2
  fi
done

echo "Region: $REGION_NAME"
echo "BBox  : W=$BBOX_W S=$BBOX_S E=$BBOX_E N=$BBOX_N"

# Resolve theme list.
case "$THEME_ARG" in
  light|dark) THEMES=("$THEME_ARG") ;;
  both)       THEMES=(light dark) ;;
  *)          echo "unknown --theme=$THEME_ARG (expected light|dark|both)" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Working dirs.
#
# The same raw download + 3857-warped GeoTIFF are reused across both
# themes — only the colour-relief / tiling / pmtiles step differs per
# theme. That keeps the AWS bandwidth bill (and the operator's wall
# clock) honest.
# ---------------------------------------------------------------------------

WORK="$(work_dir worldcover)"
RAW_DIR="$WORK/raw"
WARPED="$WORK/$REGION_NAME-worldcover-3857.tif"
mkdir -p "$RAW_DIR"

# ---------------------------------------------------------------------------
# Step 1: enumerate the 3°×3° WorldCover tiles inside the bbox.
#
# WorldCover v200 tile names encode the SW corner of each 3°×3° block as
# `N<lat>E<lon>` or `S<lat>W<lon>`. The bucket layout is flat — every
# file lives at v200/2021/map/<name>.tif.
#
# We expand the bbox outward to the next 3° multiple (floor for SW,
# ceil for NE) so partial-tile coverage at the edges is still pulled.
# ---------------------------------------------------------------------------

# floor and ceil to multiples of 3.
floor3() {
  python3 - <<PY
v = $1
import math
print(int(math.floor(v / 3.0) * 3))
PY
}
ceil3() {
  python3 - <<PY
v = $1
import math
print(int(math.ceil(v / 3.0) * 3))
PY
}

LAT_LO=$(floor3 "$BBOX_S")
LAT_HI=$(ceil3 "$BBOX_N")
LON_LO=$(floor3 "$BBOX_W")
LON_HI=$(ceil3 "$BBOX_E")

# WorldCover tile naming helper. Given the SW corner (lat, lon),
# produce `N48E021` / `S03W045` style strings.
tile_name() {
  local lat="$1" lon="$2"
  local lat_dir="N" lon_dir="E"
  if [ "$lat" -lt 0 ]; then lat_dir="S"; lat=$(( -lat )); fi
  if [ "$lon" -lt 0 ]; then lon_dir="W"; lon=$(( -lon )); fi
  printf '%s%02d%s%03d' "$lat_dir" "$lat" "$lon_dir" "$lon"
}

declare -a TILES=()
lat="$LAT_LO"
while [ "$lat" -lt "$LAT_HI" ]; do
  lon="$LON_LO"
  while [ "$lon" -lt "$LON_HI" ]; do
    name="$(tile_name "$lat" "$lon")"
    TILES+=("ESA_WorldCover_10m_2021_v200_${name}_Map.tif")
    lon=$(( lon + 3 ))
  done
  lat=$(( lat + 3 ))
done

echo "Need ${#TILES[@]} WorldCover tile(s)"

# ---------------------------------------------------------------------------
# Step 2: download (anonymous; --no-sign-request) into RAW_DIR.
#
# `aws s3 cp` skips files that already exist with the same size, so a
# rerun after an interrupted download resumes cleanly. We collect the
# missing-tile list separately so the build doesn't abort if a tile is
# legitimately absent (e.g. open ocean blocks where ESA didn't ship a
# raster).
# ---------------------------------------------------------------------------

declare -a PRESENT=()
declare -a MISSING=()
for t in "${TILES[@]}"; do
  local_path="$RAW_DIR/$t"
  if [ -s "$local_path" ]; then
    PRESENT+=("$local_path")
    continue
  fi
  echo "  cp s3://esa-worldcover/v200/2021/map/$t"
  if aws s3 cp \
        --no-sign-request \
        "s3://esa-worldcover/v200/2021/map/$t" \
        "$local_path" \
        > /dev/null 2>&1; then
    PRESENT+=("$local_path")
  else
    echo "    (tile not present in bucket — skipping)" >&2
    MISSING+=("$t")
    rm -f "$local_path"
  fi
done

if [ "${#PRESENT[@]}" -eq 0 ]; then
  echo "no WorldCover tiles downloaded — bbox may be over open ocean" >&2
  exit 2
fi
echo "Downloaded ${#PRESENT[@]} tile(s); ${#MISSING[@]} missing/over-ocean"

# ---------------------------------------------------------------------------
# Step 3: build a VRT mosaic + warp into EPSG:3857.
#
# We clip to the requested bbox during warp so we don't carry pixels
# outside the AOI through the rest of the pipeline.
# ---------------------------------------------------------------------------

VRT="$WORK/$REGION_NAME-worldcover.vrt"
gdalbuildvrt -overwrite "$VRT" "${PRESENT[@]}"

# Reproject + clip. We pick a target resolution that matches the source
# 10 m scale at mid-Carpathian latitude (~14 m in Mercator) so we don't
# lose sharp class boundaries during the projection.
gdalwarp \
  -overwrite \
  -t_srs EPSG:3857 \
  -te "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N" \
  -te_srs EPSG:4326 \
  -tr 14 14 \
  -r near \
  -multi -wo NUM_THREADS=ALL_CPUS \
  -co COMPRESS=DEFLATE -co TILED=YES -co BIGTIFF=IF_SAFER \
  "$VRT" "$WARPED"

# ---------------------------------------------------------------------------
# Step 4-7: per-theme colour-relief + tiling + PMTiles.
# ---------------------------------------------------------------------------

ZOOM="${ZOOM:-6..13}"
declare -a SUCCESS=()
declare -a FAILED=()

build_one() {
  local theme="$1"

  local ramp_file="$WORK/worldcover.$theme.txt"
  local tinted_tif="$WORK/$REGION_NAME-worldcover.$theme.tif"
  local mbtiles="$WORK/$REGION_NAME-worldcover.$theme.mbtiles"
  local archive="$WORK/$REGION_NAME-worldcover.$theme.pmtiles"
  # The brief's expected filename: <region>-worldcover.pmtiles. When
  # both themes are built we keep the per-theme variant; the "default"
  # archive is always the LIGHT theme (matches DEFAULT_THEME).
  local final_archive="$WORK/$REGION_NAME-worldcover.pmtiles"

  echo "==> theme=$theme"

  # Step 4: colour table from worldcover-ramps.js → gdaldem ramp file.
  if ! "$REPO_ROOT/tools/dump-worldcover-ramp.mjs" \
        --theme="$theme" \
        --output="$ramp_file"; then
    FAILED+=("$theme")
    return 1
  fi

  # Step 5: gdaldem color-relief on the warped raster. -alpha so the
  # transparent water class actually carries a 0 alpha channel.
  if ! gdaldem color-relief \
        -of GTiff \
        -alpha \
        -co COMPRESS=DEFLATE -co TILED=YES -co BIGTIFF=IF_SAFER \
        "$WARPED" "$ramp_file" "$tinted_tif"; then
    FAILED+=("$theme")
    return 1
  fi

  # Step 6: tile to MBTiles. The format flag is case-sensitive in
  # newer rio-mbtiles releases (>=1.6) — `PNG` uppercase only.
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

  # Light = canonical default — always copy into the unsuffixed name
  # so the operator can wire `TERRAIN.worldcover.url` at a single URL.
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

# Final archive (light theme) is the canonical URL the operator wires
# into config. Print the same hint shape the rest of the build scripts
# use so the workflow stays consistent.
final_archive="$WORK/$REGION_NAME-worldcover.pmtiles"
if [ -f "$final_archive" ]; then
  final_url_hint "$final_archive" "TERRAIN.worldcover.url"
fi

[ "${#FAILED[@]}" -eq 0 ]
