/**
 * Map factory.
 *
 * Responsibilities:
 *   1. Register protocols (pmtiles://, contour-dem://) ONCE per page.
 *   2. Resolve the vector tile source descriptor from configuration
 *      (OpenFreeMap TileJSON or a PMTiles archive) over the network.
 *   3. Compose the full source/layer stack via the style modules in
 *      ../style/, including the relief / contour / Carpathian overlays
 *      gated by feature flags and device profile.
 *   4. Hand a fully-formed `maplibregl.Map` back to the caller with
 *      sky/terrain/projection applied at the style root.
 *
 * No layer or token logic lives here — those concerns are in src/style/.
 * No device-detection logic lives here either — that's in src/device.js;
 * we just consume the precomputed profile.
 *
 * Graceful fallback
 * -----------------
 * Every relief/contour/Carpathian data source is optional. If the
 * configured URL is null (or the network fetch fails), the corresponding
 * source is simply not added to the style and the layer composer skips
 * its layers. The map renders without relief instead of erroring out.
 */

import {
  VIEW,
  SOURCE_BACKEND,
  OPENFREEMAP,
  PMTILES,
  PERF,
  FEATURES,
  TERRAIN,
  CONTOURS,
  DEFAULT_THEME,
} from '../config.js';
import { composeLayers, getTokens } from '../style/index.js';
import {
  composeSources,
  sourceAvailability,
} from '../style/sources.js';
import {
  composeSky,
  composeTerrain,
  composeProjection,
  evalExaggeration,
} from '../style/terrain.js';
import {
  CONTOURS_SOURCE_LAYER,
} from '../style/contours.js';
import {
  detectCaps,
  deriveProfile,
  getProfileConfig,
  getTouchTuning,
} from '../device.js';

// ---------------------------------------------------------------------------
// Protocol registration — once per page lifetime, regardless of how many
// maps (or style rebuilds) happen. We expose the flags as booleans rather
// than a Set so they're trivial to reason about in logs.
// ---------------------------------------------------------------------------

const protocolState = {
  pmtiles: false,
  contour: false,
};

function registerPMTilesProtocol() {
  if (protocolState.pmtiles) return;
  if (typeof window === 'undefined') return;
  const ml = window.maplibregl;
  const pm = window.pmtiles;
  if (!ml || !pm) return;
  const protocol = new pm.Protocol({ metadata: true });
  ml.addProtocol('pmtiles', protocol.tile);
  protocolState.pmtiles = true;
}

/**
 * Register maplibre-contour's DemSource protocol, which the contour
 * source layers reference via a synthetic URL (see getContourSourceId
 * below). The DEM source stays the primary raster-dem; the contour tiles
 * are generated on the worker thread.
 *
 * @returns {string|null} The contour source id, or null if registration
 *                        couldn't happen (library absent, server-side).
 */
function registerContourProtocol() {
  if (typeof window === 'undefined') return null;
  const ml = window.maplibregl;
  if (!ml) return null;
  const factory = window.mlcontour;
  if (!factory) return null; // library not loaded; contours silently disabled
  if (protocolState.contour) return protocolState.contourSourceId ?? null;

  const demSource = new factory.DemSource({
    url: firstDemUrl(TERRAIN.primary),
    encoding: TERRAIN.primary.encoding,
    maxzoom: TERRAIN.primary.maxzoom,
    worker: true,
    cacheSize: CONTOURS.workerTileCacheSize,
    timeoutMs: 10_000,
  });
  demSource.setupMaplibre(ml);

  // Cache the synthetic source id so callers can reference it when
  // composing layers.
  const sourceId = demSource.sharedDemProtocolId ?? 'contours-dynamic';
  protocolState.contour = true;
  protocolState.contourSourceId = sourceId;
  protocolState.demSource = demSource;
  return sourceId;
}

/**
 * Pick a usable URL out of a RasterDemSpec — url takes precedence over
 * raw tiles. Used by the contour worker which needs a single URL (it
 * builds its own tile fetcher internally).
 */
function firstDemUrl(dem) {
  if (!dem) return null;
  if (typeof dem.url === 'string' && dem.url) return dem.url;
  if (Array.isArray(dem.tiles) && dem.tiles.length > 0) return dem.tiles[0];
  return null;
}

