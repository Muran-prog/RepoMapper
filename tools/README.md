# tools/ — Offline build pipeline

These scripts produce the optional PMTiles archives referenced by
`src/config.js` (TERRAIN.carpathian, TERRAIN.textureShading, TERRAIN.hypsometric,
TERRAIN.ridges, TERRAIN.carpathianOsm, CONTOURS.staticPmtilesUrl).

**The map runs perfectly without any of them.** The baseline
`TERRAIN.primary` points at the AWS Open Data Mapzen terrain tiles, which
is enough for hillshade, 3D terrain and dynamic contours via
maplibre-contour. The PMTiles archives below add region-specific detail:

| Archive                       | Why you'd build it                                    | Script                          |
| ----------------------------- | ----------------------------------------------------- | ------------------------------- |
| `carpathian-glo30.pmtiles`    | 30 m DEM (vs. Mapzen's 90 m there), maxzoom 14        | `build-carpathian-dem.sh`       |
| `ukraine-texture-shading.pmtiles` | Leland Brown α=0.8 ridge/canyon emphasis          | `build-texture-shading.sh`      |
| `<ramp>-<theme>-hypso.pmtiles` | Per-ramp pre-rendered hypsometric tint (raster fallback for the native color-relief layer) | `build-hypso.sh --ramp=<id>` |
| `black-sea-bathy.pmtiles`     | GEBCO 2024 seabed tint, joins seamlessly at 0 m       | `build-bathymetry.sh`           |
| `carpathian-contours.pmtiles` | Pre-baked contours (lighter on CPU than dynamic)      | `build-contours.sh`             |
| `carpathian-ridges.pmtiles`   | WhiteboxTools ridge lines (Imhof enhancement)         | `build-ridges.sh`               |
| `carpathian-osm.pmtiles`      | Custom Planetiler with hiking_route / mountain_feature| `build-carpathian-osm.sh`       |

Hosting: any static HTTPS endpoint with `Range:` support. Cloudflare R2,
Backblaze B2, Bunny CDN, AWS S3 with the right CORS — all work. PMTiles
is designed for this.

## Required tools

| Script                    | Needs                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| build-carpathian-dem.sh   | `aws` (AWS CLI v2), `gdal` ≥ 3.4, `rio-rgbify`, `pmtiles` (Protomaps CLI)             |
| build-texture-shading.sh  | `python3`, `numpy`, `scipy`, `rasterio`, `rio-mbtiles`, `pmtiles`                     |
| build-hypso.sh            | `gdal` ≥ 3.4, `rio-mbtiles`, `pmtiles`, `node` ≥ 18 (runs `dump-ramp.mjs`)            |
| build-bathymetry.sh       | `gdal` ≥ 3.4, `rio-mbtiles`, `pmtiles`, `node` ≥ 18, GEBCO 2024 source TIFF (`$GEBCO`) |
| build-contours.sh         | `gdal`, `tippecanoe` (Felt fork), `pmtiles`                                           |
| build-ridges.sh           | `whitebox_tools`, `gdal`, `tippecanoe`, `pmtiles`                                     |
| build-carpathian-osm.sh   | `java` ≥ 17, `planetiler.jar`, `pmtiles`, ~16 GB RAM                                  |

Install pmtiles CLI: `go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest`
(or download a release binary from <https://github.com/protomaps/go-pmtiles/releases>).

Install tippecanoe (Felt fork, preferred):
`brew install tippecanoe` on macOS or build from <https://github.com/felt/tippecanoe>.

Install WhiteboxTools: <https://www.whiteboxgeo.com/geospatial-software/>.

Install Planetiler: <https://github.com/onthegomap/planetiler/releases> →
download `planetiler.jar`, drop it next to the scripts (or set `PLANETILER_JAR`).

## Workflow

1. **Pick the bbox.** All Carpathian scripts read it from
   `src/config.js::CARPATHIAN.bbox` via a tiny grep in the shell scripts.
   Edit there if you want a different region.

2. **Run scripts in any order** — they don't depend on each other. Each
   one prints a single line at the end with the URL pattern to set in
   `src/config.js` (e.g. `TERRAIN.carpathian.url = 'pmtiles://https://…'`).

3. **Upload** the resulting `.pmtiles` to your static host. Make sure
   the host serves `Accept-Ranges: bytes` and CORS allows your map's origin.

4. **Update config.** Replace the placeholder `null` URLs in `src/config.js`
   with the real `pmtiles://` URLs of your hosted archives. Then reload
   the map — the layers light up automatically.

## Notes per archive

### Carpathian DEM (Copernicus GLO-30)

- License: Copernicus DEM, free, redistributable.
- Source: <https://copernicus-dem-30m.s3.amazonaws.com/> (Open Data,
  no signing required).
- The Carpathian bbox covers 5° × 2° at 30 m resolution — about 0.6 GB
  of raw GeoTIFFs before tiling. Final PMTiles is ~80 MB.

### Texture shading (Leland Brown α=0.8)

- The included Python implementation does a 2-D FFT, applies the
  `|k|^α` operator, and inverse-transforms. For Ukraine + the
  Carpathian bbox the entire DEM fits comfortably in 8 GB RAM.

### Hypsometric tint

- Ramps are sourced from `src/style/hypso/ramps.js` — every named preset
  (Patterson, Raisz–Henry, Swiss alpine, OSM physical, Carpathian focus,
  Steppe flat, Colourblind-safe) has light + dark variants and includes
  bathymetry stops below 0 m so the seabed and the land tint share their
  coastline colour without a seam.
- `tools/dump-ramp.mjs` parses the dictionary directly and emits a
  gdaldem-compatible ramp text. The shell script invokes it under the
  hood — run `tools/dump-ramp.mjs --list` to see all preset ids.
- Stops are densified in CIELAB (no npm deps, ≤50 LOC inline converter
  in `src/style/hypso/color.js`) before being handed to gdaldem so the
  pre-rendered raster matches the native color-relief layer's
  perceptually-uniform appearance.
- `--ramp=all` builds every preset; `--theme=both` builds light + dark
  variants. Add the resulting URLs to `HYPSO.rasterUrls` in
  `src/config.js` for the runtime raster-fallback path.

### Bathymetry (GEBCO 2024)

- Free dataset, CC0 / attribution-only (`gebco.net`). Download the
  global TIFF, point `GEBCO=…` at it, and run `build-bathymetry.sh`.
- The script reuses one of the hypso ramp's negative-elevation stops so
  the seabed colour blends seamlessly with the land tint at the 0 m
  coastline. Override with `--ramp=<id>` to match a different default
  ramp.
- Default bbox covers the Black Sea + Sea of Azov shelf where the
  Mapzen Terrarium DEM has no usable depth data.

### Contours

- maplibre-contour generates these dynamically at runtime by default;
  this static archive is faster on weaker GPUs and lets you label
  with a custom font/halo via tippecanoe attrs.

### Ridges

- WhiteboxTools `FindRidges` runs on a smoothed copy of the DEM
  (Gaussian σ=2). Setting σ lower produces more, finer ridge lines —
  edit `build-ridges.sh` to taste.

### Carpathian OSM

- Custom Planetiler profile (`carpathian-profile.yml`) creates the
  source-layers the renderer expects: `hiking_route`, `mountain_feature`,
  `forest_road`, `ski_piste`, `cableway`. Reads the Ukraine extract
  from <https://download.geofabrik.de/europe/ukraine.html>.
