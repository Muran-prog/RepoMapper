/**
 * Cart — global configuration.
 *
 * Single source of truth for view defaults, source descriptors and feature
 * flags. Anything tunable from outside the rendering pipeline lives here so
 * the rest of the codebase stays free of magic numbers.
 */

// ---------------------------------------------------------------------------
// View defaults — Ukraine
// ---------------------------------------------------------------------------

/** Geographic centroid of Ukraine, used as the initial camera target. */
export const UKRAINE_CENTER = [31.1656, 48.3794];

/** SW/NE corners of the Ukrainian extent (incl. Crimea), padded slightly. */
export const UKRAINE_BOUNDS = [
  [22.0, 44.0], // sw
  [40.5, 52.5], // ne
];

/** Hard constraints on the camera. maxZoom is intentionally aggressive. */
export const VIEW = Object.freeze({
  center: UKRAINE_CENTER,
  zoom: 5.6,
  pitch: 0,
  bearing: 0,
  minZoom: 3,
  maxZoom: 22,
  maxBounds: [
    [10.0, 38.0],
    [55.0, 58.0],
  ],
});

// ---------------------------------------------------------------------------
// Tile sources
// ---------------------------------------------------------------------------
//
// Default backend: OpenFreeMap (free, no API keys, OpenMapTiles schema).
//
// Their tiles live under date-versioned URLs (e.g. .../planet/20250507_001001_pt/...),
// but the TileJSON endpoint at https://tiles.openfreemap.org/planet always
// resolves to the freshest dataset, so we let MapLibre discover tile URLs
// through that.
//
// The createMap module also fetches the upstream Liberty style JSON once at
// boot to obtain the auto-versioned `glyphs` and `sprite` URLs, which keeps
// us decoupled from any URL-format churn on the OpenFreeMap side.
//
// PMTiles support is wired up too — see map/createMap.js where the
// pmtiles:// protocol is registered. To consume a PMTiles archive instead of
// the live tile server, set SOURCE_BACKEND to 'pmtiles' and point
// PMTILES_URL at any OpenMapTiles-schema PMTiles file. No other code changes
// required.

export const SOURCE_BACKEND = 'openfreemap'; // 'openfreemap' | 'pmtiles'

export const OPENFREEMAP = Object.freeze({
  /** TileJSON endpoint — auto-resolves to the latest dataset. */
  tilejson: 'https://tiles.openfreemap.org/planet',
  /** Upstream style we mine for `glyphs`/`sprite`/source descriptors. */
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  /**
   * Hardcoded fallbacks used only when the upstream style fetch fails.
   * The sprite URL is versioned upstream (e.g. `ofm_f384/ofm`); we point
   * the fallback at the latest known revision but expect the runtime
   * fetch to discover the freshest one. Glyphs are stable.
   */
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  attribution:
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>' +
    ' · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
});

export const PMTILES = Object.freeze({
  /** Replace with your own OpenMapTiles-schema PMTiles archive. */
  url: 'pmtiles://https://example.com/ukraine.pmtiles',
  attribution:
    '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>' +
    ' · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
});

// ---------------------------------------------------------------------------
// Terrain, contours & Carpathian overlays.
// ---------------------------------------------------------------------------
//
// Everything relief-related routes through PMTiles archives or public
// Terrarium-encoded tile endpoints. Nothing below hits a paid service or
// requires an API key.
//
// The baseline raster-DEM is the AWS Open Data "Terrain Tiles" bucket
// (a.k.a. Mapzen / elevation-tiles-prod) — stable public HTTP tiles,
// Terrarium-encoded, maxzoom 15 globally. To run entirely off a PMTiles
// archive, set TERRAIN.primary.url to `pmtiles://…` and clear `tiles`.
//
// Carpathian, hypsometric, texture-shading, ridge and OSM-overlay archives
// are all URL placeholders — they don't exist on a public host, you
// generate them from tools/ (see tools/README.md) and host them yourself.
// The renderer degrades gracefully when a URL is null: the corresponding
// layer is simply not emitted.

/** @typedef {object} RasterDemSpec
 *  @property {string|null}   [url]          Optional single tileset URL (pmtiles:// or tilejson).
 *  @property {string[]|null} [tiles]        Optional raw tile URL templates.
 *  @property {string}        encoding       'terrarium' | 'mapbox' | 'custom'.
 *  @property {number}        tileSize       Usually 256 for Terrarium PNG.
 *  @property {number}        minzoom
 *  @property {number}        maxzoom
 *  @property {string}        [attribution]
 *  @property {Array<[number, number, number, number]>} [bounds] [w,s,e,n]
 */

/** @typedef {object} RasterPmtilesSpec
 *  @property {string|null} url             pmtiles://https URL, or null to disable.
 *  @property {number}      tileSize
 *  @property {number}      minzoom
 *  @property {number}      maxzoom
 *  @property {string}      [attribution]
 */

/** @typedef {object} VectorPmtilesSpec
 *  @property {string|null} url             pmtiles://https URL, or null to disable.
 *  @property {string}      [attribution]
 */

