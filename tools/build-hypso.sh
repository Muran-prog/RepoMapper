#!/usr/bin/env bash
# Build a pre-rendered hypsometric tint raster PMTiles archive from the
# Carpathian DEM (or any other source DEM via $DEM).
#
# Output: tools/.work/hypso/ukraine-hypso.pmtiles
#
# Pipeline:
#   1. Parse the elevation→colour ramp from src/style/tokens.js (LIGHT.hypsoStops)
#      into a gdaldem color-relief input file.
#   2. Run gdaldem color-relief against the DEM.
#   3. Tile + PMTiles convert.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need gdaldem rio pmtiles awk

WORK="$(work_dir hypso)"
cd "$WORK"

DEM="${DEM:-$WORK_ROOT/carpathian-dem/carpathian-3857.tif}"
if [ ! -f "$DEM" ]; then
  echo "DEM not found: $DEM" >&2
  echo "Run tools/build-carpathian-dem.sh first, or set DEM=/path/to/dem.tif" >&2
  exit 2
fi

# 1. Extract hypsoStops from src/style/tokens.js (LIGHT block).
TOKENS="$REPO_ROOT/src/style/tokens.js"
RAMP_FILE="$WORK/ramp.txt"
awk '
  # Find the LIGHT block and the hypsoStops: array inside it.
  /^const LIGHT/ { in_light = 1 }
  /^const DARK/  { in_light = 0 }
  in_light && /hypsoStops:[[:space:]]*\[/ { in_stops = 1; next }
  in_stops && /^\s*\]/                    { in_stops = 0 }
  in_stops {
    # Lines look like:  [-10, "#a9cfe6"],
    # Strip [], quotes, commas; emit "<elev>  <hex>" so gdaldem accepts it.
    line = $0
    gsub(/[\[\],"\047]/, "", line)
    n = split(line, parts, " ")
    elev = ""
    color = ""
    for (i = 1; i <= n; i++) {
      if (parts[i] == "") continue
      if (elev == "") { elev = parts[i] }
      else            { color = parts[i] }
    }
    if (elev != "" && color != "") {
      # gdaldem color-relief wants "elevation R G B" — convert #rrggbb to R G B.
      r = strtonum("0x" substr(color, 2, 2))
      g = strtonum("0x" substr(color, 4, 2))
      b = strtonum("0x" substr(color, 6, 2))
      printf "%s %d %d %d\n", elev, r, g, b
    }
  }
' "$TOKENS" > "$RAMP_FILE"

# Validate that we actually got stops.
if [ ! -s "$RAMP_FILE" ]; then
  echo "could not parse LIGHT.hypsoStops out of $TOKENS — check the file's format" >&2
  exit 3
fi
echo "Hypsometric ramp:"
cat "$RAMP_FILE"

# 2. Apply.
gdaldem color-relief -of GTiff \
  -co COMPRESS=DEFLATE -co TILED=YES \
  -alpha \
  "$DEM" "$RAMP_FILE" hypso.tif

# 3. Tile.
rio mbtiles --format png --tile-size 256 --zoom-levels 2..12 hypso.tif hypso.mbtiles

ARCHIVE="$WORK/ukraine-hypso.pmtiles"
pmtiles convert hypso.mbtiles "$ARCHIVE"
final_url_hint "$ARCHIVE" "TERRAIN.hypsometric.url"
