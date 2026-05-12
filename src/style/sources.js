/**
 * Source composer — builds the full `sources` dict for a MapLibre style.
 *
 * This module is deliberately pure: given feature flags and the TERRAIN /
 * CONTOURS config blocks, it returns a plain object mapping source-id →
 * MapLibre source descriptor. No side-effects, no MapLibre globals, no
 * network; that means the same function is used by the browser pipeline
 * (src/map/createMap.js) and the offline style-spec validator (validate.cjs).
 *
 * What lives here vs. createMap:
 *
 *   sources.js     — WHAT sources exist and how they're shaped
 *   createMap.js   — how to fetch TileJSON, register pmtiles://, set the
 *                    resulting style on a map instance
 *
 * Graceful absence
 * ----------------
 * Every optional overlay (Carpathian DEM, texture shading, hypsometric
 * tint, ridges, Carpathian OSM overlay, static contours) is URL-gated.
 * If a URL is not configured, its source is simply omitted — style-spec
 * validation still passes, and the layer consumers in composeLayers()
 * check `sources[…]` before emitting their layers so we never produce a
 * layer referencing a missing source.
 */

import { TERRAIN, CONTOURS } from '../config.js';

/**
 * Build a `raster-dem` source spec, or return null if the config is empty.
 * Accepts either a single `url` (TileJSON / PMTiles) or an array of raw
 * `tiles` URL templates, matching the style-spec source_raster_dem shape.
 *
 * @param {object|null|undefined} dem RasterDemSpec (see config.js typedef).
 * @returns {object|null}
 */
function toRasterDemSource(dem) {
  if (!dem) return null;
  const hasUrl = typeof dem.url === 'string' && dem.url.length > 0;
  const hasTiles = Array.isArray(dem.tiles) && dem.tiles.length > 0;
  if (!hasUrl && !hasTiles) return null;
  const source = {
    type: 'raster-dem',
    encoding: dem.encoding ?? 'terrarium',
    tileSize: dem.tileSize ?? 256,
    minzoom: dem.minzoom ?? 0,
    maxzoom: dem.maxzoom ?? 14,
  };
  if (dem.attribution) source.attribution = dem.attribution;
  if (Array.isArray(dem.bounds) && dem.bounds.length === 4) source.bounds = [...dem.bounds];
  if (hasUrl) source.url = dem.url;
  else source.tiles = [...dem.tiles];
  return source;
}

/**
 * Build a `raster` source spec (for texture-shading / hypsometric PNG
 * archives), or null if the spec is URL-less.
 */
function toRasterPmtilesSource(spec) {
  if (!spec || typeof spec.url !== 'string' || spec.url.length === 0) return null;
  const source = {
    type: 'raster',
    url: spec.url,
    tileSize: spec.tileSize ?? 256,
    minzoom: spec.minzoom ?? 0,
    maxzoom: spec.maxzoom ?? 14,
  };
  if (spec.attribution) source.attribution = spec.attribution;
  return source;
}

/**
 * Build a `vector` source spec from a PMTiles archive descriptor, or null.
 */
function toVectorPmtilesSource(spec) {
  if (!spec || typeof spec.url !== 'string' || spec.url.length === 0) return null;
  const source = { type: 'vector', url: spec.url };
  if (spec.attribution) source.attribution = spec.attribution;
  return source;
}

/**
 * @typedef {object} SourceComposeOpts
 * @property {object}  vectorSource        Resolved `openmaptiles` vector source spec.
 * @property {object}  [terrain=TERRAIN]
 * @property {object}  [contours=CONTOURS]
 * @property {object}  features            Feature flag bundle (FEATURES merged with overrides).
 */

/**
 * @param {SourceComposeOpts} opts
 * @returns {Record<string, object>} Source-id → source-spec.
 */
export function composeSources({
  vectorSource,
  terrain = TERRAIN,
  contours = CONTOURS,
  features = {},
}) {
  const sources = {};
  if (vectorSource) sources.openmaptiles = vectorSource;

  // Primary DEM backs hillshade, 3D terrain and dynamic contour generation.
  // One source shared across all three so MapLibre reuses tile loads.
  const primaryDem = toRasterDemSource(terrain.primary);
  const needsPrimaryDem =
    features.hillshade || features.terrain3D || features.contours;
  if (needsPrimaryDem && primaryDem) {
    sources['terrain-dem'] = primaryDem;
  }

  // Carpathian high-resolution DEM — also usable for hillshade when only
  // the Carpathian overlay is on.
  if ((features.carpathian || features.hillshade) && terrain.carpathian) {
    const carpDem = toRasterDemSource(terrain.carpathian);
    if (carpDem) sources['terrain-dem-carpathian'] = carpDem;
  }

  // Pre-rendered relief rasters. Texture shading goes over hillshade;
  // hypsometric tint sits below it.
  if (features.textureShading) {
    const tex = toRasterPmtilesSource(terrain.textureShading);
    if (tex) sources['texture-shading'] = tex;
  }
  if (features.hypsometricTint) {
    const hyp = toRasterPmtilesSource(terrain.hypsometric);
    if (hyp) sources['hypso-tint'] = hyp;
  }

  // Vector ridge/valley PMTiles (Imhof-style enhancement).
  if (features.ridgeOverlay) {
    const rid = toVectorPmtilesSource(terrain.ridges);
    if (rid) sources['ridges'] = rid;
  }

  // Custom Carpathian OSM overlay (hiking_route / mountain_feature / etc.).
  if (features.carpathian) {
    const carpOsm = toVectorPmtilesSource(terrain.carpathianOsm);
    if (carpOsm) sources['carpathian-osm'] = carpOsm;
  }

  // Static contour archive (only when mode='static' or 'hybrid').
  if (
    features.contours &&
    (contours.mode === 'static' || contours.mode === 'hybrid') &&
    typeof contours.staticPmtilesUrl === 'string' &&
    contours.staticPmtilesUrl.length > 0
  ) {
    sources['contours-static'] = {
      type: 'vector',
      url: contours.staticPmtilesUrl,
    };
  }

  return sources;
}

/**
 * Inverse of composeSources — report which optional overlays have real
 * backing sources so the style composer can decide whether to emit their
 * layers. Keeps "layer references a non-existent source" errors out of
 * the composed style.
 *
 * @param {Record<string, object>} sources
 * @returns {object} Availability flags keyed by overlay name.
 */
export function sourceAvailability(sources) {
  return {
    primaryDem: 'terrain-dem' in sources,
    carpathianDem: 'terrain-dem-carpathian' in sources,
    textureShading: 'texture-shading' in sources,
    hypsometricTint: 'hypso-tint' in sources,
    ridges: 'ridges' in sources,
    carpathianOsm: 'carpathian-osm' in sources,
    contoursStatic: 'contours-static' in sources,
  };
}
