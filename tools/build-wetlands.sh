#!/usr/bin/env bash
# Build the classified wetland VECTOR archive that backs the `swampCover`
# layer's graded orange traversability palette.
#
# Why an OSM-derived wetland archive?
# -----------------------------------
# `swampCover` Tier A already paints the GLOBAL OpenMapTiles `landcover`
# class=wetland the base map consumes — but the published OpenFreeMap build
# collapses every wetland to subclass='wetland' (verified by decoding live
# z12–z14 tiles), so it can only ever show ONE undifferentiated orange. The
# subtype we need to grade traversability (marsh vs bog vs tidal flat …) only
# survives in the RAW OSM `wetland=<subtype>` tag. This archive supplies it as
# Tier B; when it is absent the renderer falls back to the Tier A wash.
#
# This is the wetland analogue of tools/build-forest10m.sh. The forest archive
# is raster-derived (ESA WorldCover → gdal → tippecanoe → PMTiles); wetlands
# instead come from OSM vectors via the Overpass API and ship as a GeoJSON
# source (no PMTiles host / HTTP-range server needed — it serves as a plain
# static file next to index.html). All heavy lifting lives in the Python
# module tools/build_wetlands.py; this wrapper just validates deps and runs it.
#
# Pipeline (see tools/build_wetlands.py):
#   1. Tile Ukraine's wetland belt into boxes; query Overpass for
#      natural=wetland ways + relations WITH geometry.
#   2. Assemble shapely polygons (multipolygon relations included), dedupe.
#   3. Classify each polygon into a traversability tier from its wetland=<v>
#      subtag (TIER_BY_TYPE), attach a compact `tier` (+ `wetland`, `salt`).
#   4. Simplify (Douglas-Peucker) + round coords + drop slivers.
#   5. Write data/ukraine-wetlands.geojson.
#
# Output:
#   data/ukraine-wetlands.geojson   (properties: tier, wetland[, salt])
#
# Usage:
#   tools/build-wetlands.sh                       # national (all boxes)
#   tools/build-wetlands.sh --boxes 9,10          # just the Danube/Sivash boxes
#   OUT=data/wet.geojson TOL=0.001 tools/build-wetlands.sh
#
# Environment:
#   OUT         output path      (default data/ukraine-wetlands.geojson)
#   TOL         simplify deg     (default 0.0016 ≈ 175 m)
#   MIN_AREA    drop below deg^2 (default 8e-7 ≈ 1 ha)
#   PYTHON      interpreter      (default python3; needs `requests`, `shapely`)
#
# License: © OpenStreetMap contributors — ODbL. Attribution is carried by
# TERRAIN.wetlands.attribution in src/config.js and surfaced in the MapLibre
# attribution control whenever the source is active.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PYTHON="${PYTHON:-python3}"
OUT="${OUT:-data/ukraine-wetlands.geojson}"
TOL="${TOL:-0.0016}"
MIN_AREA="${MIN_AREA:-0.0000008}"

# Pass-through args (e.g. --boxes 9,10, --full-props).
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) EXTRA+=("$arg") ;;
  esac
done

# Dependency check — the script needs requests + shapely.
if ! "$PYTHON" -c 'import requests, shapely' >/dev/null 2>&1; then
  echo "error: $PYTHON is missing 'requests' and/or 'shapely'." >&2
  echo "       install with: $PYTHON -m pip install requests shapely" >&2
  exit 1
fi

cd "$ROOT"
echo "Building wetland archive → $OUT (tol=$TOL, min-area=$MIN_AREA)"
"$PYTHON" tools/build_wetlands.py -o "$OUT" --tol "$TOL" --min-area "$MIN_AREA" "${EXTRA[@]}"

echo
echo "Wetland archive: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Wired via TERRAIN.wetlands.data in src/config.js (swampCover Tier B)."