export const TERRAIN = Object.freeze({
  /**
   * Baseline DEM. AWS Terrain Tiles (Mapzen, Terrarium encoding) is a
   * long-running Open Data public endpoint — no key, no signing. Its
   * native zoom range is 0–15.
   *
   * To switch to a PMTiles archive, set `url` to `pmtiles://https://…` and
   * leave `tiles: []`. MapLibre will route through the pmtiles protocol.
   */
  primary: Object.freeze({
    url: null,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 12, // we overzoom past this anyway; keeping 12 matches Protomaps baseline
    attribution:
      'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen Terrain Tiles</a>',
  }),
  /**
   * Carpathian ultra-detail DEM built from Copernicus GLO-30 clipped to
   * the `CARPATHIAN.bbox`. Generate with `tools/build-carpathian-dem.sh`
   * and host the resulting PMTiles anywhere (Cloudflare R2, S3, Bunny).
   *
   * Until you set `url`, the map falls back to the primary DEM inside the
   * Carpathian bbox — functional, just lower-resolution.
   */
  carpathian: Object.freeze({
    url: null, // e.g. 'pmtiles://https://pub-you.r2.cloudflarestorage.com/carpathian-fabdem.pmtiles'
    tiles: null,
    encoding: 'terrarium',
    tileSize: 256,
    minzoom: 5,
    maxzoom: 14,
    bounds: [22.0, 47.6, 27.0, 49.5],
    /**
     * Which DEM the URL above was generated from.
     *
     *   'fabdem' (default) — FABDEM v1.2 (Hawker et al., 2022). Bare-earth,
     *                        canopy + buildings removed. Built via
     *                        `tools/build-carpathian-fabdem.sh`. Hillshade
     *                        and contours read clean inside the forest
     *                        zone (700-1500 m). LICENSE: CC BY-NC 4.0
     *                        — non-commercial use only. Operators with
     *                        commercial deployments must switch to GLO-30.
     *   'glo30'             — Copernicus GLO-30 (DSM, includes canopy).
     *                        Built via `tools/build-carpathian-dem.sh`.
     *                        Free for any use including commercial.
     *
     * The `attribution` and `licenseNonCommercial` fields below are derived
     * from this field; the renderer + UI read the resolved values via
     * `getCarpathianAttribution()` / `isCarpathianLicenseNonCommercial()`.
     */
    demSource: 'fabdem',
  }),
  /**
   * Pre-rendered texture shading (Leland Brown, α=0.8) as a raster PMTiles
   * archive. Build with `tools/build-texture-shading.sh`.
   */
  textureShading: Object.freeze({
    url: null, // pmtiles://https://…/ukraine-texture-shading.pmtiles
    tileSize: 256,
    minzoom: 4,
    maxzoom: 14,
    attribution: 'Texture shading: Leland Brown (CC BY)',
  }),
  /**
   * Pre-rendered hypsometric tint. Generated via gdaldem color-relief
   * with one of the ramp presets in `src/style/hypso/ramps.js` (see
   * tools/build-hypso.sh). When the runtime supports the native
   * MapLibre `color-relief` layer we route through that instead and
   * leave this archive cold; see FEATURES.colorRelief + the HYPSO
   * block below for finer-grained control.
   *
   * Per-ramp URLs live in HYPSO.rasterUrls — this URL is the legacy
   * default, kept for backwards compatibility with older builds.
   */
  hypsometric: Object.freeze({
    url: null, // pmtiles://https://…/ukraine-hypso.pmtiles
    tileSize: 256,
    minzoom: 2,
    maxzoom: 12,
    attribution: 'Hypsometric tint: generated from DEM',
  }),
  /**
   * Bathymetry — pre-rendered seabed tint built from GEBCO 2024
   * (CC0 / attribution-only). Stacks seamlessly with the hypsometric
   * ramp at the 0 m coastline because each ramp preset carries
   * negative-elevation stops; bathymetry colours the open-sea polygons
   * where the DEM is too coarse to give the GPU usable height. See
   * tools/build-bathymetry.sh for the build.
   */
  bathymetry: Object.freeze({
    url: null, // pmtiles://https://…/black-sea-bathy.pmtiles
    tileSize: 256,
    minzoom: 3,
    maxzoom: 9,
    attribution:
      'Bathymetry: <a href="https://www.gebco.net" target="_blank" rel="noopener">GEBCO 2024</a>',
  }),
  /**
   * Ridge/valley vector overlay for Imhof-style enhancement. Two paired
   * line layers (dark offset +0.2, light −0.2). Build with
   * `tools/build-ridges.sh`.
   */
  ridges: Object.freeze({
    url: null, // pmtiles://https://…/carpathian-ridges.pmtiles
    attribution: 'Ridge extraction: WhiteboxTools',
  }),
  /**
   * Carpathian OSM overlay (custom Planetiler profile). Adds source-layers
   * not exposed by upstream OpenMapTiles: hiking_route, mountain_feature,
   * forest_road, ski_piste, cableway. Build with
   * `tools/build-carpathian-osm.sh` using `tools/carpathian-profile.yml`.
   */
  carpathianOsm: Object.freeze({
    // Carpathian OSM overlay published from the repo's gh-pages branch.
    // 33 MB, zoom 8-14, bbox 22.0,47.6,27.0,49.5. Built locally from
    // the Geofabrik Ukraine extract via tools/build-carpathian-osm.sh
    // and committed as a static binary to keep deploys turn-key.
    // raw.githubusercontent.com supports HTTP Range requests, so the
    // pmtiles:// protocol works directly without a separate host.
    url: 'pmtiles://https://raw.githubusercontent.com/Muran-prog/RepoMapper/gh-pages/carpathian-osm.pmtiles',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }),
  /**
   * Zoom-adaptive exaggeration curve for `map.setTerrain`. Grows gently
   * with zoom so low-zoom overview stays near-flat (no weird peak spikes
   * over the Polish border) while city/alpine zooms get a real 3D feel.
   * The user-controllable slider in the UI multiplies these values.
   */
  exaggerationStops: [
    [5, 0.0],
    [7, 0.6],
    [9, 1.0],
    [11, 1.25],
    [14, 1.5],
  ],
  /** Terrain 3D is suppressed below this zoom — hillshade stays 2D. */
  terrain3DMinZoom: 7,

  /**
   * Sky-View Factor — Lindsay's whitebox-tools relief layer that scores
   * each pixel by the fraction of the upper hemisphere that is visible
   * (0..1). Inverted, it darkens canyons, narrow valleys, cirque edges
   * and rock terraces — features hillshade smears out at low azimuths.
   *
   * Stacks on top of hillshade as a multiply-style overlay. The runtime
   * uses `raster-saturation: -1` + zoom-aware opacity so it reads as a
   * grayscale wash on every theme.
   *
   * Build: tools/build-svf.sh (consumes the same DEM that backs
   * `carpathian` above, runs whitebox_tools SkyViewFactor with 16
   * azimuths and a 1 km horizon, then tiles + PMTiles converts).
   */
  skyViewFactor: Object.freeze({
    url: null, // pmtiles://https://…/carpathian-svf.pmtiles
    tileSize: 256,
    minzoom: 7,
    maxzoom: 14,
    attribution: 'SVF: <a href="https://www.whiteboxgeo.com/" target="_blank" rel="noopener">WhiteboxTools</a> (Lindsay)',
  }),

  /**
   * ESA WorldCover landcover-tint — pre-rendered raster PMTiles archive
   * built from the ESA + VITO 10 m global landcover product (v200, 2021).
   * The build pipeline (`tools/build-worldcover.sh`) gdaldems each
   * 3°×3° AWS Open Data tile through the colour table emitted by
   * `tools/dump-worldcover-ramp.mjs`, mosaics the results in EPSG:3857,
   * and tiles 6-13 → PMTiles.
   *
   * The renderer composes a multiply-blend raster layer over the
   * vector landuse polygons so forest / grass / cropland / built-up /
   * bare-rock surfaces read by their actual satellite-classified
   * colour rather than as one flat green polygon.
   *
   * Stays disabled until the operator points `url` at a real archive
   * — the source/layer composer in `sources.js` + `terrain.js` skip
   * the layer entirely when `url === null`, keeping the validator
   * green and the cold-boot render byte-identical to the previous
   * version.
   *
   * License: ESA WorldCover 10 m 2021 v200 is published under
   * **CC BY 4.0**. The attribution string below is rendered in the
   * MapLibre attribution control whenever the source is active.
   */
  worldcover: Object.freeze({
    // Carpathian WorldCover landcover-tint published from the repo's
    // gh-pages branch — same hosting model as carpathian-osm.pmtiles.
    // 80 MB, zoom 6-13, bbox 22.0,47.6,27.0,49.5. Built locally from
    // the AWS Open Data ESA WorldCover bucket via
    // tools/build-worldcover.sh and committed as a static binary so
    // deploys stay turn-key. raw.githubusercontent.com supports HTTP
    // Range requests, so the pmtiles:// protocol works directly.
    url: 'pmtiles://https://raw.githubusercontent.com/Muran-prog/RepoMapper/gh-pages/carpathian-worldcover.pmtiles',
    tileSize: 256,
    minzoom: 6,
    maxzoom: 13,
    attribution:
      '<a href="https://esa-worldcover.org" target="_blank" rel="noopener">ESA WorldCover 10m 2021 v200</a> · CC BY 4.0',
  }),

  /**
   * ETH Global Canopy Height (Lang et al. 2023) — modulates the
   * WorldCover tree-cover wash by per-pixel canopy top height. The
   * raster is a pre-rendered 8-bit RGBA PNG mosaic produced by
   * `tools/build-canopy-height.sh`; the colour table is emitted by
   * `tools/dump-canopy-ramp.mjs` from `src/style/canopy-height-ramps.js`
   * so the offline pixels match the live tokens at every theme.
   *
   * Stack position: ABOVE WorldCover (it details the tree-cover class
   * specifically) but BELOW texture-shading and contours so the
   * ridge / drainage / topographic structure stays the dominant
   * cartographic signal. Source-gated — `url === null` means
   * the operator hasn't run the build yet, so the layer composer
   * skips the layer entirely (graceful fallback).
   *
   * License: CC BY 4.0. Attribution string carries the canonical
   * author + project link; the MapLibre attribution control surfaces
   * it whenever the source is active.
   */
  canopyHeight: Object.freeze({
    url: null, // pmtiles://https://…/<region>-canopy.pmtiles
    tileSize: 256,
    minzoom: 8,
    maxzoom: 13,
    attribution:
      '<a href="https://langnico.github.io/globalcanopyheight/" target="_blank" rel="noopener">ETH Global Canopy Height 10m (Lang et al. 2023)</a> · CC BY 4.0',
  }),

  /**
   * High-detail 10 m forest VECTOR overlay for the Carpathians, derived
   * from ESA WorldCover 10 m 2021 v200 (class 10 = Tree cover). Built
   * offline by `tools/build-forest10m.sh`: the tree class is masked,
   * polygonised, then tiled with tippecanoe into a vector PMTiles archive
   * (source-layer `forest`).
   *
   * Purpose: `forestCover` normally paints the GLOBAL OpenMapTiles
   * `landcover` source, which is capped at z14 and generalised. Inside the
   * Carpathian bbox this archive supplies far crisper, satellite-accurate
   * 10 m stand boundaries up to z14. Source-gated like the other PMTiles
   * overlays — `url === null` (or a missing archive) makes the composer
   * skip the high-detail layers and fall back to the global landcover
   * forest, so cold-boot stays turn-key.
   *
   * Hosting: committed to the repo's gh-pages branch — same model as
   * carpathian-osm.pmtiles / carpathian-worldcover.pmtiles.
   * ~bbox 22.0,47.6,27.0,49.5, zoom 6-14.
   *
   * License: ESA WorldCover 10 m 2021 v200 — CC BY 4.0.
   */
  forest10m: Object.freeze({
    url: 'pmtiles://https://raw.githubusercontent.com/Muran-prog/RepoMapper/gh-pages/carpathian-forest-10m.pmtiles',
    minzoom: 6,
    maxzoom: 14,
    attribution:
      '<a href="https://esa-worldcover.org" target="_blank" rel="noopener">ESA WorldCover 10m 2021 v200</a> · CC BY 4.0',
  }),
});

