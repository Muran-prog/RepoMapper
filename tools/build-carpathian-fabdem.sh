#!/usr/bin/env bash
# Build a Terrarium-encoded raster-DEM PMTiles archive for the Ukrainian
# Carpathians from FABDEM v1.2 — a bare-earth global DEM derived from
# Copernicus GLO-30 with forest canopy and built structures removed.
#
# Output: tools/.work/carpathian-fabdem/carpathian-fabdem.pmtiles
#
# Why FABDEM over GLO-30?
# -----------------------
# GLO-30 is a Digital Surface Model — its elevations include tree canopy
# and rooftops. In the Carpathian forest zone (700-1500 m) that produces
# a 10-25 m noise floor that makes hillshade "buzz" between adjacent
# pixels and shows up as random staircasing in 10 m contours. FABDEM
# applies a deep-learning canopy-height removal trained against ICESat-2
# returns, leaving a clean bare-earth surface.
#
# Costs:
#   • License is CC BY-NC 4.0 — non-commercial use only. The companion
#     `build-carpathian-dem.sh` (GLO-30) stays around for commercial
#     redistribution.
#   • Tiles are NOT served from a public S3 bucket. The University of
#     Bristol distribution requires a manual ToS accept on
#     <https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7>.
#     Download the relevant tiles into a local folder and point
#     `FABDEM_DIR` at it.
#
# Pipeline:
#   1. Determine bbox from src/config.js (CARPATHIAN.bbox).
#   2. Resolve FABDEM_DIR (local tile cache); abort with instructions if empty.
#   3. Iterate the 1°×1° lat-lon grid intersecting the bbox and pick up
#      `<lat><lon>_FABDEM_V1-2.tif` files.
#   4. Mosaic via gdalbuildvrt, reproject to EPSG:3857 with -te in WGS84.
#   5. Encode into Terrarium PNG via rio-rgbify.
#   6. Tile to mbtiles (z5-z14).
#   7. Convert mbtiles -> PMTiles.
#
# Usage:
#   FABDEM_DIR=/path/to/fabdem-v1-2/ tools/build-carpathian-fabdem.sh
#
# Disk: ~500 MB working set, ~80 MB final archive.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need gdalbuildvrt gdalwarp rio python3 pmtiles

WORK="$(work_dir carpathian-fabdem)"
cd "$WORK"

# 1. Bounding box -----------------------------------------------------------
read -r W S E N <<<"$(carpathian_bbox)"
echo "bbox: W=$W  S=$S  E=$E  N=$N"

# 2. Resolve local FABDEM cache --------------------------------------------
if [ -z "${FABDEM_DIR:-}" ] || [ ! -d "$FABDEM_DIR" ]; then
  cat >&2 <<'EOF'
FABDEM_DIR is not set or does not exist.

FABDEM v1.2 (Hawker et al., 2022) is published by the University of
Bristol under CC BY-NC 4.0. It cannot be redistributed via public
mirrors automatically — you must download the relevant tiles manually
after accepting the dataset's terms of service.

  1. Visit:
       https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7
  2. Accept the CC BY-NC 4.0 ToS.
  3. Download the .zip files covering your bbox and unpack them into
     a single flat directory of GeoTIFFs.
  4. Re-run:
       FABDEM_DIR=/path/to/fabdem-v1-2/ tools/build-carpathian-fabdem.sh

For the Ukrainian Carpathian bbox (W=22, S=47.6, E=27, N=49.5) you need
six tiles: N47E022..N49E026 inclusive — roughly 80 MB compressed.

Tile naming: <lat><lon>_FABDEM_V1-2.tif (e.g. N48E024_FABDEM_V1-2.tif).

For commercial use cases, fall back to tools/build-carpathian-dem.sh
(Copernicus GLO-30, free for any use including commercial).
EOF
  exit 2
fi

# 3. List the FABDEM tiles intersecting the bbox ----------------------------
# FABDEM tile naming: N48E024_FABDEM_V1-2.tif (lat-lon, 1°×1°, integer grid).
mkdir -p src
echo "discovering FABDEM tiles in $FABDEM_DIR..."
TILES=()
MISSING=()
for lat in $(seq "${S%.*}" "${N%.*}"); do
  for lon in $(seq "${W%.*}" "${E%.*}"); do
    if [ "$lat" -ge 0 ]; then
      lat_str=$(printf 'N%02d' "$lat")
    else
      lat_str=$(printf 'S%02d' "$((-lat))")
    fi
    if [ "$lon" -ge 0 ]; then
      lon_str=$(printf 'E%03d' "$lon")
    else
      lon_str=$(printf 'W%03d' "$((-lon))")
    fi
    name="${lat_str}${lon_str}_FABDEM_V1-2.tif"
    src_path="$FABDEM_DIR/$name"
    if [ -f "$src_path" ]; then
      cp -n "$src_path" "src/$name"
      TILES+=("$name")
    else
      MISSING+=("$name")
    fi
  done
done

if [ "${#TILES[@]}" -eq 0 ]; then
  echo "No FABDEM tiles found in $FABDEM_DIR for bbox W=$W S=$S E=$E N=$N." >&2
  echo "Expected tiles: ${MISSING[*]}" >&2
  exit 3
fi

echo "${#TILES[@]} tiles found in extent (${#MISSING[@]} missing)"
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "(skipping missing tiles: ${MISSING[*]})"
fi

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

# 6. mbtiles -> PMTiles -----------------------------------------------------
ARCHIVE="$WORK/carpathian-fabdem.pmtiles"
pmtiles convert carpathian-terrarium.mbtiles "$ARCHIVE"

final_url_hint "$ARCHIVE" "TERRAIN.carpathian.url"

cat <<EOF

Reminder: FABDEM v1.2 is licensed CC BY-NC 4.0 (non-commercial only).
When you set TERRAIN.carpathian.url to this archive, also keep
TERRAIN.carpathian.demSource = 'fabdem' so src/config.js auto-emits
the matching attribution string:

   DEM: FABDEM v1.2 © Fathom (CC BY-NC 4.0)

For commercial redistribution, build with tools/build-carpathian-dem.sh
(Copernicus GLO-30) instead.
EOF
