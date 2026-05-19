# tools/ — Offline build pipeline

These scripts produce the optional PMTiles archives referenced by
`src/config.js` (TERRAIN.carpathian, TERRAIN.textureShading, TERRAIN.hypsometric,
TERRAIN.skyViewFactor, TERRAIN.worldcover, TERRAIN.ridges, TERRAIN.carpathianOsm,
CONTOURS.staticPmtilesUrl).

**The map runs perfectly without any of them.** The baseline
`TERRAIN.primary` points at the AWS Open Data Mapzen terrain tiles, which
is enough for hillshade, 3D terrain and dynamic contours via
maplibre-contour. The PMTiles archives below add region-specific detail:

| Archive                       | Why you'd build it                                    | Script                          |
| ----------------------------- | ----------------------------------------------------- | ------------------------------- |
| `carpathian-fabdem.pmtiles` (recommended) | Bare-earth 30 m DEM (forest canopy + buildings removed). Fixes hillshade noise + contour staircasing in the 700-1500 m forest zone. **CC BY-NC 4.0 — non-commercial only.** | `build-carpathian-fabdem.sh` |
| `carpathian-glo30.pmtiles`    | 30 m DSM, free for any use including commercial (Copernicus). Includes canopy. | `build-carpathian-dem.sh`       |
| `ukraine-texture-shading.pmtiles` | Leland Brown α=0.8 ridge/canyon emphasis          | `build-texture-shading.sh`      |
| `carpathian-svf.pmtiles`      | Sky-View Factor wash — multiplies darkening into canyons / cirques / rock terraces | `build-svf.sh`                  |
| `<region>-worldcover.pmtiles` | ESA WorldCover 10 m landcover-tint multiply-blend overlay (forest / grass / cropland / built-up / bare / snow read by their actual satellite class) | `build-worldcover.sh`           |
| `<ramp>-<theme>-hypso.pmtiles` | Per-ramp pre-rendered hypsometric tint (raster fallback for the native color-relief layer) | `build-hypso.sh --ramp=<id>` |
| `black-sea-bathy.pmtiles`     | GEBCO 2024 seabed tint, joins seamlessly at 0 m       | `build-bathymetry.sh`           |
| `carpathian-contours.pmtiles` | Pre-baked contours (lighter on CPU than dynamic)      | `build-contours.sh`             |
| `carpathian-ridges.pmtiles`   | WhiteboxTools ridge lines (Imhof enhancement)         | `build-ridges.sh`               |
| `carpathian-osm.pmtiles`      | Custom Planetiler with hiking_route / mountain_feature| `build-carpathian-osm.sh`       |

Hosting: any static HTTPS endpoint with `Range:` support. Cloudflare R2,
Backblaze B2, Bunny CDN, AWS S3 with the right CORS — all work. PMTiles
is designed for this.

## FABDEM (recommended)

[FABDEM v1.2](https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7)
(Hawker, Uhe, Paulo et al., 2022) is a global 30 m bare-earth DEM derived
from Copernicus GLO-30 with forest canopy heights and built structures
removed via deep-learning trained on ICESat-2 returns. In the Ukrainian
Carpathian forest zone (700-1500 m) GLO-30 inherits 10-25 m of canopy
noise that produces a "buzzing" hillshade and visible staircasing in
10 m contour lines; FABDEM replaces those slopes with a clean bare-earth
surface that hillshade reads smoothly.

### Cost: license

FABDEM is published under **Creative Commons BY-NC 4.0** —
**non-commercial use only**. If you redistribute the resulting
PMTiles archive in a commercial context, fall back to
`build-carpathian-dem.sh` (Copernicus GLO-30, free for any use).

The renderer auto-emits the right attribution string based on
`TERRAIN.carpathian.demSource` (`'fabdem'` or `'glo30'`); the UI also
surfaces a small "non-commercial" disclaimer when the FABDEM build
is active. See `getCarpathianAttribution()` and
`isCarpathianLicenseNonCommercial()` in `src/config.js`.

### Download

There is no public S3 bucket — you must accept the dataset's ToS on
the Bristol distribution page once, then download the relevant tiles
manually:

1. Visit <https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7>
2. Accept CC BY-NC 4.0.
3. Download the `.zip` files covering your bbox and unpack them into
   one flat directory of GeoTIFFs (`<lat><lon>_FABDEM_V1-2.tif` naming).
4. Run:

   ```bash
   FABDEM_DIR=/path/to/fabdem-v1-2/ tools/build-carpathian-fabdem.sh
   ```

For the Ukrainian Carpathian bbox `[22, 47.6, 27, 49.5]` you need six
tiles (N47E022 .. N49E026 inclusive) — about 80 MB compressed.

### GLO-30 vs FABDEM

| Property                | GLO-30 (DSM)                | FABDEM v1.2 (bare-earth)        |
| ----------------------- | --------------------------- | ------------------------------- |
| Forest cleanup          | None — canopy is in the DEM | Trees removed via ICESat-2 DL   |
| Hillshade smoothness    | Buzzing in forest zone      | Smooth, follows ground          |
| 10 m contour staircase  | Visible at z14+ in forest   | Largely gone                    |
| Building heights        | Roof tops included          | Buildings removed               |
| Resolution              | 30 m (1 arcsec)             | 30 m (1 arcsec)                 |
| License                 | Free, including commercial  | CC BY-NC 4.0 (non-commercial)   |
| Distribution            | s3://copernicus-dem-30m/    | Manual download (Bristol mirror) |
| Build script            | `build-carpathian-dem.sh`   | `build-carpathian-fabdem.sh`    |