/**
 * Resolve the human-readable attribution string for the active Carpathian
 * DEM. Picks GLO-30 vs FABDEM based on TERRAIN.carpathian.demSource so
 * operators can switch builds without editing two strings.
 *
 * @param {object} [terrain=TERRAIN]
 * @returns {string}
 */
export function getCarpathianAttribution(terrain = TERRAIN) {
  const src = terrain?.carpathian?.demSource;
  if (src === 'fabdem') {
    return 'DEM: <a href="https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7" target="_blank" rel="noopener">FABDEM v1.2</a> © Fathom (CC BY-NC 4.0)';
  }
  // 'glo30' (and any unknown value) — fall back to the always-free DEM.
  return 'DEM: <a href="https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model" target="_blank" rel="noopener">Copernicus GLO-30</a>';
}

/**
 * True when the active Carpathian DEM is licensed for non-commercial
 * use only. The HUD / About panel reads this to surface a small
 * "non-commercial" disclaimer next to the attribution; the build
 * tooling reads it to remind the operator about the redistribution
 * constraint.
 *
 * @param {object} [terrain=TERRAIN]
 * @returns {boolean}
 */
export function isCarpathianLicenseNonCommercial(terrain = TERRAIN) {
  return terrain?.carpathian?.demSource === 'fabdem';
}