// ---------------------------------------------------------------------------
// Vector source resolution (openmaptiles). Fetches the upstream style
// JSON once so we also discover the auto-versioned glyphs/sprite URLs.
// ---------------------------------------------------------------------------

async function resolveVectorTriple() {
  if (SOURCE_BACKEND === 'pmtiles') {
    return {
      vectorSource: {
        type: 'vector',
        url: PMTILES.url,
        attribution: PMTILES.attribution,
      },
      glyphs: OPENFREEMAP.glyphs,
      sprite: OPENFREEMAP.sprite,
    };
  }

  let glyphs = OPENFREEMAP.glyphs;
  let sprite = OPENFREEMAP.sprite;
  try {
    const upstream = await fetch(OPENFREEMAP.styleUrl, {
      cache: 'force-cache',
    }).then((r) => (r.ok ? r.json() : null));
    if (upstream?.glyphs) glyphs = upstream.glyphs;
    if (upstream?.sprite) sprite = upstream.sprite;
  } catch {
    /* Network or CORS issue. Configured fallbacks still work. */
  }

  return {
    vectorSource: {
      type: 'vector',
      url: OPENFREEMAP.tilejson,
      attribution: OPENFREEMAP.attribution,
    },
    glyphs,
    sprite,
  };
}

// ---------------------------------------------------------------------------
// Style assembly — pulls from composeSources/composeLayers/composeSky/…
// and produces a full spec-valid style object ready for `map.setStyle`.
// ---------------------------------------------------------------------------

async function buildStyle({ theme, features, profileConfig, layerOpts, caps }) {
  const { vectorSource, glyphs, sprite } = await resolveVectorTriple();

  const sources = composeSources({
    vectorSource,
    features,
  });
  const has = sourceAvailability(sources);

  // maplibre-contour dynamic source — only if the feature is on and the
  // primary DEM source exists. We attempt to register the protocol and
  // plug the resulting source id into layerOpts; if the library isn't
  // on the page, contours silently disable.
  let hasContoursSource = false;
  let contoursSourceId = 'contours-dynamic';
  if (features.contours && has.primaryDem) {
    const id = registerContourProtocol();
    if (id) {
      contoursSourceId = id;
      sources[id] = buildContourSourceSpec(id);
      hasContoursSource = true;
    }
  }

  const finalLayerOpts = {
    ...layerOpts,
    theme,
    hasPrimaryDem: has.primaryDem,
    hasCarpathianDem: has.carpathianDem,
    hasHypsoSource: has.hypsometricTint,
    hasTextureSource: has.textureShading,
    hasRidgesSource: has.ridges,
    hasCarpathianOsmSource: has.carpathianOsm,
    hasContoursSource,
    contoursSourceId,
    contoursMinzoom: CONTOURS.minzoom,
    reduceMotion: !!caps?.prefersReducedMotion,
  };

  const tokens = getTokens(theme);

  const style = {
    version: 8,
    name: `Cart · Ukraine (${theme})`,
    metadata: { theme, schema: 'openmaptiles' },
    sources,
    glyphs,
    sprite,
    layers: composeLayers(finalLayerOpts),
    transition: { duration: 220, delay: 0 },
    light: { anchor: 'viewport', color: 'white', intensity: 0.4 },
    sky: composeSky(tokens, { reduceMotion: finalLayerOpts.reduceMotion }),
  };

  // Start terrain at the curve's value for the initial zoom. Will be
  // refreshed imperatively on zoomend via interactions.js.
  const initialExaggeration = evalExaggeration(
    VIEW.zoom,
    TERRAIN.exaggerationStops,
    profileConfig.terrainExaggerationMul ?? 1,
  );
  const terrain = composeTerrain({
    enable: features.terrain3D && profileConfig.enableTerrain3D && !finalLayerOpts.reduceMotion,
    hasPrimaryDem: has.primaryDem,
    initialExaggeration,
  });
  if (terrain) style.terrain = terrain;

  const projection = composeProjection({
    globe: features.globeProjection && profileConfig.enableGlobeProjection,
  });
  if (projection) style.projection = projection;

  return style;
}

