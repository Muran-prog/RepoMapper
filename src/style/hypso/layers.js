/**
 * Hypsometric tint — layer factories.
 *
 * Three pluggable paths share the same authored ramp dictionary:
 *
 *   • `native`     — a `color-relief` layer reading from the primary
 *                    raster-dem source. Highest fidelity, no extra
 *                    sources, ramp/strength change is a paint update.
 *   • `raster`     — pre-rendered PMTiles archives, one per ramp id.
 *                    Picked when the runtime lacks `color-relief`.
 *   • `off`        — no layer emitted at all. Picked when neither path
 *                    has a backing source / capability.
 *
 * `composeHypsoLayers()` returns the layer specs for whichever path is
 * active. The choice is made by the caller (createMap / style index)
 * after feature detection. We never decide path here so the same
 * factories are testable in Node without MapLibre being present.
 *
 * Land-only mask
 * --------------
 * To prevent the tint from staining sea/lake polygons, every layer
 * carries an `id` discoverable by `interactions.js`, which sets the
 * water-overlay layers (`water_fill`, `water_intermittent`) above the
 * hypso layer in z-order. The composer in `src/style/index.js` already
 * places hypso below water_fill — see the canonical z-order docblock.
 * The "land-only" guarantee is therefore a property of layer ORDER, not
 * a per-tile alpha mask. This is cheaper, exact, and works identically
 * for native and raster paths.
 *
 * Smart hillshade blending
 * ------------------------
 * When hypso is active and ramp strength > 0 we want the hillshade to
 * gracefully fade so the colour wash stays legible. That coupling is
 * applied imperatively from `interactions.js` via `setPaintProperty(
 * hillshadeLayer, 'hillshade-exaggeration', …)` — see HILLSHADE_BLEND
 * for the curve. This module just declares the layer; the blend is a
 * pure paint-property update at runtime.
 *
 * @typedef {[number, string]} HypsoStop
 */

import {
  buildColorReliefExpression,
  buildStrengthExpression,
  DEFAULT_STRENGTH_STOPS,
} from './expression.js';
import { HYPSO_HILLSHADE_BLEND } from './curves.js';

/** Stable ids used by the rest of the pipeline. */
export const HYPSO_NATIVE_LAYER_ID = 'hypso_color_relief';
export const HYPSO_RASTER_LAYER_PREFIX = 'hypso_raster_';
export const HYPSO_NATIVE_DEM_SOURCE = 'terrain-dem';
export const HYPSO_LAYER_META = 'cart:hypso';

/**
 * Re-export the canonical hillshade-blend curve under its historical
 * name. Kept for backwards-compatibility with any external consumer
 * that imported `HILLSHADE_BLEND` from the hypso barrel before the
 * move; the authoritative copy lives in `./curves.js` because both
 * `terrain.js` and this file need it without a circular import.
 */
export const HILLSHADE_BLEND = HYPSO_HILLSHADE_BLEND;

/**
 * @typedef {object} HypsoLayerOpts
 * @property {string} mode           'native' | 'raster' | 'off'
 * @property {string} rampId
 * @property {ReadonlyArray<HypsoStop>} stops
 * @property {number} strength       0..1.5
 * @property {boolean} bathymetry
 * @property {string|null} [rasterSourceId] Source id when mode='raster'.
 * @property {Array<[number, number]>} [strengthStops]
 */

/**
 * Produce the active hypsometric layer specs for the chosen mode.
 *
 * @param {HypsoLayerOpts} opts
 * @returns {Array<object>}
 */
export function composeHypsoLayers(opts) {
  const {
    mode,
    rampId,
    stops,
    strength,
    bathymetry,
    rasterSourceId = null,
    strengthStops = DEFAULT_STRENGTH_STOPS,
  } = opts;

  if (mode === 'native') {
    return [nativeColorReliefLayer({ rampId, stops, strength, bathymetry, strengthStops })];
  }
  if (mode === 'raster' && typeof rasterSourceId === 'string') {
    return [rasterHypsoLayer({ rampId, strength, sourceId: rasterSourceId, strengthStops })];
  }
  return [];
}