/**
 * Hypsometric subsystem configuration.
 *
 * The visual ramps themselves live in `src/style/hypso/ramps.js` —
 * they are palette tokens, not config. This block controls:
 *
 *   • Which ramp is active on cold boot
 *   • Default strength (0..1.5 multiplier on the opacity curve)
 *   • Which paths are reachable (native / raster / off) and the raster
 *     PMTiles archives mapped to each ramp id
 *   • Whether the live ramp editor is shown
 *   • Region → ramp auto-pick mapping for the viewport heuristic
 *
 * Operations the user can drive from the UI:
 *
 *   ramp switch          setPaintProperty('color-relief-color', expr)
 *                        (native) or surgical source swap (raster)
 *   strength slider      setPaintProperty(['*-opacity'], expr)
 *   bathymetry toggle    re-emits ramp expression with / without
 *                        negative-elevation stops
 *   custom ramps         persisted in localStorage under HYPSO.storageKey
 *
 * @typedef {object} HypsoConfig
 * @property {string}  defaultRampId       Initial ramp id.
 * @property {number}  defaultStrength     Initial strength (0..1.5).
 * @property {boolean} bathymetryDefault   Render negative-elevation stops.
 * @property {boolean} highContrastDefault Pump LAB lightness gap.
 * @property {boolean} editorEnabled       Mount the live ramp editor UI.
 * @property {boolean} legendEnabled       Mount the gradient legend.
 * @property {boolean} viewportStats       Compute live min/mean/max.
 * @property {boolean} profileMode         Enable elevation-profile drawing.
 * @property {string}  storageKey          localStorage key for custom ramps.
 * @property {boolean} preferNative        When true, prefer the native
 *                                          color-relief layer if support
 *                                          is detected; falls back to
 *                                          raster otherwise.
 * @property {Record<string, string|null>} rasterUrls
 *     Map of rampId → pmtiles URL (raster fallback). Null means the
 *     ramp has no raster archive yet — UI hides it from the picker when
 *     mode is forced to 'raster'.
 * @property {Record<string, string>} regionRamp
 *     Default ramp id per detected viewport region.
 */
export const HYPSO = Object.freeze({
  // Tourist-atlas vivid rainbow is the default — that's what users
  // expect when they hear "hypsometric tint" without further context.
  // The other six presets (Patterson, Raisz-Henry, Swiss alpine, OSM
  // physical, Carpathian focus, Steppe flat, Colourblind-safe) sit
  // one click away in the picker.
  defaultRampId: 'touristAtlas',
  // 1.0 is "as-authored". The default curve in expression.js already
  // peaks near 0.9, so 1.0× lands hypso at ~90 % opacity at overview
  // zooms — heavy enough to dominate without going opaque.
  defaultStrength: 1.0,
  bathymetryDefault: true,
  highContrastDefault: false,
  editorEnabled: true,
  legendEnabled: true,
  viewportStats: true,
  profileMode: true,
  storageKey: 'cart:hypso:custom-ramps:v1',
  preferNative: true,
  rasterUrls: Object.freeze({
    touristAtlas: null,
    patterson: null,
    raiszHenry: null,
    swissAlpine: null,
    osmPhysical: null,
    carpathianFocus: null,
    steppeFlat: null,
    colorblindSafe: null,
  }),
  regionRamp: Object.freeze({
    global: 'touristAtlas',
    alpine: 'swissAlpine',
    carpathian: 'carpathianFocus',
    steppe: 'steppeFlat',
    sea: 'osmPhysical',
  }),
});

