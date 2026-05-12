#!/usr/bin/env bash
# Build a Terrarium-encoded raster-DEM PMTiles archive for the Ukrainian
# Carpathians from Copernicus GLO-30.
#
# Output: tools/.work/carpathian-dem/carpathian-glo30.pmtiles
#
# Pipeline:
#   1. Determine bbox from src/config.js (CARPATHIAN.bbox)
#   2. Discover the Copernicus GLO-30 tiles intersecting the bbox
#   3. Pull them from s3://copernicus-dem-30m/ with --no-sign-request
#   4. Mosaic via gdalbuildvrt, reproject to EPSG:3857
#   5. Encode elevation into Terrarium PNG via rio-rgbify
#   6. Tile to mbtiles (z5–z14)
#   7. Convert mbtiles → PMTiles
#
# Real-world disk: ~700 MB working set, ~80 MB final archive.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need aws gdalbuildvrt gdalwarp rio python3 pmtiles

WORK="$(work_dir carpathian-dem)"
cd "$WORK"

# 1. Bounding box -----------------------------------------------------------
read -r W S E N <<<"$(carpathian_bbox)"
echo "bbox: W=$W  S=$S  E=$E  N=$N"

# 2. List the GLO-30 tiles intersecting the bbox ----------------------------
# GLO-30 tile naming: Copernicus_DSM_COG_10_<N|S><lat>_00_<E|W><lon>_00_DEM
mkdir -p src
echo "discovering GLO-30 tiles..."
TILES=()
for lat in $(seq "${S%.*}" "${N%.*}"); do
  for lon in $(seq "${W%.*}" "${E%.*}"); do
    # Pad to 2/3 chars: lat 47 → N47, lon 22 → E022
    lat_str=$(printf 'N%02d' "$lat")
    lon_str=$(printf 'E%03d' "$lon")
    name="Copernicus_DSM_COG_10_${lat_str}_00_${lon_str}_00_DEM"
    TILES+=("$name")
  done
done
echo "${#TILES[@]} tiles in extent"

# 3. Download ---------------------------------------------------------------
for t in "${TILES[@]}"; do
  if [ ! -f "src/${t}.tif" ]; then
    aws s3 cp \
      "s3://copernicus-dem-30m/${t}/${t}.tif" \
      "src/${t}.tif" \
      --no-sign-request --quiet \
      || echo "(skip missing tile $t)"
  fi
done

# 4. Mosaic + reproject -----------------------------------------------------
gdalbuildvrt -overwrite -srcnodata 0 carpathian.vrt src/*.tif
gdalwarp -overwrite \
  -t_srs EPSG:3857 -r cubic \
  -te "$W" "$S" "$E" "$N" -te_srs EPSG:4326 \
  -tr 30 30 \
  -multi -of GTiff \
  -co COMPRESS=DEFLATE -co TILED=YES \
  carpathian.vrt carpathian-3857.tif

# 5. Terrarium-encode (rio-rgbify) -----------------------------------------
# Terrarium: red*256 + green + blue/256 - 32768 = elevation_metres
rio rgbify \
  -e terrarium \
  --min-z 5 --max-z 14 \
  --format png \
  carpathian-3857.tif carpathian-terrarium.mbtiles

# 6. mbtiles → PMTiles ------------------------------------------------------
ARCHIVE="$WORK/carpathian-glo30.pmtiles"
pmtiles convert carpathian-terrarium.mbtiles "$ARCHIVE"

final_url_hint "$ARCHIVE" "TERRAIN.carpathian.url"
