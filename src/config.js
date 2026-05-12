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
// Performance & rendering
// ---------------------------------------------------------------------------

export const PERF = Object.freeze({
  /** Aggressive cache size — Ukraine fits comfortably with headroom to spare. */
  maxTileCacheSize: 512,
  /** Allow MapLibre to over-zoom vector tiles past their native maxzoom. */
  maxOverzoomLevel: 6,
  /** Animated tile fade-in duration (ms). 0 = instant pop-in. */
  fadeDuration: 180,
  /** Whether to enable terrain hillshade if a DEM source is configured. */
  enableTerrain: false,
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

export const FEATURES = Object.freeze({
  buildings3D: true,
  pois: true,
  labels: true,
  hillshade: false,
  hud: true,
  fpsCounter: true,
});

/** Default theme on cold boot. The user can flip it from the UI. */
export const DEFAULT_THEME = 'light'; // 'light' | 'dark'