export const CONTOURS = Object.freeze({
  /**
   * Rendering mode:
   *   'dynamic' — generated on-the-fly from the DEM via maplibre-contour.
   *               Works anywhere the DEM reaches; no pre-build required.
   *   'static'  — read from a pre-generated contour PMTiles archive
   *               (CONTOURS.staticPmtilesUrl). Faster labels, less CPU.
   *   'hybrid'  — dynamic everywhere, but the Carpathian bbox overlays
   *               a denser static PMTiles when available.
   */
  mode: 'dynamic',
  /**
   * Zoom → [minor_interval_m, major_interval_m]. Lower zooms get very
   * coarse contours (so low-end GPUs don't drown in isolines); deep zooms
   * get 10 m minor / 50 m major, adequate for foot-path navigation.
   */
  thresholdsByZoom: [
    [9, [200, 1000]],
    [11, [100, 500]],
    [13, [50, 250]],
    [14, [20, 100]],
    [15, [10, 50]],
  ],
  /** See tools/build-contours.sh. */
  staticPmtilesUrl: null, // pmtiles://https://…/carpathian-contours.pmtiles
  /** Below this zoom we don't render contours at all, dynamic or static. */
  minzoom: 9,
  /** maplibre-contour worker + tile-cache sizing. */
  workerTileCacheSize: 128,
});

// ---------------------------------------------------------------------------
// Carpathian region — bounding box and per-zoom detail rules.
// ---------------------------------------------------------------------------
//
// The bbox roughly covers the Ukrainian Carpathians with a cushion toward
// the Polish/Slovak/Romanian borders so tile joins look natural. Edit only
// if you know the Copernicus GLO-30 build pipeline is ready for the new
// extent — `tools/build-carpathian-dem.sh` uses this same bbox.

export const CARPATHIAN = Object.freeze({
  /** [west, south, east, north] lon/lat degrees. */
  bbox: [22.0, 47.6, 27.0, 49.5],
  /** Center used by the Carpathian fly-to preset. */
  center: [24.5, 48.3],
  /**
   * Zoom at which a feature tier first becomes visible. Drives minzoom on
   * Carpathian-specific layers so low zooms stay uncluttered.
   *
   * Lowered relative to the original schedule so the trail+road web
   * lights up earlier on overview shots — the brief asks for a network
   * that reads "without zoom". Trails now enter at z9 (was z11),
   * forest roads at z9 (was z11), informal social paths at z12.
   */
  zoomRules: Object.freeze({
    ridges: 8,
    trails: 9,
    informalTrails: 12,
    viaFerrata: 12,
    trailLabels: 12,
    mountainPoi: 11,
    forestRoads: 9,
    peaks: 7,
    passes: 10,
    saddles: 10,
    cableways: 11,
    skiPistes: 11,
    /**
     * Slope-warning overlay — only meaningful at hiking/alpinism
     * zooms where the user is reading individual slopes; below this
     * the red wash adds noise without information.
     */
    slopeWarning: 11,
    /**
     * Forest leaf-type biom polygons (landuse=forest / natural=wood
     * with leaf_type / leaf_cycle / wood / protect_class). The fill
     * comes in early (z8) so the three Carpathian bands —
     * needleleaved Чорногора, broadleaved Закарпаття, mixed slopes
     * 800-1200 m — are readable on overview. Outlines, заповідник
     * accents and named-massif labels enter at progressively deeper
     * zooms so overview reads as a clean colour-band map without
     * line / type clutter. Source-gated by features.forestLeafType
     * AND availability of carpathian-osm; see src/style/index.js.
     */
    forestPolygons: 8,
    forestOutline: 11,
    forestProtect: 9,
    forestLabels: 9,
  }),
  /** Exaggeration multiplier applied on top of TERRAIN.exaggerationStops. */
  exaggerationMul: 1.15,
});

// ---------------------------------------------------------------------------
// Performance & rendering
// ---------------------------------------------------------------------------

export const PERF = Object.freeze({
  /**
   * Aggressive cache size — Ukraine fits comfortably with headroom to
   * spare. DEM tiles live in the same LRU so we size larger than we would
   * for vector-only map.
   */
  maxTileCacheSize: 768,
  /** Allow MapLibre to over-zoom vector tiles past their native maxzoom. */
  maxOverzoomLevel: 6,
  /** Animated tile fade-in duration (ms). 0 = instant pop-in. */
  fadeDuration: 180,
  /** AntialiasingFor smoother lines on high-DPI displays. */
  antialias: true,
  /** WebGL preserve drawing buffer — disable for perf, enable for screenshots. */
  preserveDrawingBuffer: false,
  /** Whether the renderer should run when the tab is hidden. */
  refreshExpiredTiles: true,
});

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------
//
// Every relief-/contour-/Carpathian-specific feature is off-switchable via
// its flag. Turning a flag off removes both the source declaration and the
// corresponding layer(s) from the composed style — no ghost sources.