`build-carpathian-dem.sh` stays around as the commercial-friendly
fallback — both scripts produce the same Terrarium-PMTiles shape, so
swapping the URL in `TERRAIN.carpathian.url` is the only change
required to flip between them. Toggle `TERRAIN.carpathian.demSource`
to match so the attribution and licensing disclaimer track the build.

## Required tools

| Script                         | Needs                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| build-carpathian-dem.sh        | `aws` (AWS CLI v2), `gdal` ≥ 3.4, `rio-rgbify`, `pmtiles` (Protomaps CLI)             |
| build-carpathian-fabdem.sh     | `gdal` ≥ 3.4, `rio-rgbify`, `pmtiles`, manual FABDEM download (`FABDEM_DIR`)          |
| build-texture-shading.sh       | `python3`, `numpy`, `scipy`, `rasterio`, `rio-mbtiles`, `pmtiles`                     |
| build-svf.sh                   | `whitebox_tools`, `python3`, `numpy`, `rasterio`, `rio-mbtiles`, `pmtiles`            |
| build-worldcover.sh            | `aws` (AWS CLI v2, anonymous), `gdal` ≥ 3.4, `rio-mbtiles`, `pmtiles`, `node` ≥ 18    |
| build-hypso.sh                 | `gdal` ≥ 3.4, `rio-mbtiles`, `pmtiles`, `node` ≥ 18 (runs `dump-ramp.mjs`)            |
| build-bathymetry.sh            | `gdal` ≥ 3.4, `rio-mbtiles`, `pmtiles`, `node` ≥ 18, GEBCO 2024 source TIFF (`$GEBCO`) |
| build-contours.sh              | `gdal`, `tippecanoe` (Felt fork), `pmtiles`                                           |
| build-ridges.sh                | `whitebox_tools`, `gdal`, `tippecanoe`, `pmtiles`                                     |
| build-carpathian-osm.sh        | `java` ≥ 17, `planetiler.jar`, `pmtiles`, ~16 GB RAM                                  |

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

### Sky-View Factor (WhiteboxTools)

- Lindsay's `SkyViewFactor` tool scores each pixel by the fraction
  of the upper hemisphere visible from it. Narrow valleys, canyons,
  cirque rims and rock terraces all read as low SVF (dark) while
  open ridges and plateaus read as high SVF (light).
- The build script normalises the raw 0..1 raster to 8-bit grey,
  then INVERTS it so dark pixels = enclosed terrain. The renderer
  then layers it as a multiply-style overlay (`raster-saturation: -1`,
  zoom-aware opacity) above the hillshade so hillshade-shaded
  ravines pick up an extra darkening pass.
- Defaults: 16 horizon azimuths, 1 km max search distance — tuned
  for ~30 m DEM detail. Override via `AZIMUTHS`, `MAX_DIST` env vars.
- Cost: ~5-10 minutes CPU on the Carpathian bbox.

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

### WorldCover landcover-tint

- ESA WorldCover 10 m global landcover product (v200, 2021), distributed
  via the AWS Open Data registry at `s3://esa-worldcover/v200/2021/map/`.
  Anonymous access — no AWS credentials required (the build script uses
  `aws s3 cp --no-sign-request`).
- Tile naming: `ESA_WorldCover_10m_2021_v200_<lat><lon>_Map.tif` covers a
  3° × 3° block keyed by its south-west corner (e.g. `N48E021`). The
  Ukraine bbox needs ~30 tiles (~250 MB compressed raw). Final PMTiles
  is ~30 MB after gdaldem + rio-mbtiles + pmtiles convert at zoom 6-13.
- Colour table is emitted by `tools/dump-worldcover-ramp.mjs`, which
  reads `src/style/worldcover-ramps.js` directly so the offline raster
  pixels match the live MapLibre tokens at every theme. Adding a class
  is one edit to one file. Run `tools/dump-worldcover-ramp.mjs --list-classes`
  to see the canonical class table.
- License: **CC BY 4.0**, ESA / VITO / Brockmann Consult / CS / Gamma
  Remote Sensing / IIASA / WUR. Attribution is required wherever the
  resulting tiles are rendered. The renderer's source descriptor in
  `TERRAIN.worldcover.attribution` carries the canonical attribution
  string and the MapLibre attribution control surfaces it whenever the
  source is active.
- The water class (value 80) is rendered transparent so the vector
  `water_polygon` layer remains the canonical land-mask. The renderer
  also stacks the raster BELOW `water_fill` in z-order — defence in
  depth so coastline approximations never tint blue.
- Defaults: `--region=ukraine` (Pan-Ukraine bbox), `--theme=both`
  (light + dark colour tables). Pass `--region=carpathian` for the
  Carpathian-only build (~30 MB raw) or `--bbox=W,S,E,N` for an
  arbitrary AOI.

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