/**
 * Build a MapLibre `source` entry for the contour-dynamic source. The
 * maplibre-contour library exposes its tiles via a custom URL prefix
 * (e.g. `contour://…`) that was registered by `registerContourProtocol`.
 */
function buildContourSourceSpec(sourceId) {
  // The library's .contourProtocolUrl() builder produces the correct
  // template string. If unavailable, fall back to a conventional shape.
  const dem = protocolState.demSource;
  if (dem?.contourProtocolUrl) {
    return {
      type: 'vector',
      tiles: [
        dem.contourProtocolUrl({
          thresholds: thresholdsToMlcontourFormat(),
          contourLayer: CONTOURS_SOURCE_LAYER,
          elevationKey: 'ele',
          levelKey: 'level',
          overzoom: 1,
        }),
      ],
      maxzoom: TERRAIN.primary.maxzoom + 2,
    };
  }
  return {
    type: 'vector',
    tiles: [`${sourceId}://{z}/{x}/{y}`],
    maxzoom: TERRAIN.primary.maxzoom + 2,
  };
}

/**
 * Convert CONTOURS.thresholdsByZoom into the shape maplibre-contour
 * expects for its `thresholds` option: `{ [zoom]: [minor, major] }`.
 */
function thresholdsToMlcontourFormat() {
  const out = {};
  for (const [z, [minor, major]] of CONTOURS.thresholdsByZoom) out[z] = [minor, major];
  return out;
}

// ---------------------------------------------------------------------------
// Profile bridging — converts the per-device profile config into the two
// shapes MapLibre cares about: top-level Map options vs composeLayers opts.
// ---------------------------------------------------------------------------

function profileToLayerOpts(profileConfig, features) {
  return {
    buildings3D: features.buildings3D && profileConfig.buildings3D,
    pois: features.pois,
    labels: features.labels,
    density: profileConfig.labelDensity,
    placeRankCutoff: profileConfig.placeRankCutoff,
    poiRankCutoff: profileConfig.poiRankCutoff,
    poiDotRankCutoff: profileConfig.poiDotRankCutoff,
    textPaddingMul: profileConfig.textPaddingMul,
    poiSizeMul: profileConfig.poiSizeMul,
    enableNeighbourhoods: profileConfig.enableNeighbourhoods,
    enableHamlets: profileConfig.enableHamlets,
    enableSuburbs: profileConfig.enableSuburbs,
    enableRoadShieldsMinor: profileConfig.enableRoadShieldsMinor,
    roadsCarpathianDoubleCasing: profileConfig.roadsCarpathianDoubleCasing,

    // Relief stack — AND the user's feature flag with the device profile
    // capability so the union is respected (never render a heavy feature
    // on a low-tier device just because the user toggled it on).
    hillshade: features.hillshade,
    multiDirHillshade:
      features.hillshade && profileConfig.enableMultiDirHillshade,
    hypsometricTint:
      features.hypsometricTint && profileConfig.enableHypsoTint,
    textureShading:
      features.textureShading && profileConfig.enableTextureShading,
    contours: features.contours && profileConfig.enableContours,
    ridgeOverlay:
      features.ridgeOverlay && profileConfig.enableRidgeOverlay,
    carpathian:
      features.carpathian && profileConfig.enableCarpathianOverlay,
    colorRelief: features.colorRelief, // runtime-checked downstream
  };
}

function profileToMapOpts(profileConfig) {
  return {
    maxTileCacheSize: profileConfig.maxTileCacheSize ?? PERF.maxTileCacheSize,
    fadeDuration: profileConfig.fadeDuration ?? PERF.fadeDuration,
    antialias: profileConfig.antialias ?? PERF.antialias,
    refreshExpiredTiles: profileConfig.refreshExpiredTiles ?? PERF.refreshExpiredTiles,
  };
}

/**
 * Resolve the effective feature set — user toggles AND device caps. The
 * caps side is small (just reduce-motion overrides), kept here so createMap
 * produces a fully-gated `features` object for buildStyle.
 */
function resolveFeatures(features, caps) {
  if (caps?.prefersReducedMotion) {
    return { ...features, terrain3D: false };
  }
  return features;
}

