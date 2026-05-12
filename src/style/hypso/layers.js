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

import { linZoom } from '../../utils/interp.js';
import {
  buildColorReliefExpression,
  buildStrengthExpression,
  DEFAULT_STRENGTH_STOPS,
} from './expression.js';

/** Stable ids used by the rest of the pipeline. */
export const HYPSO_NATIVE_LAYER_ID = 'hypso_color_relief';
export const HYPSO_RASTER_LAYER_PREFIX = 'hypso_raster_';
export const HYPSO_NATIVE_DEM_SOURCE = 'terrain-dem';
export const HYPSO_LAYER_META = 'cart:hypso';

/**
 * Per-zoom hillshade-exaggeration multiplier applied WHEN hypso is
 * active.
 *
 * Each stop is the fraction of the hillshade's standalone strength
 * that survives when hypso is at full strength (1.0). At z=3 we keep
 * 55 % because hypso visually dominates the overview anyway; at z=12+
 * we restore hillshade to ~95 % so the city zoom reads as terrain
 * texture under a colour bias, NOT as a flat orange wash.
 *
 * The previous (more aggressive) curve dropped hillshade to 45 % at
 * z=8 and 70 % at z=12. Combined with a full-opacity hypso layer that
 * was the recipe for the "everything melts together" bug — see the
 * screenshots in the repo root.
 *
 * interactions.js + runtime.js read this curve.
 *
 * @type {ReadonlyArray<[number, number]>}
 */
export const HILLSHADE_BLEND = Object.freeze([
  [3, 0.55],
  [8, 0.7],
  [12, 0.95],
  [15, 1.0],
]);

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
      'raster-resampling': 'linear',
    },
  };
}

/**
 * Standalone hillshade-opacity expression for when hypso is active.
 * interactions.js uses this to fade the hillshade layer's exaggeration
 * with a single setPaintProperty call.
 *
 * @param {number} strength 0..1.5 — current hypso strength.
 * @param {number} hillshadeBaseMul Per-direction baseline multiplier on
 *   the hillshade layer (see HILLSHADE_BASE_MUL_META in terrain.js).
 * @returns {Array} MapLibre interpolate expression.
 */
export function buildBlendedHillshadeExaggeration(strength, hillshadeBaseMul) {
  // When strength is low (hypso barely visible) the blend should leave
  // hillshade alone — multiply HILLSHADE_BLEND's reduction by
  // (1 - strength) and add it back to 1.
  const s = Math.max(0, Math.min(1.5, Number(strength) || 0));
  const stops = HILLSHADE_BLEND.map(([z, reduction]) => {
    const factor = 1 - (1 - reduction) * Math.min(s, 1);
    return [z, Number((factor * hillshadeBaseMul).toFixed(4))];
  });
  return linZoom(stops);
}
