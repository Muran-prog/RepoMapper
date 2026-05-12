/**
 * Hypsometric tint subsystem — public API.
 *
 * This barrel re-exports the pieces the rest of the codebase consumes:
 *
 *   • Ramp dictionary + lookup helpers (`ramps.js`)
 *   • LAB colour interpolation (`color.js`)
 *   • MapLibre expression generators (`expression.js`)
 *   • Layer factories for native/raster/off modes (`layers.js`)
 *   • Runtime feature detection (`detect.js`)
 *   • Imperative paint-property updates (`runtime.js`)
 *
 * The split into many files is deliberate — every file has a single
 * job, every export is pure unless it's in `runtime.js`. Style-spec
 * tests in `validate.cjs` import only the pure modules, MapLibre
 * runtime imports `runtime.js` for instance-bound mutation.
 */

export {
  RAMPS,
  RAMP_IDS,
  DEFAULT_RAMP_ID,
  FALLBACK_RAMP_ID,
  getRamp,
  getRampStops,
  rampHasBathymetry,
  rampToCssGradient,
  registerCustomRamps,
  getCustomRamps,
  listRampIds,
} from './ramps.js';

export {
  hexToLab,
  labToHex,
  lerpHexLab,
  densifyStopsLab,
  contrastBoostStops,
} from './color.js';

export {
  buildColorReliefExpression,
  buildStrengthExpression,
  evaluateStrengthAtZoom,
  buildDensifiedStops,
  buildGdaldemRamp,
  DEFAULT_STRENGTH_STOPS,
  STRENGTH_OPACITY_CEILING,
  DEFAULT_DENSIFY,
} from './expression.js';

export {
  HYPSO_HILLSHADE_BLEND,
  evalLinearStops,
} from './curves.js';

export {
  composeHypsoLayers,
  buildBlendedHillshadeExaggeration,
  HYPSO_NATIVE_LAYER_ID,
  HYPSO_RASTER_LAYER_PREFIX,
  HYPSO_NATIVE_DEM_SOURCE,
  HYPSO_LAYER_META,
  HILLSHADE_BLEND,
} from './layers.js';

export {
  detectHypsoCaps,
  clearHypsoCaps,
} from './detect.js';

export {
  applyHypsoRamp,
  applyHypsoStrength,
  applyHypsoStrengthAtZoom,
  applyHypsoTheme,
  applyHypsoBathymetry,
  applyHypsoHighContrast,
  rebalanceHillshadeForHypso,
  findActiveHypsoLayer,
  seedHypsoState,
} from './runtime.js';