export const FEATURES = Object.freeze({
  // Base
  buildings3D: true,
  pois: true,
  labels: true,
  hud: true,
  fpsCounter: true,

  // Relief stack — safe defaults: single hillshade + 3D terrain on, but
  // the optional pre-rendered overlays (hypso tint, texture shading,
  // ridges) and the custom Carpathian OSM overlay stay off until you
  // point their TERRAIN.* URLs at real archives.
  hillshade: true,
  terrain3D: true,
  contours: true,
  textureShading: false,
  /**
   * Hypsometric tint — defaults to ON now that the subsystem auto-picks
   * between native `color-relief` (MapLibre ≥ 5.6) and the raster PMTiles
   * fallback. Turn off here only if you want the map to render without
   * any colour-by-elevation wash at all.
   */
  hypsometricTint: true,
  ridgeOverlay: false,
  // Carpathian trail overlay — backed by the gh-pages PMTiles archive
  // configured in TERRAIN.carpathianOsm. 42 extra layers light up
  // inside CARPATHIAN.bbox at z11+.
  carpathian: true,

  /**
   * Hiking-route ribbons — paints OSM `route=hiking` relations from
   * the `hiking_route` source-layer of `carpathian-osm.pmtiles` as
   * continuous coloured underlay-ribbons (per-network red/blue/yellow/
   * green palette, see `src/style/hiking-routes.js`).
   *
   * Stack position: BETWEEN the relief layers (hillshade / hypso /
   * texture) and `carpathian_trail_glow`, so a single named route
   * (Закарпатський ландшафтний шлях, Чорногірський хребет, …) reads
   * as ONE ribbon from start to end while the per-trail SAC-scale
   * dashes still paint clearly on top.
   *
   * Default ON — the gh-pages-hosted carpathian-osm.pmtiles already
   * carries the source-layer (see tools/carpathian-profile.yml). Turn
   * off to render exactly the previous Carpathian trail web with no
   * route ribbons. Source missing OR feature off → silent no-op
   * (graceful fallback in src/style/index.js).
   */
  hikingRoutes: true,

  /**
   * Use MapLibre `projection: { type: 'globe' }` at low zooms. Falls back
   * to plain Mercator below the min-zoom threshold. Only useful on the
   * overview zoom (≤5), so it's off by default.
   */
  globeProjection: false,

  /**
   * Native `color-relief` layer. Probed at runtime via the hypso
   * subsystem's `detectHypsoCaps` helper — when this flag is true AND
   * runtime support is detected, the renderer routes hypso through
   * the GPU's elevation-driven ramp. When false (or runtime probe
   * fails), it falls back to the raster PMTiles path or "off".
   */
  colorRelief: true,

  /**
   * Pre-rendered seabed (GEBCO 2024). Disabled by default until
   * TERRAIN.bathymetry.url is populated by tools/build-bathymetry.sh.
   * Source missing → silent no-op (graceful fallback).
   */
  bathymetry: false,

  /**
   * Sky-View Factor overlay. Off by default — turns on automatically
   * once `TERRAIN.skyViewFactor.url` is wired to a real PMTiles archive.
   * Source missing → silent no-op (graceful fallback in sources.js).
   */
  skyViewFactor: false,

  /**
   * ESA WorldCover landcover-tint — multiply-blend raster overlay
   * driven by the 10 m global classification (Tree / Shrub / Grass /
   * Crop / Built-up / Bare / Snow / Water / Wetland / Mangrove /
   * Moss-lichen). Backed by the gh-pages PMTiles archive configured
   * in `TERRAIN.worldcover.url`. Default ON now that the archive is
   * published; users can toggle it off via the Relief panel and the
   * choice survives reload through `cart:features:worldcoverTint`.
   *
   * Source missing → silent no-op (graceful fallback in sources.js
   * and the layer composer), so any custom build that points the URL
   * at `null` keeps rendering identically to its previous version.
   */
  worldcoverTint: true,

  /**
   * ETH Global Canopy Height tint — multiply-blend raster overlay
   * driven by Lang et al. 2023's 10 m global canopy top-height
   * model. Modulates the WorldCover tree-cover wash by stand age:
   * молоді посадки read as a light grass-green, старі смерекові
   * ліси Чорногори read as a dark emerald, букові праліси Угольки
   * read as the darkest pixels.
   *
   * Off by default — enabled when the operator points
   * `TERRAIN.canopyHeight.url` at a build of
   * `tools/build-canopy-height.sh`. Source missing → silent no-op
   * (graceful fallback in `sources.js` + the layer composer). The
   * user's choice survives a reload via `cart:features:canopyHeightTint`.
   */
  canopyHeightTint: false,

  /**
   * Slope-warning overlay — paints slopes ≥ 35° in translucent red so
   * alpinists and winter hikers can read avalanche-prone terrain at a
   * glance. Renders via the native `color-relief` layer driven by the
   * `['slope']` expression (MapLibre 5.6+); on runtimes without that
   * support the layer is silently dropped (see hypso/detect.js).
   *
   * Off by default — this is a specialised tactical overlay, not a
   * general-purpose relief layer.
   */
  slopeWarning: false,

  /**
   * Forest leaf-type biom polygons — fill landuse=forest /
   * natural=wood polygons by OSM leaf_type so the Carpathian
   * coniferous / broadleaf bands read as distinct biom-colours
   * (cool dark needleleaved Чорногора vs warm yellow-green
   * broadleaved Угольки). Заповідні території get an amber dashed
   * outline; named massifs get italic labels above zoom-aware area
   * thresholds.
   *
   * Off by default — the source-layer `forest_polygon` is added by
   * the latest tools/carpathian-profile.yml but is only present in
   * the published archive once an operator has rebuilt and
   * re-uploaded carpathian-osm.pmtiles. Once that happens, flip
   * this on (here or via the UI toggle in the Relief panel) and
   * the layers light up automatically. Source missing → silent
   * no-op (graceful fallback in src/style/index.js).
   */
  forestLeafType: false,

  /**
   * Forest-cover overlay — a dedicated, toggleable "лесной покров" layer
   * that highlights every wooded polygon in a vivid Google-Earth-style
   * green. Unlike worldcoverTint / canopyHeightTint / forestLeafType
   * (all backed by a hosted Carpathian PMTiles archive), this overlay
   * reads the GLOBAL OpenMapTiles `landcover` class=wood polygons the
   * base map already consumes, so it works country-wide with NO new data
   * dependency and is always available.
   *
   * Off by default — it's an optional thematic overlay the user enables
   * from the Relief panel. The choice is persisted under
   * `cart:features:forestCover` so it survives a reload. See
   * `src/style/forest-cover.js` for the fill → edge → rim treatment.
   */
  forestCover: false,

  /**
   * Forest-mode markup accents — a family of OPTIONAL highlight toggles
   * that only have an effect while `forestCover` is on. They are surfaced
   * through a collapsible sub-panel that is revealed only in forest mode
   * (see src/ui/controls.js) and emitted dead-last in composeLayers,
   * guarded by `forestCover` (src/style/forest-markup.js + block 23 of
   * src/style/index.js), so "forest-mode only" is structural.
   *
   * Each is independent and persisted (`cart:features:forest*`) so the
   * user's selection survives a reload alongside the forestCover choice:
   *
   *   • forestCities      — bold blue city/town label + dot. ON by default
   *                         (the headline accent: settlements pop on the
   *                         flat green canvas).
   *   • forestWaterAccent — brighter rivers + water labels. OFF by default.
   *   • forestRoadsBold   — bold near-black casing on the major road skeleton. OFF.
   *   • forestRoadsOrange — bold orange accent over the road network. OFF.
   */
  forestCities: true,
  forestWaterAccent: false,
  forestRoadsBold: false,
  forestRoadsOrange: false,

  /**
   * Hazardous terrain overlay — high-visibility "danger" markers for
   * truly hard-to-reach mountains, sharp cliffs and dangerous high
   * passes inside the Carpathian bbox. Driven entirely by the
   * `mountain_feature` source-layer of `carpathian-osm.pmtiles`:
   *
   *   class=peak  + ele ≥ 1800 m → "extreme peak"   (магента)
   *   class=peak  + ele ≥ 1500 m → "hard peak"      (deep crimson)
   *   class=cliff               → "cliff / обрив"  (teal)
   *   class=pass  + ele ≥ 1300 m → "dangerous pass" (tangerine)
   *
   * Each match renders as a bright halo + crisp ring + safety-label.
   * Label colour comes from a dedicated `t.hazard.*.label` token
   * that's distinct from every existing label-colour token, so a
   * hazard label can be told from a regular peak/place label at a
   * glance — even at low zoom without zooming in.
   *
   * Defaults to ON because the source archive is already hosted from
   * the gh-pages branch and the layer carries safety-relevant signal
   * (alpine routes, off-trail planning context). Source missing →
   * silent no-op (graceful fallback in src/style/index.js).
   *
   * The user can toggle it off via the Relief panel; their choice is
   * persisted under `cart:features:hazardousTerrain` so it survives
   * a reload.
   */
  hazardousTerrain: true,

  /**
   * Settlement outlines — heavy, road-style violet frame around
   * residential / suburb / quarter / neighbourhood polygons in the
   * upstream OMT `landuse` source-layer. Mirrors the road glow →
   * casing → inline paint pattern from `roads.js` so populated
   * places read as framed plots from country-overview zoom (z4)
   * instead of vanishing into the cream paper background as they
   * do with the soft `landuse_residential` fill alone.
   *
   * Defaults to ON — the brief asks for villages, towns and cities
   * to read "without zoom". Toggleable from the Layers panel; the
   * choice is NOT persisted because no operator-side data is
   * involved (the residential polygons ship in the upstream OMT
   * tiles and the toggle is purely a stylistic preference).
   *
   * See `src/style/settlements.js` for the four-layer paint stack
   * and the rationale behind the violet hue choice (every other
   * accent family — amber roads, red trails, teal cliffs, magenta
   * hazards, green forests — was already claimed).
   */
  settlementOutline: true,
});