// ---------------------------------------------------------------------------
// Public entry.
// ---------------------------------------------------------------------------

/**
 * Construct the MapLibre map for the given container.
 *
 * @param {HTMLElement|string} container DOM node or selector.
 * @param {object}             [opts]
 * @param {string}             [opts.theme]      'light' | 'dark'
 * @param {object}             [opts.caps]       Output of detectCaps(). If
 *                                               omitted, we detect inline.
 * @param {'high'|'medium'|'low'} [opts.profile] Forced profile. If omitted,
 *                                               derived from `caps`.
 * @param {object}             [opts.featureOverrides] Force specific feature
 *                                               toggles on/off.
 * @returns {Promise<maplibregl.Map>}
 */
export async function createMap(container, opts = {}) {
  registerPMTilesProtocol();

  const ml = window.maplibregl;
  if (!ml) throw new Error('maplibre-gl is not loaded on window');

  const theme = opts.theme ?? DEFAULT_THEME;
  const caps = opts.caps ?? detectCaps();
  const profile = opts.profile ?? deriveProfile(caps);
  const profileConfig = getProfileConfig(profile, caps);
  const features = resolveFeatures(
    { ...FEATURES, ...(opts.featureOverrides ?? {}) },
    caps,
  );

  const layerOpts = profileToLayerOpts(profileConfig, features);
  const mapOpts = profileToMapOpts(profileConfig);
  const touchTuning = getTouchTuning(caps);

  const style = await buildStyle({
    theme,
    features,
    profileConfig,
    layerOpts,
    caps,
  });

  const map = new ml.Map({
    container,
    style,
    center: VIEW.center,
    zoom: VIEW.zoom,
    pitch: VIEW.pitch,
    bearing: VIEW.bearing,
    minZoom: VIEW.minZoom,
    maxZoom: VIEW.maxZoom,
    maxBounds: VIEW.maxBounds,

    // From the device profile
    antialias: mapOpts.antialias,
    fadeDuration: mapOpts.fadeDuration,
    maxTileCacheSize: mapOpts.maxTileCacheSize,
    refreshExpiredTiles: mapOpts.refreshExpiredTiles,
    preserveDrawingBuffer: PERF.preserveDrawingBuffer,

    localIdeographFontFamily: false,
    attributionControl: false,

    // Interaction defaults — overridden by touch tuning where applicable.
    cooperativeGestures: false,
    boxZoom: true,
    pitchWithRotate: true,
    dragRotate: true,
    keyboard: true,
    scrollZoom: true,
    touchZoomRotate: true,
    touchPitch: true,
    doubleClickZoom: true,
    ...(touchTuning ?? {}),
  });

  // Stash everything interactions.js / the UI might need to rebuild the
  // style or run zoomend-time terrain logic, on a namespaced object.
  map._cart = {
    theme,
    caps,
    profile,
    profileConfig,
    features,
    layerOpts,
    // Slider value: 1 = as-authored, 0.5 = half strength, 2 = double.
    // Live-updated by the UI slider; interactions.js multiplies with the
    // per-profile mul.
    userExaggerationMul: 1,
  };

  return map;
}

/**
 * Rebuild and apply a fresh style to an existing map instance — used by
 * the theme switcher, the quality picker, and the new layer toggles.
 * Pass any subset of `theme`, `profile`, or `featureOverrides`; everything
 * else is preserved.
 */
export async function applyStyle(map, patch = {}) {
  const prev = map._cart ?? {};
  const theme = patch.theme ?? prev.theme ?? DEFAULT_THEME;
  const profile = patch.profile ?? prev.profile ?? 'medium';
  const caps = prev.caps;
  const profileConfig =
    patch.profileConfig ?? prev.profileConfig ?? getProfileConfig(profile, caps);
  const features = resolveFeatures(
    { ...prev.features, ...(patch.featureOverrides ?? {}) },
    caps,
  );

  const layerOpts = profileToLayerOpts(profileConfig, features);
  const style = await buildStyle({ theme, features, profileConfig, layerOpts, caps });
  map.setStyle(style, { diff: false });

  map._cart = {
    ...prev,
    theme,
    profile,
    profileConfig,
    features,
    layerOpts,
  };
  return map;
}
