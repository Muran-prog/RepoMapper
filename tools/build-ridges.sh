#!/usr/bin/env bash
# Build a ridge/valley vector PMTiles archive for Imhof-style enhancement.
#
# Output: tools/.work/ridges/carpathian-ridges.pmtiles
#
# Pipeline:
#   1. Smooth the DEM with a small Gaussian (WhiteboxTools GaussianFilter).
#   2. Run FindRidges to extract centerline rasters.
#   3. Polygonise the binary raster → vector lines.
#   4. tippecanoe → PMTiles.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need whitebox_tools gdal_polygonize.py ogr2ogr tippecanoe pmtiles

WORK="$(work_dir ridges)"
cd "$WORK"

DEM="${DEM:-$WORK_ROOT/carpathian-dem/carpathian-3857.tif}"
if [ ! -f "$DEM" ]; then
  echo "DEM not found: $DEM" >&2
  echo "Run tools/build-carpathian-dem.sh first, or set DEM=/path/to/dem.tif" >&2
  exit 2
fi

SIGMA="${SIGMA:-2.0}"

# 1. Smooth.
whitebox_tools --run=GaussianFilter \
  --input="$DEM" --output=smoothed.tif --sigma="$SIGMA"

# 2. Extract ridges.
whitebox_tools --run=FindRidges \
  --dem=smoothed.tif --output=ridges.tif --line_thin=true

# 3. Polygonise → line strings.
gdal_polygonize.py ridges.tif ridges.gpkg -f GPKG ridges DN
# Keep only the foreground class (DN=1), convert polygons → polylines.
ogr2ogr -f GeoJSONSeq ridges.geojson ridges.gpkg \
  -dialect SQLite \
  -sql "
    SELECT 'ridge' AS type, ST_PointOnSurface(geometry) AS geom
    FROM ridges WHERE DN = 1
  "

# 4. Tile. Each feature is a short segment of the ridge skeleton; we let
# tippecanoe merge contiguous segments via --simplification.
tippecanoe \
  -Z 8 -z 14 \
  --layer=ridges \
  --simplification=5 \
  --drop-densest-as-needed \
  --no-tile-stats \
  -o ridges.mbtiles \
  ridges.geojson

ARCHIVE="$WORK/carpathian-ridges.pmtiles"
pmtiles convert ridges.mbtiles "$ARCHIVE"
final_url_hint "$ARCHIVE" "TERRAIN.ridges.url"
