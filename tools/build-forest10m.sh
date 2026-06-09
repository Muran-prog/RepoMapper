#!/usr/bin/env bash
# Build the high-detail 10 m forest VECTOR PMTiles archive for the
# Carpathians from ESA WorldCover 10 m 2021 v200 (class 10 = Tree cover).
#
# Why a vector forest archive?
# ----------------------------
# `forestCover` normally paints the GLOBAL OpenMapTiles `landcover` source,
# which is capped at z14 and heavily generalised. This archive supplies
# satellite-accurate 10 m tree-cover stand boundaries inside the Carpathian
# bbox up to z15, so `forestCover` reads far crisper there. The renderer
# wires it through `TERRAIN.forest10m.url`; when that is null the high-detail
# layers are skipped and the global landcover forest is the fallback.
#
# Output:
#   tools/.work/forest10m/<region>-forest-10m.pmtiles   (source-layer: forest)
#
# Source: ESA WorldCover 10 m global land-cover product (v200, 2021),
# distributed via the AWS Open Data registry. Tiles are fetched over plain
# HTTPS from the public bucket (no aws CLI / credentials required):
#   https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/<TILE>.tif
# Tile names encode the SW corner of each 3°×3° block as `N48E021` etc.
#
# Pipeline:
#   1. Resolve bbox (CARPATHIAN.bbox / --bbox=…).
#   2. Enumerate + download the 3°×3° WorldCover tiles covering the bbox.
#   3. gdalbuildvrt mosaic → gdalwarp clip to bbox (native 10 m, EPSG:4326).
#   4. gdal_calc tree mask (class==10 → 1, else nodata).
#   5. gdal_polygonize → FlatGeobuf polygons.
#   6. ogr2ogr area filter (drop sub-pixel slivers) → keeps real stands.
#   7. tippecanoe → vector PMTiles (layer `forest`, Z6..z15).
#
# Usage:
#   tools/build-forest10m.sh                          # CARPATHIAN.bbox
#   tools/build-forest10m.sh --bbox=22.0,47.6,27.0,49.5
#
# Environment:
#   MINZOOM / MAXZOOM     tippecanoe zoom range (default 6 / 15).
#   MIN_AREA_DEG2         drop polygons below this area in deg² (default 5e-8,
#                         ≈500 m² at Carpathian latitude — sub-pixel noise).
#
# License: ESA WorldCover 10 m 2021 v200 — CC BY 4.0. Attribution is carried
# by `TERRAIN.forest10m.attribution` in src/config.js and surfaced in the
# MapLibre attribution control whenever the source is active.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# --- args (before dep checks so --help works on minimal hosts) -------------
BBOX_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --bbox=*) BBOX_OVERRIDE="${arg#--bbox=}" ;;
    -h|--help)
      cat <<EOF
build-forest10m.sh — high-detail 10 m forest vector PMTiles (ESA WorldCover).

  --bbox=W,S,E,N   Override the bbox (decimal degrees). Default: CARPATHIAN.bbox.
  -h, --help

Env: MINZOOM (6), MAXZOOM (15), MIN_AREA_DEG2 (5e-8).
EOF
      exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

need curl gdalbuildvrt gdalwarp gdal_calc.py gdal_polygonize.py ogr2ogr tippecanoe

# --- bbox resolution -------------------------------------------------------
if [ -n "$BBOX_OVERRIDE" ]; then
  IFS=',' read -r BBOX_W BBOX_S BBOX_E BBOX_N <<< "$BBOX_OVERRIDE"
else
  IFS=$' \t\n' read -r BBOX_W BBOX_S BBOX_E BBOX_N < <(carpathian_bbox)
fi
for v in "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N"; do
  if ! printf '%s' "$v" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
    echo "invalid bbox value: $v" >&2; exit 2
  fi
done
echo "BBox: W=$BBOX_W S=$BBOX_S E=$BBOX_E N=$BBOX_N"

MINZOOM="${MINZOOM:-6}"
MAXZOOM="${MAXZOOM:-14}"
MIN_AREA_DEG2="${MIN_AREA_DEG2:-0.00000005}"

WORK="$(work_dir forest10m)"
RAW_DIR="$WORK/raw"
mkdir -p "$RAW_DIR"

