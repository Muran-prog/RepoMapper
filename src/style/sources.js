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

import { TERRAIN, CONTOURS, HYPSO } from '../config.js';
import {
  SETTLEMENTS_SUPPLEMENT,
  SETTLEMENTS_SUPPLEMENT_SOURCE,
} from './settlements-supplement.js';

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

  // Supplemental settlement polygons — hand-supplied boundaries for places
  // OSM does not model as settlements (e.g. the Заросляк mountain base).
  // Inline GeoJSON, always present and network-free, so the perimeter
  // outline in settlements.js can trace them exactly like landuse-class
  // settlements. See settlements-supplement.js for the rationale + data.
  sources[SETTLEMENTS_SUPPLEMENT_SOURCE] = {
    type: 'geojson',
    data: SETTLEMENTS_SUPPLEMENT,
  };

  // Primary DEM backs hillshade, 3D terrain, dynamic contour generation,
  // AND the native color-relief hypsometric tint. The latter is easy
  // to forget: turning everything else off (Flat hypso preset) leaves
  // hypsometricTint as the sole consumer, and without the DEM source
  // the native color-relief layer silently degrades to 'off'.
  const primaryDem = toRasterDemSource(terrain.primary);
  const needsPrimaryDem =
    features.hillshade || features.terrain3D || features.contours || features.hypsometricTint;
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
  // Sky-View Factor — sits between hillshade and texture-shading,
  // multiplies darkening into canyons / cirques / rock terraces.
  if (features.skyViewFactor) {
    const svf = toRasterPmtilesSource(terrain.skyViewFactor);
    if (svf) sources['sky-view-factor'] = svf;
  }

  // ESA WorldCover landcover-tint — pre-rendered 10 m classification
  // raster. Source-gated: `terrain.worldcover.url === null` means the
  // operator hasn't run `tools/build-worldcover.sh` yet, so we don't
  // emit the source. The layer composer in `terrain.js` then skips
  // the layer entirely (graceful fallback). When wired, the source
  // is consumed by `composeWorldcoverLayer` as a multiply-blend
  // overlay above hillshade and below texture-shading.
  if (features.worldcoverTint) {
    const wc = toRasterPmtilesSource(terrain.worldcover);
    if (wc) sources['worldcover'] = wc;
  }

  // ETH Global Canopy Height (Lang et al. 2023) — pre-rendered 10 m
  // canopy top-height raster. Stacks ABOVE the WorldCover tree-cover
  // wash so it modulates that wash by stand age. Source-gated:
  // `terrain.canopyHeight.url === null` means the build hasn't been
  // run yet, so the source is omitted and the layer composer skips
  // the layer entirely (graceful fallback). When wired the source
  // is consumed by `composeCanopyHeightLayer` as a multiply-blend
  // overlay above WorldCover and below texture-shading.
  if (features.canopyHeightTint) {
    const ch = toRasterPmtilesSource(terrain.canopyHeight);
    if (ch) sources['canopy-height'] = ch;
  }
  if (features.hypsometricTint) {
    // The hypso subsystem has two paths. When the native color-relief
    // layer is available we don't need ANY raster source — the DEM
    // backs the colour ramp directly. When it's not available we need
    // the raster archive for the active ramp; the runtime swap path
    // adds further per-ramp sources as the user picks new ramps.
    // For style-compose time we add the legacy single-archive source
    // (terrain.hypsometric.url) only if explicitly configured.
    const hyp = toRasterPmtilesSource(terrain.hypsometric);
    if (hyp) sources['hypso-tint'] = hyp;

    // Also pre-add the active raster ramp if its URL is configured.
    // The runtime will add others on demand to avoid loading multiple
    // full-Ukraine archives at boot. The url lookup picks up overrides
    // from `features.hypsoRasterUrls` so tests + UI overrides bypass
    // the frozen HYPSO.rasterUrls dict without mutating it.
    const activeRampId = features.hypsoRampId ?? HYPSO.defaultRampId;
    const urlMap = features.hypsoRasterUrls ?? HYPSO.rasterUrls;
    const activeRampUrl = urlMap?.[activeRampId];
    if (typeof activeRampUrl === 'string' && activeRampUrl.length > 0) {
      sources[`hypso-raster-${activeRampId}`] = {
        type: 'raster',
        url: activeRampUrl,
        tileSize: terrain.hypsometric?.tileSize ?? 256,
        minzoom: terrain.hypsometric?.minzoom ?? 2,
        maxzoom: terrain.hypsometric?.maxzoom ?? 12,
        attribution: terrain.hypsometric?.attribution,
      };
    }
  }

  // Bathymetry — GEBCO 2024 seabed tint. Stacks under hypso so the 0 m
  // ramp boundary is the only continuous edge. URL-gated.
  if (features.bathymetry && terrain.bathymetry) {
    const bathy = toRasterPmtilesSource(terrain.bathymetry);
    if (bathy) sources['bathymetry'] = bathy;
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

  // High-detail 10 m forest vector (ESA WorldCover tree class) for the
  // Carpathians. Source-gated like the other PMTiles overlays: when the
  // archive isn't configured the composer skips the high-detail forest
  // layers and `forestCover` falls back to the global OpenMapTiles
  // landcover forest (always present). Only added when forestCover is on.
  if (features.forestCover) {
    const forest10m = toVectorPmtilesSource(terrain.forest10m);
    if (forest10m) sources['forest-10m'] = forest10m;
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
  const rasterRampId = findHypsoRasterRampId(sources);
  return {
    primaryDem: 'terrain-dem' in sources,
    carpathianDem: 'terrain-dem-carpathian' in sources,
    textureShading: 'texture-shading' in sources,
    skyViewFactor: 'sky-view-factor' in sources,
    worldcoverTint: 'worldcover' in sources,
    canopyHeightTint: 'canopy-height' in sources,
    hypsometricTint: 'hypso-tint' in sources,
    hypsoRasterRampId: rasterRampId,
    bathymetry: 'bathymetry' in sources,
    ridges: 'ridges' in sources,
    carpathianOsm: 'carpathian-osm' in sources,
    // Forest leaf-type polygons live INSIDE carpathian-osm.pmtiles
    // (see tools/carpathian-profile.yml `forest_polygon` layer), so
    // their availability is one-to-one with the parent vector source.
    // The actual `features.forestLeafType` flag still gates emission
    // in src/style/index.js — this just signals that the data is
    // reachable in principle.
    forestPolygon: 'carpathian-osm' in sources,
    // High-detail 10 m forest vector archive (Carpathian-only). Gates the
    // crisp forestCover layers in src/style/index.js; when absent the
    // overlay falls back to the global OpenMapTiles landcover forest.
    forest10m: 'forest-10m' in sources,
    contoursStatic: 'contours-static' in sources,
  };
}

/**
 * Find any pre-added per-ramp raster source. Returns the ramp id (the
 * suffix after `hypso-raster-`) or null. Used by the composer to decide
 * whether to emit a raster hypso layer in compose-time.
 *
 * @param {Record<string, object>} sources
 * @returns {string|null}
 */
function findHypsoRasterRampId(sources) {
  for (const id of Object.keys(sources)) {
    if (id.startsWith('hypso-raster-')) return id.slice('hypso-raster-'.length);
  }
  return null;
}