/** Default theme on cold boot. The user can flip it from the UI. */
export const DEFAULT_THEME = 'light'; // 'light' | 'dark'

// ---------------------------------------------------------------------------
// Map-mode switcher.
// ---------------------------------------------------------------------------
//
// The user can pick between three top-level visual modes:
//
//   • cart       — our premium composition (this is the whole rest of
//                  this file), composed from src/style/. Default.
//
//   • standard   — a third-party "Google-Maps-like" style fetched as
//                  a ready-made MapLibre style JSON and applied AS-IS,
//                  with no local layer mutations. The point is to give
//                  users a familiar, ordinary cartography fallback for
//                  when our premium glow / Imhof relief is too much
//                  context for the task at hand.
//
//                  Free, key-less candidates (any of these works):
//                    – OpenFreeMap Liberty
//                      https://tiles.openfreemap.org/styles/liberty
//                    – OpenFreeMap Bright
//                      https://tiles.openfreemap.org/styles/bright
//                    – Versatiles Colorful
//                      https://tiles.versatiles.org/assets/styles/colorful.json
//
//                  Liberty is the closest visually to Google Maps, so
//                  we use it as the default.
//
//   • satellite  — EOX Sentinel-2 at overview zooms, then a high-detail
//                  imagery provider (Mapbox Satellite by default) with
//                  Esri World Imagery kept as the no-key fallback.
//                  A thin local overlay of place + transportation_name
//                  labels keeps the imagery readable.
//
// Mode switches travel through `map.setStyle(newStyle, { diff: false })`
// so the camera (centre / zoom / pitch / bearing) is preserved without
// any extra book-keeping.

/**
 * Available modes. Order is significant — it drives the visual segment
 * order in the UI control.
 */
export const MAP_MODES = Object.freeze(['cart', 'standard', 'satellite']);

/** Cold-boot mode, before any `localStorage` lookup. */
export const DEFAULT_MAP_MODE = 'cart';

/** localStorage key for the persisted user choice. */
export const MAP_MODE_STORAGE_KEY = 'cart:map-mode';

