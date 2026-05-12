#!/usr/bin/env bash
# Build a pre-rendered "texture shading" raster PMTiles archive using
# Leland Brown's fractional Laplacian operator (α=0.8 by default).
#
# Texture shading reads ridges and stream networks far more clearly than
# any single-direction hillshade — it's the trick behind National
# Geographic-style relief maps.
#
# Output: tools/.work/texture-shading/ukraine-texture-shading.pmtiles
#
# Pipeline:
#   1. Use the Carpathian GLO-30 GeoTIFF built by build-carpathian-dem.sh
#      (or any other DEM at $DEM, override via env).
#   2. Run a small Python script that applies the fractional Laplacian
#      via 2-D FFT, normalises to 8-bit greyscale, and saves as TIFF.
#   3. Tile + PMTiles convert.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
need python3 gdalwarp rio pmtiles

WORK="$(work_dir texture-shading)"
cd "$WORK"

# Reuse the DEM from the Carpathian pipeline by default, but accept any
# Terrarium-decodable or raw-elevation GeoTIFF via $DEM.
DEM="${DEM:-$WORK_ROOT/carpathian-dem/carpathian-3857.tif}"
if [ ! -f "$DEM" ]; then
  echo "DEM not found: $DEM" >&2
  echo "Run tools/build-carpathian-dem.sh first, or set DEM=/path/to/dem.tif" >&2
  exit 2
fi

# Python inline — keeps the build pipeline single-file rather than adding
# a separate .py to the repo. Reads $DEM, writes texture.tif.
ALPHA="${ALPHA:-0.8}"
DETAIL="${DETAIL:-1.5}"

python3 - <<PY
import sys, numpy as np
from scipy import fft
import rasterio
from rasterio.enums import Resampling

src = rasterio.open(r"""$DEM""")
dem = src.read(1).astype(np.float64)
nodata = src.nodata
if nodata is not None:
    dem = np.where(dem == nodata, np.nan, dem)
# Fill NaNs by mean (cheap; for big holes we'd interpolate, but in our
# clipped bbox the source is contiguous).
mean = np.nanmean(dem)
dem = np.where(np.isnan(dem), mean, dem)

h, w = dem.shape
ky = np.fft.fftfreq(h)[:, None]
kx = np.fft.fftfreq(w)[None, :]
k = np.sqrt(kx * kx + ky * ky)
k[0, 0] = 1  # avoid div-by-zero — DC is killed below

# Fractional Laplacian: convolution with |k|^alpha in frequency space.
# Leland Brown's recipe: positive alpha pulls high frequencies up, which
# is exactly the ridge/canyon emphasis we want.
filter_ = k ** $ALPHA
filter_[0, 0] = 0  # remove the mean

dem_fft = fft.fft2(dem)
shaded = np.real(fft.ifft2(dem_fft * filter_))

# Normalise. Brown uses a "detail" parameter that controls the contrast
# (a histogram stretch percentile). We clip at 1.5 standard deviations
# by default, which renders most slopes without crushing the rare peak.
mu, sd = shaded.mean(), shaded.std()
shaded = (shaded - mu) / (sd * $DETAIL + 1e-9)
shaded = np.clip(shaded, -1.0, 1.0)
shaded = ((shaded + 1.0) * 127.5).astype(np.uint8)

profile = src.profile
profile.update(dtype='uint8', count=1, compress='deflate', tiled=True, photometric='minisblack')
with rasterio.open('texture.tif', 'w', **profile) as dst:
    dst.write(shaded, 1)
src.close()
PY

# Tile (8-bit greyscale → MBTiles → PMTiles)
rio mbtiles --format png --tile-size 256 --zoom-levels 4..14 texture.tif texture.mbtiles

ARCHIVE="$WORK/ukraine-texture-shading.pmtiles"
pmtiles convert texture.mbtiles "$ARCHIVE"
final_url_hint "$ARCHIVE" "TERRAIN.textureShading.url"