# --- step 1-2: enumerate + download 3°×3° WorldCover tiles -----------------
floor3() { python3 -c "import math;print(int(math.floor($1/3.0)*3))"; }
ceil3()  { python3 -c "import math;print(int(math.ceil($1/3.0)*3))"; }
LAT_LO=$(floor3 "$BBOX_S"); LAT_HI=$(ceil3 "$BBOX_N")
LON_LO=$(floor3 "$BBOX_W"); LON_HI=$(ceil3 "$BBOX_E")

tile_name() {
  local lat="$1" lon="$2" lat_dir="N" lon_dir="E"
  if [ "$lat" -lt 0 ]; then lat_dir="S"; lat=$(( -lat )); fi
  if [ "$lon" -lt 0 ]; then lon_dir="W"; lon=$(( -lon )); fi
  printf '%s%02d%s%03d' "$lat_dir" "$lat" "$lon_dir" "$lon"
}

BASE="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
declare -a PRESENT=()
lat="$LAT_LO"
while [ "$lat" -lt "$LAT_HI" ]; do
  lon="$LON_LO"
  while [ "$lon" -lt "$LON_HI" ]; do
    name="$(tile_name "$lat" "$lon")"
    f="ESA_WorldCover_10m_2021_v200_${name}_Map.tif"
    local_path="$RAW_DIR/$f"
    if [ ! -s "$local_path" ]; then
      echo "  download $f"
      if ! curl -fsS -o "$local_path" "$BASE/$f"; then
        echo "    (tile absent — skipping)" >&2; rm -f "$local_path"; lon=$(( lon + 3 )); continue
      fi
    fi
    PRESENT+=("$local_path")
    lon=$(( lon + 3 ))
  done
  lat=$(( lat + 3 ))
done
[ "${#PRESENT[@]}" -gt 0 ] || { echo "no WorldCover tiles downloaded" >&2; exit 2; }
echo "Have ${#PRESENT[@]} tile(s)"

# --- step 3: mosaic + clip (native 10 m, EPSG:4326) ------------------------
VRT="$WORK/mosaic.vrt"
CLIP="$WORK/clip.tif"
gdalbuildvrt -overwrite "$VRT" "${PRESENT[@]}"
gdalwarp -overwrite \
  -te "$BBOX_W" "$BBOX_S" "$BBOX_E" "$BBOX_N" -te_srs EPSG:4326 \
  -multi -wo NUM_THREADS=ALL_CPUS \
  -co COMPRESS=DEFLATE -co TILED=YES -co BIGTIFF=YES \
  "$VRT" "$CLIP"

# --- step 4: tree mask (class 10 → 1, else nodata) -------------------------
MASK="$WORK/tree_mask.tif"
gdal_calc.py -A "$CLIP" --A_band=1 --calc="(A==10)" \
  --NoDataValue=0 --type=Byte \
  --co COMPRESS=DEFLATE --co TILED=YES --co BIGTIFF=YES \
  --outfile="$MASK" --quiet --overwrite

# --- step 5: polygonize ----------------------------------------------------
FGB="$WORK/tree.fgb"
rm -f "$FGB"
gdal_polygonize.py "$MASK" -b 1 -mask "$MASK" -f FlatGeobuf "$FGB" tree class

# --- step 6: drop sub-pixel slivers ----------------------------------------
FGB_F="$WORK/tree_f.fgb"
rm -f "$FGB_F"
ogr2ogr -f FlatGeobuf "$FGB_F" "$FGB" \
  -dialect OGRSQL -sql "SELECT * FROM tree WHERE OGR_GEOM_AREA > $MIN_AREA_DEG2"

# --- step 7: tile to vector PMTiles ----------------------------------------
ARCHIVE="$WORK/carpathian-forest-10m.pmtiles"
rm -f "$ARCHIVE"
tippecanoe \
  -o "$ARCHIVE" -l forest \
  -Z"$MINZOOM" -z"$MAXZOOM" \
  --coalesce --reorder --detect-shared-borders \
  --drop-densest-as-needed \
  --simplification=12 \
  --no-tiny-polygon-reduction \
  --force \
  "$FGB_F"

echo
echo "Forest-10m archive: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
final_url_hint "$ARCHIVE" "TERRAIN.forest10m.url"
