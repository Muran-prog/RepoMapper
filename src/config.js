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
    url: null, // e.g. 'pmtiles://https://pub-you.r2.cloudflarestorage.com/carpathian-glo30.pmtiles'
    tiles: null,
    encoding: 'terrarium',
    tileSize: 256,
    minzoom: 5,
    maxzoom: 14,
    bounds: [22.0, 47.6, 27.0, 49.5],
    attribution:
      'DEM: <a href="https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model" target="_blank" rel="noopener">Copernicus GLO-30</a>',
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
   * Pre-rendered hypsometric tint. Generated via gdaldem color-relief with
   * the `tokens.hypsoStops` ramp (see tools/build-hypso.sh). When native
   * color-relief lands in MapLibre stable we can switch to that and drop
   * this raster; see FEATURES.colorRelief below.
   */
  hypsometric: Object.freeze({
    url: null, // pmtiles://https://…/ukraine-hypso.pmtiles
    tileSize: 256,
    minzoom: 2,
    maxzoom: 12,
    attribution: 'Hypsometric tint: generated from DEM',
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
    url: null, // pmtiles://https://…/carpathian-osm.pmtiles
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
   */
  zoomRules: Object.freeze({
    ridges: 8,
    trails: 10,
    peaks: 8,
    passes: 11,
    saddles: 11,
    cableways: 12,
    skiPistes: 12,
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
  hypsometricTint: false,
  ridgeOverlay: false,
  carpathian: false,

  /**
   * Use MapLibre `projection: { type: 'globe' }` at low zooms. Falls back
   * to plain Mercator below the min-zoom threshold. Only useful on the
   * overview zoom (≤5), so it's off by default.
   */
  globeProjection: false,

  /**
   * Native `color-relief` layer. Still landing in maplibre-gl-js stable
   * (tracked in maplibre-gl-js#5666); enabling this on an unsupported
   * build degrades to no-op (feature detection at runtime).
   */
  colorRelief: false,
});

/** Default theme on cold boot. The user can flip it from the UI. */
export const DEFAULT_THEME = 'light'; // 'light' | 'dark'
