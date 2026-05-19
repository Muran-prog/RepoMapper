#!/usr/bin/env bash
# Build a pre-rendered Sky-View Factor (SVF) raster PMTiles archive for
# the Carpathian region. SVF scores each pixel by the fraction of the
# upper hemisphere visible from it — narrow valleys, canyons, the rims
# of glacial cirques and rock terraces all read as low SVF (dark) while
# open ridges and plateaus read as high SVF (light). Multiplied over a
# standard hillshade the resulting overlay surfaces fine relief detail
# that single-azimuth illumination smears out.
#
# Output: tools/.work/carpathian-svf/carpathian-svf.pmtiles
#
# Pipeline:
#   1. Read CARPATHIAN.bbox from src/config.js.
#   2. Resolve the source DEM path (DEM_PATH env or default to the
#      FABDEM/GLO-30 working file).
#   3. Run whitebox_tools SkyViewFactor with 16 azimuths and a 1 km
#      maximum search distance (tuned for ~30 m DEM detail).
#   4. Normalise to 8-bit greyscale, INVERT so canyons are dark.
#   5. rio mbtiles -> pmtiles convert.
#
# Usage:
#   DEM_PATH=tools/.work/carpathian-fabdem/carpathian-3857.tif tools/build-svf.sh
#
# Optional env:
#   AZIMUTHS    Number of horizon samples (default 16; whitebox_tools
#               accepts any power of 2 up to 256).
#   MAX_DIST    Horizon search radius in metres (default 1000).
#   ZOOM        Tile zoom range (default '6..14').

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need whitebox_tools python3 rio pmtiles

WORK="$(work_dir carpathian-svf)"
cd "$WORK"

# 1. Bounding box -----------------------------------------------------------
read -r W S E N <<<"$(carpathian_bbox)"
echo "bbox: W=$W  S=$S  E=$E  N=$N"

# 2. Resolve DEM source -----------------------------------------------------
# Prefer the FABDEM working file; fall back to GLO-30 if FABDEM hasn't
# been built. Operator can override via DEM_PATH.
if [ -z "${DEM_PATH:-}" ]; then
  if   [ -f "$WORK_ROOT/carpathian-fabdem/carpathian-3857.tif" ]; then
    DEM_PATH="$WORK_ROOT/carpathian-fabdem/carpathian-3857.tif"
  elif [ -f "$WORK_ROOT/carpathian-dem/carpathian-3857.tif" ]; then
    DEM_PATH="$WORK_ROOT/carpathian-dem/carpathian-3857.tif"
  fi
fi

if [ -z "${DEM_PATH:-}" ] || [ ! -f "$DEM_PATH" ]; then
  cat >&2 <<EOF
DEM source not found.

Either run one of the DEM build scripts first:
   tools/build-carpathian-fabdem.sh   (recommended, FABDEM v1.2)
   tools/build-carpathian-dem.sh      (Copernicus GLO-30 fallback)

or set DEM_PATH=/path/to/dem.tif explicitly.
EOF
  exit 2
fi
echo "DEM_PATH=$DEM_PATH"

AZIMUTHS="${AZIMUTHS:-16}"
MAX_DIST="${MAX_DIST:-1000}"
ZOOM="${ZOOM:-6..14}"

# 3. SkyViewFactor (raw float raster, 0..1) --------------------------------
echo "==> whitebox_tools SkyViewFactor (azimuths=$AZIMUTHS, max_dist=${MAX_DIST}m)"
whitebox_tools \
  --run=SkyViewFactor \
  --dem="$DEM_PATH" \
  --output="$WORK/svf-raw.tif" \
  --azimuths="$AZIMUTHS" \
  --max_dist="$MAX_DIST"

# 4. Normalise to 8-bit grey + invert so dark = enclosed terrain ----------
# whitebox writes a Float32 0..1 raster; we stretch the actual percentile
# range (1..99) to 0..255 to avoid the ramp being dominated by a few
# extreme outliers, then invert so the layer reads as a multiplicative
# darkening — exactly what we'll multiply over hillshade.
echo "==> normalise + invert"
python3 - <<PY
import numpy as np
import rasterio

src = rasterio.open(r"""$WORK/svf-raw.tif""")
data = src.read(1).astype(np.float64)
nodata = src.nodata
mask = np.isfinite(data)
if nodata is not None:
    mask &= data != nodata

vals = data[mask]
if vals.size == 0:
    raise SystemExit('SVF raster is empty')

lo = np.percentile(vals, 1.0)
hi = np.percentile(vals, 99.0)
if hi <= lo:
    hi = lo + 1e-6

stretched = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
# Invert: low SVF (canyons) -> dark, high SVF (open) -> light. We want
# canyons emphasised, so the FINAL pixel value (which the renderer
# multiplies over hillshade) must be DARK there. inverse = 1 - x.
inverted = 1.0 - stretched
out = (inverted * 255.0).astype(np.uint8)
out[~mask] = 255  # nodata -> white = no darkening

profile = src.profile
profile.update(dtype='uint8', count=1, compress='deflate', tiled=True, photometric='minisblack', nodata=255)
with rasterio.open(r"""$WORK/svf.tif""", 'w', **profile) as dst:
    dst.write(out, 1)
src.close()
PY

# 5. Tile + PMTiles ---------------------------------------------------------
rm -f "$WORK/svf.mbtiles"
rio mbtiles --format png --tile-size 256 --zoom-levels "$ZOOM" "$WORK/svf.tif" "$WORK/svf.mbtiles"

ARCHIVE="$WORK/carpathian-svf.pmtiles"
rm -f "$ARCHIVE"
pmtiles convert "$WORK/svf.mbtiles" "$ARCHIVE"

final_url_hint "$ARCHIVE" "TERRAIN.skyViewFactor.url"
