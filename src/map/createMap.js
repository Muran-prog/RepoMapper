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
  HYPSO,
  DEFAULT_THEME,
  MAP_MODES,
  DEFAULT_MAP_MODE,
  STANDARD_STYLE_URL,
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
import { composeSatelliteStyle, getSatelliteMaxZoom } from '../style/satellite.js';
import {
  CONTOURS_SOURCE_LAYER,
} from '../style/contours.js';
import {
  detectHypsoCaps,
  clearHypsoCaps,
  seedHypsoState,
  DEFAULT_RAMP_ID,
} from '../style/hypso/index.js';
import {
  detectCaps,
  deriveProfile,
  getProfileConfig,
  getTouchTuning,
} from '../device.js';
import { withGridOverlay } from '../style/grid.js';
import { withSettlementOutlineOverlay } from '../style/settlements.js';
import { loadMapMode, saveMapMode } from '../ui/store.js';

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

async function buildStyle({ theme, features, profileConfig, layerOpts, caps, hypsoState, map }) {
  const { vectorSource, glyphs, sprite } = await resolveVectorTriple();

  // hypso ramp id is forwarded to composeSources so it pre-adds the
  // active ramp's per-archive source when the raster path is taken.
  const featuresWithHypsoRamp = {
    ...features,
    hypsoRampId: hypsoState?.rampId ?? HYPSO.defaultRampId,
  };

  const sources = composeSources({
    vectorSource,
    features: featuresWithHypsoRamp,
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

  const hypsoRampId = hypsoState?.rampId ?? HYPSO.defaultRampId;
  const hypsoRasterSourceId = has.hypsoRasterRampId
    ? `hypso-raster-${has.hypsoRasterRampId}`
    : null;

  const finalLayerOpts = {
    ...layerOpts,
    theme,
    hasPrimaryDem: has.primaryDem,
    hasCarpathianDem: has.carpathianDem,
    hasHypsoSource: has.hypsometricTint,
    hasHypsoRasterRamp: has.hypsoRasterRampId === hypsoRampId,
    hasBathymetrySource: has.bathymetry,
    hasTextureSource: has.textureShading,
    hasSkyViewFactorSource: has.skyViewFactor,
    hasWorldcoverSource: has.worldcoverTint,
    hasCanopyHeightSource: has.canopyHeightTint,
    // Optimistic: assume the runtime supports `['slope']` in
    // color-relief expressions on first compose. If the probe later
    // discovers it doesn't, `detectHypsoCaps` removes the layer
    // surgically (see hypso/detect.js::demoteSlopeWarningIfPresent).
    // The cached cap on `_cart.hypsoCaps.slope` overrides this when a
    // post-probe restyle runs, so steady-state matches reality.
    hasSlopeExpression: map?._cart?.hypsoCaps
      ? !!map._cart.hypsoCaps.slope
      : true,
    hasRidgesSource: has.ridges,
    hasCarpathianOsmSource: has.carpathianOsm,
    // forest_polygon lives inside the carpathian-osm pmtiles, so the
    // availability mirrors the umbrella vector source; the actual
    // emit decision still depends on `forestLeafType` (via
    // profileToLayerOpts).
    hasForestPolygonSource: has.forestPolygon,
    // High-detail 10 m forest vector (Carpathian-only). When present,
    // forestCover paints crisp 10 m stand boundaries inside the bbox on
    // top of the global landcover forest; when absent it falls back to
    // the global landcover forest alone.
    hasForest10mSource: has.forest10m,
    // Classified wetland archive (swampCover Tier B). When present the graded
    // orange classified layers paint over the global landcover wetland wash;
    // when absent swampCover falls back to that unclassified wash alone.
    hasWetlandsSource: has.wetlands,
    hasContoursSource,
    contoursSourceId,
    contoursMinzoom: CONTOURS.minzoom,
    hasGridSource: has.grid,
    reduceMotion: !!caps?.prefersReducedMotion,

    // Hypso-specific options threaded through the composer.
    hypsoMode: hypsoState?.mode ?? (features.colorRelief && has.primaryDem ? 'native' : 'off'),
    hypsoRampId,
    hypsoStrength: hypsoState?.strength ?? HYPSO.defaultStrength,
    hypsoBathymetry: hypsoState?.bathymetry ?? HYPSO.bathymetryDefault,
    hypsoRasterSourceId,
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
 * Build a `source` entry for the contour-dynamic source. The
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
    // Bold orange road treatment (orange fills + amber casings + glow +
    // boosted widths on hierarchy roads). Pure user preference — no
    // device-profile knob, just the raw flag from FEATURES (overridden
    // by the user's UI toggle).
    roadsOrangeBold: features.roadsOrangeBold,
    // Heavy violet outline around residential/suburb/quarter/neighbourhood
    // polygons. Pure user preference — no device-profile knob, just the
    // raw flag from FEATURES (overridden by the user's UI toggle).
    settlementOutline: features.settlementOutline,

    // Relief stack — AND the user's feature flag with the device profile
    // capability so the union is respected (never render a heavy feature
    // on a low-tier device just because the user toggled it on).
    hillshade: features.hillshade,
    multiDirHillshade:
      features.hillshade && profileConfig.enableMultiDirHillshade,
    hypsometricTint:
      features.hypsometricTint && profileConfig.enableHypsoTint,
    bathymetry:
      features.bathymetry && profileConfig.enableHypsoTint,
    textureShading:
      features.textureShading && profileConfig.enableTextureShading,
    skyViewFactor:
      features.skyViewFactor && profileConfig.enableTextureShading,
    worldcoverTint: features.worldcoverTint,
    canopyHeightTint: features.canopyHeightTint,
    slopeWarning: features.slopeWarning,
    contours: features.contours && profileConfig.enableContours,
    ridgeOverlay:
      features.ridgeOverlay && profileConfig.enableRidgeOverlay,
    carpathian:
      features.carpathian && profileConfig.enableCarpathianOverlay,
    // Per-segment SAC trail web (informal paths, marked trails, via-ferrata,
    // steps, furniture, trail labels). Pure user preference NESTED inside the
    // umbrella `carpathian` block in composeLayers — it lets a user keep the
    // Carpathian detail (peaks, cableways, forest roads) while hiding the
    // bold red trail lines. No device-profile knob; the umbrella `carpathian`
    // already AND's the capability, so we pass the raw flag straight through.
    carpathianTrails: features.carpathianTrails,
    // Forest leaf-type biom polygons are gated by the same Carpathian
    // capability (the data lives in carpathian-osm.pmtiles) — there's
    // no separate device-profile knob, the renderer just AND's the
    // user flag with the umbrella Carpathian-overlay capability.
    forestLeafType:
      features.forestLeafType && profileConfig.enableCarpathianOverlay,
    // Forest-cover overlay reads the GLOBAL OpenMapTiles `landcover`
    // source the base map already consumes, so there's no Carpathian /
    // device-profile capability to AND against — the renderer emits it
    // on the raw user flag alone (the base vector source is always
    // present). See src/style/forest-cover.js + the 7c block in
    // src/style/index.js.
    forestCover: features.forestCover,
    // Swamp-cover overlay — like forestCover it reads the always-present
    // global landcover source, so there's no capability to AND against; the
    // renderer emits it on the raw user flag alone (the classified Tier B is
    // additionally source-gated on hasWetlandsSource in composeLayers).
    // Pure additive overlay — NOT wired into the flat-preset block above, so
    // relief/3D/contours stay on while swamps are shown.
    swampCover: features.swampCover,
    // Forest-mode markup accents — independent sub-flags surfaced through
    // the forest-mode sub-panel. They are pure user preferences (no
    // device-profile knob) and only have an effect inside the forestCover
    // block in composeLayers, so we pass the raw flags straight through;
    // "forest-mode only" is enforced structurally by the style builder.
    forestCities: features.forestCities,
    forestWaterAccent: features.forestWaterAccent,
    forestRoadsBold: features.forestRoadsBold,
    forestRoadsOrange: features.forestRoadsOrange,
    // Hazardous-terrain overlay shares the umbrella Carpathian
    // capability (data lives in carpathian-osm.pmtiles), but is a
    // SEPARATE user-facing toggle so a user can render the hazard
    // markers without the full trail / forest-road / via-ferrata
    // detail web. The renderer just AND's the user flag with the
    // umbrella enableCarpathianOverlay capability.
    hazardousTerrain:
      features.hazardousTerrain && profileConfig.enableCarpathianOverlay,
    // Hiking-route ribbons share the same source-layer parent
    // (`hiking_route` inside carpathian-osm.pmtiles), so they ride
    // the same umbrella capability. Independent user-facing toggle:
    // a user can render the coloured route ribbons WITHOUT the
    // per-segment SAC trail web (set carpathian off, hikingRoutes on)
    // and vice-versa. See src/style/hiking-routes.js for the layer
    // factory and src/style/index.js for the z-order placement.
    hikingRoutes:
      features.hikingRoutes && profileConfig.enableCarpathianOverlay,
    // 1 km coordinate grid — profile-independent (pure geometry,
    // no tiles), so it rides straight through from the feature flag.
    grid: features.grid,
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

function maxZoomForMode(mode, caps) {
  if (mode !== 'satellite') return VIEW.maxZoom;
  return Math.min(VIEW.maxZoom, getSatelliteMaxZoom({ pixelRatio: caps?.dpr }));
}

function syncMapZoomLimits(map, mode, caps) {
  const maxZoom = maxZoomForMode(mode, caps);
  map.setMaxZoom(maxZoom);
  if (map.getZoom() > maxZoom) {
    map.jumpTo({ zoom: maxZoom });
  }
}

/**
 * Resolve the effective feature set — user toggles AND device caps. The
 * caps side is small (just reduce-motion overrides), kept here so createMap
 * produces a fully-gated `features` object for buildStyle.
 */
function resolveFeatures(features, caps) {
  let resolved = features;
  if (caps?.prefersReducedMotion) {
    resolved = { ...resolved, terrain3D: false };
  }
  // Forest-cover is a deliberately FLAT, Google-Earth-style landcover view:
  // the green forest mass is the whole story, so every relief / 3D /
  // elevation cue is suppressed while the overlay is on. This is the
  // single source of truth for the flat preset — both the initial paint
  // and every applyStyle() rebuild route through here, and the runtime
  // terrain lifecycle (interactions.js) reads the same resolved
  // `terrain3D=false` so zoom events never re-add 3D terrain.
  //
  // Non-destructive: the user's stored relief prefs live in the control
  // state (state.layerFeatures), not here, so toggling forest-cover back
  // off restores them on the next rebuild.
  if (resolved.forestCover) {
    resolved = {
      ...resolved,
      terrain3D: false,
      hillshade: false,
      hypsometricTint: false,
      textureShading: false,
      skyViewFactor: false,
      ridgeOverlay: false,
      slopeWarning: false,
      contours: false,
      worldcoverTint: false,
      canopyHeightTint: false,
    };
  }
  return resolved;
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

  // Hypso initial state — caller can pre-seed via opts.hypsoState; the
  // UI persists user preferences in localStorage and forwards them at
  // boot. Falls back to the frozen HYPSO config defaults.
  const hypsoState = resolveInitialHypsoState(opts.hypsoState, features, profileConfig);

  // Map-mode router. The user's persisted choice wins; explicit
  // overrides (used by tests + the validator stub) take precedence
  // over both. If the persisted value is somehow not in MAP_MODES we
  // fall back to the default rather than throwing — the user
  // shouldn't be locked out of the map by a bad localStorage value.
  const requestedMode = opts.mode ?? loadMapMode();
  const mode = MAP_MODES.includes(requestedMode) ? requestedMode : DEFAULT_MAP_MODE;

  const style = await buildModeStyle({
    mode,
    theme,
    features,
    profileConfig,
    layerOpts,
    caps,
    hypsoState,
  });

  const map = new ml.Map({
    container,
    style,
    center: VIEW.center,
    zoom: VIEW.zoom,
    pitch: VIEW.pitch,
    bearing: VIEW.bearing,
    minZoom: VIEW.minZoom,
    maxZoom: maxZoomForMode(mode, caps),
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
    hypso: hypsoState,
    mode,
  };
  seedHypsoState(map, hypsoState);

  // Probe native color-relief once the DEM source has loaded so the
  // first ramp swap by the UI can take the fast path. Runs idempotently
  // on every styledata, but the probe itself is cached on `_cart`.
  map.once('styledata', () => detectHypsoCaps(map));
  map.on('styledata', () => {
    if (!map._cart?.hypsoCaps) detectHypsoCaps(map);
  });

  return map;
}

/**
 * Compute the initial hypso state for a fresh map. Caller-supplied
 * `hypsoState` always wins so the UI can persist the user's last choice
 * via localStorage; otherwise we read the frozen HYPSO defaults.
 *
 * @param {object|undefined} preSeeded
 * @param {object} features
 * @param {object} profileConfig
 * @returns {object}
 */
function resolveInitialHypsoState(preSeeded, features, profileConfig) {
  const enabledByProfile = !!profileConfig.enableHypsoTint;
  const enabledByFeature = !!features.hypsometricTint;
  const enabled = enabledByProfile && enabledByFeature;
  const wantColorRelief = !!features.colorRelief && enabled;
  return {
    rampId: preSeeded?.rampId ?? HYPSO.defaultRampId ?? DEFAULT_RAMP_ID,
    strength: preSeeded?.strength ?? HYPSO.defaultStrength,
    mode: preSeeded?.mode ?? (wantColorRelief ? 'native' : enabled ? 'raster' : 'off'),
    bathymetry: preSeeded?.bathymetry ?? HYPSO.bathymetryDefault,
    highContrast: preSeeded?.highContrast ?? HYPSO.highContrastDefault,
    theme: preSeeded?.theme ?? DEFAULT_THEME,
    rasterUrls: { ...HYPSO.rasterUrls, ...(preSeeded?.rasterUrls ?? {}) },
  };
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

  // Hypso state survives style rebuilds. theme rides along so the
  // ramp expression switches light↔dark in the new style spec without
  // a second imperative step.
  //
  // Edge case: when the user re-enables the Hypsometric tint feature
  // flag after a previous off cycle, `prev.hypso.mode` is stuck on
  // 'off' — and the composer's `resolveHypsoMode` short-circuits to
  // 'off' even though the flag is now true, so no hypso layers get
  // emitted. We detect that off→on transition and drop the cached
  // mode so resolveHypsoMode falls through to its native→raster→off
  // preference chain. Symmetrically, an on→off transition forces the
  // mode back to 'off' so the leftover state doesn't briefly re-emit
  // the layer on the next applyStyle.
  const wasTintOn = !!prev.features?.hypsometricTint;
  const isTintOn = !!features.hypsometricTint;
  const hypsoState = {
    ...(prev.hypso ?? {}),
    ...(patch.hypsoState ?? {}),
    theme,
  };
  if (!wasTintOn && isTintOn && !patch.hypsoState?.mode) {
    delete hypsoState.mode;
  } else if (wasTintOn && !isTintOn && !patch.hypsoState?.mode) {
    hypsoState.mode = 'off';
  }

  // Route through the mode dispatcher so theme / profile / feature
  // patches keep working in Cart mode AND don't accidentally clobber
  // a Standard / Satellite style with our composeLayers stack. Non-Cart
  // modes still receive app-owned dynamic overlays such as the coordinate
  // grid, but not the full Cart relief/road/landcover stack.
  const mode = patch.mode ?? prev.mode ?? DEFAULT_MAP_MODE;

  const style = await buildModeStyle({
    mode,
    theme,
    features,
    profileConfig,
    layerOpts,
    caps,
    hypsoState,
    map,
  });
  map.setStyle(style, { diff: false });
  syncMapZoomLimits(map, mode, caps);

  // The new style means the native-color-relief probe (if any) needs
  // re-running because the layer may have been recreated.
  clearHypsoCaps(map);

  map._cart = {
    ...prev,
    theme,
    profile,
    profileConfig,
    features,
    layerOpts,
    hypso: hypsoState,
    mode,
  };
  seedHypsoState(map, hypsoState);
  return map;
}

// ---------------------------------------------------------------------------
// Mode router. The brief asks us to keep the camera intact during a mode
// switch (no flyTo, no jumpTo) and to gracefully fall back to Cart when
// the third-party Standard fetch fails.
// ---------------------------------------------------------------------------

/**
 * Dispatch on `mode` to produce the appropriate MapLibre style JSON.
 *
 *   • cart       — the full composeLayers / composeSources stack
 *   • standard   — third-party style plus app-owned dynamic overlays
 *   • satellite  — locally-composed minimal raster + labels skeleton
 *
 * The Standard branch falls back to Cart with a single console.warn if
 * the upstream fetch fails (e.g. network down, CORS, 5xx). That keeps
 * the map renderable in adverse conditions.
 *
 * Pure with respect to the map instance — caller is responsible for
 * `map.setStyle` and any post-load state seeding.
 */
async function buildModeStyle(opts) {
  const { mode, theme = DEFAULT_THEME, features = {} } = opts;
  if (mode === 'standard') {
    try {
      const upstream = await fetch(STANDARD_STYLE_URL, { cache: 'force-cache' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
      if (!upstream || typeof upstream !== 'object') {
        throw new Error('Upstream style is not an object');
      }
      return withModeOverlays(upstream, getTokens(theme), features);
    } catch (err) {
      // Soft fallback per the brief — render Cart instead and warn
      // exactly once so users see something useful even on bad
      // networks.
      // eslint-disable-next-line no-console
      console.warn(
        '[cart] Failed to load Standard style from %s — falling back to Cart. %o',
        STANDARD_STYLE_URL,
        err,
      );
      return buildStyle(opts);
    }
  }
  if (mode === 'satellite') {
    const style = composeSatelliteStyle({ pixelRatio: opts.caps?.dpr });
    return withModeOverlays(style, getTokens(theme), features);
  }
  return buildStyle(opts);
}

function withModeOverlays(style, t, features = {}) {
  const vectorSource = {
    type: 'vector',
    url: OPENFREEMAP.tilejson,
    attribution: OPENFREEMAP.attribution,
  };
  return withGridOverlay(
    withSettlementOutlineOverlay(style, t, {
      enabled: features.settlementOutline !== false,
      vectorSource,
    }),
    t,
    { enabled: !!features.grid },
  );
}

/**
 * Switch the live map to a new visual mode. Camera (centre / zoom /
 * pitch / bearing) is preserved automatically by `setStyle({ diff:
 * false })` — MapLibre keeps the transform across the swap. Persisted
 * to localStorage so a reload restores the user's choice.
 *
 * @param {maplibregl.Map} map
 * @param {'cart'|'standard'|'satellite'} mode
 * @returns {Promise<maplibregl.Map>}
 */
export async function applyMapMode(map, mode) {
  if (!MAP_MODES.includes(mode)) return map;
  const prev = map._cart ?? {};
  if (prev.mode === mode) return map;

  // --- Normal MapLibre mode switch ------------------------------------
  // Run the next style build through the same plumbing as a regular
  // style rebuild. theme / features / profile carry over so the user
  // doesn't lose them across a mode swap.
  await applyStyle(map, { mode });
  saveMapMode(mode);
  return map;
}