/**
 * Upstream style URL for the Standard mode. Fetched once per mode
 * switch as the literal `style.json` and handed to `setStyle` without
 * any local mutation. If the fetch fails, the renderer falls back to
 * Cart and prints a single warning.
 */
export const STANDARD_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Public Mapbox token used by the Mapbox Satellite provider below.
 * This is intentionally a public `pk.*` browser token.
 */
export const MAPBOX_TOKEN =
  'pk.eyJ1IjoiZHdrb2R3b2tkd2tvd2Rrb2R3a293ZHdkd2RkdyIsImEiOiJjbXB3aWk0ZHAwMHBrMnJxem5mOHV3aXkzIn0.eJ6nyfgTR49tVFHoT1UEJg';

/**
 * Default low-zoom satellite tiles — EOX Sentinel-2 cloudless 2024.
 *
 * EOX publishes a free, key-less, recent cloudless Sentinel-2 mosaic
 * via WMTS at <https://s2maps.eu>. License: Contains modified
 * Copernicus Sentinel data 2024. Compared to the previous Esri World
 * Imagery default this:
 *
 *   • Removes the (commercial) Esri attribution.
 *   • Carries a published vintage (2024) so winter snow / summer
 *     forest cover are consistent rather than a stitched mosaic of
 *     years.
 *   • Has no clouds — Esri imagery occasionally shows them.
 *
 * The EOX cloudless mosaic is rendered up to z14. Above that the
 * imagery silently runs out of detail. Operators who want deep zoom
 * can flip `SATELLITE_PROVIDER` to `'esri'` (kept around as fallback).
 *
 * Note: WMTS path uses `{TileMatrix}/{TileRow}/{TileCol}` order, which
 * MapLibre's `{z}/{y}/{x}` mapping handles transparently.
 */
export const SATELLITE_TILES = Object.freeze({
  url:
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 14,
  resampling: 'linear',
  attribution:
    'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu" target="_blank" rel="noopener">EOX IT Services GmbH</a>' +
    ' (Contains modified Copernicus Sentinel data 2024)',
});

/**
 * Available satellite imagery providers. Pick the active one with
 * `SATELLITE_PROVIDER`. Each entry has the same shape as
 * `SATELLITE_TILES` so the satellite-mode style composer can swap
 * sources without branching on provider id.
 *
 * Operators selecting `esri` get the legacy World Imagery: deep zoom
 * (up to z19) with the trade-off of attribution-heavy commercial
 * imagery and occasional cloud cover.
 */
export const SATELLITE_PROVIDERS = Object.freeze({
  eox: SATELLITE_TILES,
  esri: Object.freeze({
    /** Esri ArcGIS REST imagery service. */
    url:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 19,
    resampling: 'linear',
    attribution:
      'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>' +
      ' — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }),
  mapbox: Object.freeze({
    /** Mapbox Raster Tiles API — Mapbox Satellite tileset. */
    url:
      `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token=${MAPBOX_TOKEN}`,
    retinaUrl:
      `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`,
    tileSize: 256,
    minzoom: 0,
    // Native-resolution ceiling, NOT the tileset's advertised max.
    //
    // The `mapbox.satellite` raster tileset advertises maxzoom 22, but
    // the underlying imagery (mostly Maxar Vivid, ~30–50 cm/px over this
    // map's extent) only carries genuine detail to ~z18–19. Requesting
    // z20–22 returns server-upscaled tiles: empirically a z22 @2x tile is
    // ~8 KB vs ~19 KB at z19 for comparable scenes — i.e. smooth, blurry
    // upsampling, not new detail. Because `resolveSatelliteImageryPlan()`
    // derives both the source `maxzoom` and the camera `maxZoom` cap from
    // this value, pinning it to 19 stops the camera from overzooming past
    // real imagery and removes the soft "fake detail" the user reported.
    // @2x retina (forced via SATELLITE_RETINA_DPR=1) keeps z14–19 crisp.
    maxzoom: 19,
    resampling: 'linear',
    attribution:
      'Satellite imagery © <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a>',
  }),
});

/** Active high-detail satellite provider id. */
export const SATELLITE_PROVIDER = 'mapbox';

/** Low-zoom cloudless base provider used by the hybrid satellite stack. */
export const SATELLITE_BASE_PROVIDER = 'eox';

/** No-key high-detail fallback provider used under/after the base layer. */
export const SATELLITE_FALLBACK_PROVIDER = 'esri';

/** Zoom where the satellite stack switches from overview mosaic to detail imagery. */
export const SATELLITE_DETAIL_MINZOOM = 14;

/** Request Mapbox @2x imagery even on DPR=1 displays for maximum sharpness. */
export const SATELLITE_RETINA_DPR = 1;

/**
 * When the active provider's max zoom is exceeded and this flag is
 * true, the satellite-style composer falls back to the next-best
 * provider (Esri). Kept on so the EOX overview never degrades into
 * overzoomed z14 pixels when no Mapbox detail layer is selected.
 */
export const SATELLITE_FALLBACK = true;

/**
 * Display labels in the user-friendly switcher UI. Plain strings so
 * controls.js can mount them without an i18n bundle.
 */
export const MAP_MODE_LABELS = Object.freeze({
  cart: 'Карта',
  standard: 'Стандарт',
  satellite: 'Спутник',
});

/**
 * Tooltip / aria-description for each mode.
 */
export const MAP_MODE_HINTS = Object.freeze({
  cart: 'Премиум-карта Cart со свечением и акцентами',
  standard: 'Стандартная карта (OpenFreeMap Liberty)',
  satellite: 'EOX Sentinel-2 + Mapbox Satellite с Esri fallback',
});