/**
 * Native MapLibre `color-relief` layer. The paint expression is built
 * from the densified, LAB-interpolated stops so the GPU's linear-RGB
 * blend lands close to a perceptually uniform curve.
 *
 * The layer carries metadata flagging it as hypsometric so generic
 * code paths (theme switcher, interactions.js) can find it without
 * string-matching on layer ids.
 */
function nativeColorReliefLayer({ rampId, stops, strength, bathymetry, strengthStops }) {
  return {
    id: HYPSO_NATIVE_LAYER_ID,
    type: 'color-relief',
    source: HYPSO_NATIVE_DEM_SOURCE,
    metadata: {
      [HYPSO_LAYER_META]: { mode: 'native', rampId },
    },
    paint: {
      'color-relief-color': buildColorReliefExpression(stops, { bathymetry }),
      'color-relief-opacity': buildStrengthExpression(strength, { baseStops: strengthStops }),
      // Zero transition: opacity updates from the runtime (ramp swap,
      // strength change, theme flip, autoregion pick) must land
      // instantly. The 220ms style-wide transition drifts opacity
      // through intermediate values and produces the "ramp swap is
      // sometimes visible, sometimes not" symptom — pinning the
      // per-property transition to 0 makes the runtime's
      // setPaintProperty calls deterministic.
      //
      // Note: only opacity is transitionable per the style spec
      // (`color-relief-color` itself has `transition: false`), so we
      // only emit the opacity-transition override.
      'color-relief-opacity-transition': { duration: 0, delay: 0 },
    },
  };
}

/**
 * Raster hypsometric layer — reads from a pre-rendered PMTiles archive.
 * The ramp is baked into the archive, so swapping ramps requires
 * swapping sources. See `applyHypsoRamp` in `ui/hypso/index.js` for the
 * runtime swap logic.
 */
function rasterHypsoLayer({ rampId, strength, sourceId, strengthStops }) {
  return {
    id: `${HYPSO_RASTER_LAYER_PREFIX}${rampId}`,
    type: 'raster',
    source: sourceId,
    metadata: {
      [HYPSO_LAYER_META]: { mode: 'raster', rampId },
    },
    paint: {
      'raster-opacity': buildStrengthExpression(strength, { baseStops: strengthStops }),
      'raster-opacity-transition': { duration: 0, delay: 0 },
      'raster-resampling': 'linear',
    },
  };
}

/**
 * Hillshade-exaggeration helper for callers that want the blended
 * curve emitted directly. Thin wrapper around
 * `terrain.js::buildHillshadeExaggerationExpr` — kept under its
 * historical signature so external consumers continue to compile.
 *
 * IMPORTANT: this used to live here and held a now-fixed bug where it
 * emitted the blend factor as an ABSOLUTE exaggeration instead of a
 * multiplier on the base curve. New code should call the terrain
 * helper directly so user-mul, reduce-motion, and the per-direction
 * baseMul stay coherent.
 *
 * The import is dynamic to dodge the circular dep with `terrain.js`
 * (which imports `composeHypsoLayers` from this file). The function
 * is only ever called at runtime, never at module-init, so the cycle
 * never bites.
 *
 * @param {number} strength 0..1.5
 * @param {number} hillshadeBaseMul
 * @returns {Promise<Array>|Array} MapLibre interpolate expression.
 */
export async function buildBlendedHillshadeExaggeration(strength, hillshadeBaseMul) {
  const { buildHillshadeExaggerationExpr } = await import('../terrain.js');
  return buildHillshadeExaggerationExpr({
    baseMul: hillshadeBaseMul,
    userMul: 1,
    hypsoStrength: strength,
    hypsoActive: strength > 0,
    reduceMotion: false,
  });
}
