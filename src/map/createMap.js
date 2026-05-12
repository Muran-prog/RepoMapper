/**
 * Map factory.
 *
 * Responsibilities:
 *   1. Register the `pmtiles://` protocol so PMTiles archives can be used
 *      as drop-in replacements for the live tile server.
 *   2. Resolve the vector tile source descriptor from configuration.
 *   3. Fetch the upstream OpenFreeMap "Liberty" style once at boot to mine
 *      it for the auto-versioned `glyphs` and `sprite` URLs.
 *   4. Apply the active device performance profile to the Map options and
 *      to the layer-composition options.
 *   5. Hand a fully-formed `maplibregl.Map` back to the caller.
 *
 * No layer or token logic lives here — those concerns are in src/style/.
 * No device-detection logic lives here either — that's in src/device.js;
 * we just consume the precomputed profile.
 */

import {
  VIEW,
  SOURCE_BACKEND,
  OPENFREEMAP,
  PMTILES,
  PERF,
  FEATURES,
  DEFAULT_THEME,
} from '../config.js';
import { composeLayers } from '../style/index.js';
import {
  detectCaps,
  deriveProfile,
  getProfileConfig,
  getTouchTuning,
} from '../device.js';

// ---------------------------------------------------------------------------
// PMTiles protocol — register once per page lifetime.
// ---------------------------------------------------------------------------
let pmtilesRegistered = false;

function registerPMTilesProtocol() {
  if (pmtilesRegistered) return;
  if (typeof window === 'undefined') return;
  const ml = window.maplibregl;
  const pm = window.pmtiles;
  if (!ml || !pm) return;
  const protocol = new pm.Protocol({ metadata: true });
  ml.addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

// ---------------------------------------------------------------------------
// Source resolution. Returns a `{ sources, glyphs, sprite }` triple for the
// active backend. Falls back to hardcoded URLs if upstream discovery fails.
// ---------------------------------------------------------------------------

async function resolveSourceTriple() {
  if (SOURCE_BACKEND === 'pmtiles') {
    return {
      sources: {
        openmaptiles: {
          type: 'vector',
          url: PMTILES.url,
          attribution: PMTILES.attribution,
        },
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
    sources: {
      openmaptiles: {
        type: 'vector',
        url: OPENFREEMAP.tilejson,
        attribution: OPENFREEMAP.attribution,
      },
    },
    glyphs,
    sprite,
  };
}

// ---------------------------------------------------------------------------
// Style assembly.
// ---------------------------------------------------------------------------

async function buildStyle({ theme, layerOpts }) {
  const triple = await resolveSourceTriple();
  return {
    version: 8,
    name: `Cart · Ukraine (${theme})`,
    metadata: { theme, schema: 'openmaptiles' },
    sources: triple.sources,
    glyphs: triple.glyphs,
    sprite: triple.sprite,
    layers: composeLayers({ theme, ...layerOpts }),
    transition: { duration: 220, delay: 0 },
    light: { anchor: 'viewport', color: 'white', intensity: 0.4 },
  };
}

// ---------------------------------------------------------------------------
// Profile bridging — convert the per-device profile config into the two
// shape MapLibre cares about: top-level Map options vs composeLayers opts.
// ---------------------------------------------------------------------------

function profileToLayerOpts(profileConfig, feature) {
  return {
    buildings3D: feature.buildings3D && profileConfig.buildings3D,
    pois: feature.pois,
    labels: feature.labels,
    density: profileConfig.labelDensity,
    placeRankCutoff: profileConfig.placeRankCutoff,
    poiRankCutoff: profileConfig.poiRankCutoff,
    poiDotRankCutoff: profileConfig.poiDotRankCutoff,
    textPaddingMul: profileConfig.textPaddingMul,
    poiSizeMul: profileConfig.poiSizeMul,
    enableNeighbourhoods: profileConfig.enableNeighbourhoods,
    enableHamlets: profileConfig.enableHamlets,
    enableSuburbs: profileConfig.enableSuburbs,
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
 *                                               toggles on/off (labels, pois,
 *                                               buildings3D).
 * @returns {Promise<maplibregl.Map>}
 */
export async function createMap(container, opts = {}) {
  registerPMTilesProtocol();

  const ml = window.maplibregl;
  if (!ml) throw new Error('maplibre-gl is not loaded on window');

  const theme = opts.theme ?? DEFAULT_THEME;
  const caps = opts.caps ?? detectCaps();
  const profile = opts.profile ?? deriveProfile(caps);
  const profileConfig = getProfileConfig(profile);
  const features = { ...FEATURES, ...(opts.featureOverrides ?? {}) };

  const layerOpts = profileToLayerOpts(profileConfig, features);
  const mapOpts = profileToMapOpts(profileConfig);
  const touchTuning = getTouchTuning(caps);

  const style = await buildStyle({ theme, layerOpts });

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

    // Ukrainian / Cyrillic glyphs ship in the OpenFreeMap font tiles, so
    // we don't need a local font fallback. Setting this to false keeps
    // CJK rendering disabled (we don't need it for Ukraine).
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

    // Honour user accessibility preference.
    ...(caps?.prefersReducedMotion ? { transformRequest: undefined } : {}),
  });

  // Stash device/style state on the map so the UI controls can rebuild the
  // style without reaching back into the bootstrap closure.
  map._cart = {
    theme,
    caps,
    profile,
    profileConfig,
    layerOpts,
    features,
  };

  return map;
}

/**
 * Rebuild and apply a fresh style to an existing map instance — used by the
 * theme switcher and the layer toggles. Pass any subset of `theme`,
 * `profile`, or `featureOverrides`; everything else is preserved.
 */
export async function applyStyle(map, patch = {}) {
  const prev = map._cart ?? {};
  const theme = patch.theme ?? prev.theme ?? DEFAULT_THEME;
  const profile = patch.profile ?? prev.profile ?? 'medium';
  const profileConfig = patch.profileConfig ?? prev.profileConfig ?? getProfileConfig(profile);
  const features = { ...prev.features, ...(patch.featureOverrides ?? {}) };

  const layerOpts = profileToLayerOpts(profileConfig, features);
  const style = await buildStyle({ theme, layerOpts });
  map.setStyle(style, { diff: false });

  map._cart = { ...prev, theme, profile, profileConfig, layerOpts, features };
  return map;
}
