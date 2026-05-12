#!/usr/bin/env bash
# Build a pre-rendered seabed-tint raster PMTiles archive from GEBCO 2024.
#
# Output: tools/.work/bathymetry/black-sea-bathy.pmtiles
#
# Pipeline:
#   1. Take a GEBCO 2024 NetCDF / GeoTIFF as input ($GEBCO).
#   2. Clip + warp to EPSG:3857 covering the Black Sea + Sea of Azov
#      (BBOX env var, default = the relevant portion of the Ukrainian
#      offshore extent).
#   3. Apply a bathymetry colour ramp via gdaldem color-relief — the
#      ramp is the active hypso ramp's NEGATIVE-elevation half, so the
#      seabed and the land tint share their 0 m colour. The default
#      ramp is "patterson" but you can override with --ramp=<id>.
#   4. Tile + PMTiles convert.
#
# Why GEBCO 2024?
# ---------------
# • Free + open — CC0 / attribution-only, no API key, no signing.
# • Global 15 arc-second grid, ~450 m resolution at the equator.
# • Fits the brief's "no paid services, no server-side components" rule.
#
# Usage:
#   GEBCO=/path/to/GEBCO_2024.tif tools/build-bathymetry.sh
#   GEBCO=… tools/build-bathymetry.sh --ramp=osmPhysical
#   BBOX="29 41 41.5 47.5" GEBCO=… tools/build-bathymetry.sh
#
# Optional env:
#   ZOOM       Tile-zoom range (default = '3..9'; deeper is wasted on a sea).
#   BBOX       w s e n in lon/lat. Default = Black Sea + Azov shelf.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# ---------------------------------------------------------------------------
# Args — parsed before the dep check so --help works on bare hosts.
# ---------------------------------------------------------------------------

RAMP="patterson"
THEME="light"

for arg in "$@"; do
  case "$arg" in
    --ramp=*)  RAMP="${arg#--ramp=}" ;;
    --theme=*) THEME="${arg#--theme=}" ;;
    -h|--help)
      cat <<EOF
build-bathymetry.sh — render a Black Sea + Sea of Azov bathymetry
raster PMTiles archive from GEBCO 2024.

  --ramp=<id>     Pick the source ramp's negative-elevation stops
                  (default: patterson). 'all' is not supported here —
                  bathymetry only needs to match the active ramp's
                  seabed colours, and ramp switching at runtime
                  happens against a single bathymetry archive.
  --theme=light|dark
  -h, --help

Required:
  GEBCO=/path/to/GEBCO_2024.tif

Optional:
  BBOX="w s e n"
  ZOOM="2..9"
EOF
      exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2 ;;
  esac
done

need gdal_translate gdaldem gdalwarp rio pmtiles node

WORK="$(work_dir bathymetry)"
ZOOM="${ZOOM:-3..9}"
BBOX="${BBOX:-29 41 41.5 47.5}"

if [ -z "${GEBCO:-}" ] || [ ! -f "$GEBCO" ]; then
  cat >&2 <<EOF
GEBCO 2024 source not found.

Download the global GeoTIFF (sub_ice topography preferred for the
Black Sea):

  https://www.gebco.net/data_and_products/gridded_bathymetry_data/

Then re-run with:
  GEBCO=/path/to/GEBCO_2024.tif tools/build-bathymetry.sh

Attribution: GEBCO Compilation Group (2024) GEBCO 2024 Grid.
License: CC0, attribution required.
EOF
  exit 2
fi

# ---------------------------------------------------------------------------
# 1. Clip + warp to EPSG:3857 over the Black Sea + Azov shelf.
# ---------------------------------------------------------------------------

read -r W S E N <<<"$BBOX"
echo "==> Clipping GEBCO 2024 to bbox: $W $S $E $N"

CLIP="$WORK/gebco-clip.tif"
gdal_translate \
  -projwin "$W" "$N" "$E" "$S" \
  -of GTiff -co COMPRESS=DEFLATE -co TILED=YES \
  "$GEBCO" "$CLIP"

WARPED="$WORK/gebco-3857.tif"
gdalwarp -t_srs EPSG:3857 -r bilinear \
  -of GTiff -co COMPRESS=DEFLATE -co TILED=YES \
  -overwrite \
  "$CLIP" "$WARPED"

# ---------------------------------------------------------------------------
# 2. Generate a NEGATIVE-elevation ramp file via dump-ramp.mjs, then
#    drop every stop with elev >= 0 so the seabed colours shade-blend
#    smoothly into the 0 m coast tone.
# ---------------------------------------------------------------------------

echo "==> Building bathymetry ramp from $RAMP/$THEME"
RAMP_FILE="$WORK/$RAMP-$THEME.bathy.txt"

# Ask dump-ramp for the FULL ramp (with bathymetry stops), then filter
# to negative+zero elevations. This keeps gdaldem from extrapolating
# any positive elevations a coarse GEBCO pixel might still hold.
"$REPO_ROOT/tools/dump-ramp.mjs" "$RAMP" --theme="$THEME" \
  | awk '$1 == "nv" || ($1 + 0) <= 0' \
  > "$RAMP_FILE"

if [ ! -s "$RAMP_FILE" ]; then
  echo "could not derive bathymetry ramp from $RAMP/$THEME" >&2
  exit 3
fi
echo "    Bathymetry ramp ($(wc -l <"$RAMP_FILE") stops):"
sed 's/^/      /' "$RAMP_FILE"

# ---------------------------------------------------------------------------
# 3. gdaldem color-relief — exact_color_entry mode would be too rigid;
#    plain interpolation matches the live MapLibre `color-relief` layer.
# ---------------------------------------------------------------------------

echo "==> gdaldem color-relief"
TIF="$WORK/bathy.tif"
gdaldem color-relief -of GTiff \
  -co COMPRESS=DEFLATE -co TILED=YES \
  -alpha \
  "$WARPED" "$RAMP_FILE" "$TIF"

# ---------------------------------------------------------------------------
# 4. mbtiles + pmtiles
# ---------------------------------------------------------------------------

echo "==> Tiling at zoom $ZOOM"
MBT="$WORK/bathy.mbtiles"
rm -f "$MBT"
rio mbtiles --format png --tile-size 256 --zoom-levels "$ZOOM" "$TIF" "$MBT"

ARCHIVE="$WORK/black-sea-bathy.pmtiles"
rm -f "$ARCHIVE"
pmtiles convert "$MBT" "$ARCHIVE"

final_url_hint "$ARCHIVE" "TERRAIN.bathymetry.url"
echo
echo "Tip: GEBCO 2024 attribution is wired into TERRAIN.bathymetry.attribution"
echo "(see src/config.js). Make sure your hosting respects the CC0/attribution"
echo "requirement when serving the PMTiles archive."
