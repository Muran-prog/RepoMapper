#!/usr/bin/env bash
# Build a static contour-line vector PMTiles archive from the Carpathian
# DEM. Useful when you want crisper labels than maplibre-contour's runtime
# output, or to lighten the load on weaker GPUs.
#
# Output: tools/.work/contours/carpathian-contours.pmtiles
#
# Pipeline:
#   1. gdal_contour at 10 m interval against the DEM.
#   2. Tag each feature with `level=0` (minor) or `level=1` (major-every-50m)
#      so it matches what maplibre-contour emits at runtime — the renderer
#      then uses the same layer specs for both static and dynamic modes.
#   3. tippecanoe (Felt fork) → mbtiles → PMTiles.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need gdal_contour ogr2ogr tippecanoe pmtiles jq

WORK="$(work_dir contours)"
cd "$WORK"

DEM="${DEM:-$WORK_ROOT/carpathian-dem/carpathian-3857.tif}"
if [ ! -f "$DEM" ]; then
  echo "DEM not found: $DEM" >&2
  echo "Run tools/build-carpathian-dem.sh first, or set DEM=/path/to/dem.tif" >&2
  exit 2
fi

INTERVAL="${INTERVAL:-10}"
MAJOR_INTERVAL="${MAJOR_INTERVAL:-50}"

# 1. Extract contours.
gdal_contour -i "$INTERVAL" -a ele -snodata -32768 \
  "$DEM" contours.gpkg

# 2. Tag major vs minor; write GeoJSONSeq for tippecanoe.
ogr2ogr -f GeoJSONSeq contours.geojson contours.gpkg \
  -dialect SQLite -sql "
    SELECT
      ele,
      CAST((ele % $MAJOR_INTERVAL = 0) AS INTEGER) AS level,
      geometry
    FROM contour
  "

# 3. Tile. The `--use-attribute-for-id` keeps each contour's `ele` stable
# across zooms so the renderer can label without flicker.
tippecanoe \
  -Z 9 -z 15 \
  --layer=contours \
  --simplification=5 \
  --drop-densest-as-needed \
  --no-tile-stats \
  --extend-zooms-if-still-dropping \
  -o contours.mbtiles \
  contours.geojson

ARCHIVE="$WORK/carpathian-contours.pmtiles"
pmtiles convert contours.mbtiles "$ARCHIVE"
final_url_hint "$ARCHIVE" "CONTOURS.staticPmtilesUrl"
