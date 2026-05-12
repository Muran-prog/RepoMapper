/**
 * Hypsometric runtime — imperative paint-property updates.
 *
 * The composer in `index.js` produces a static style with the *initial*
 * ramp/mode/strength baked in. Once the map is live, the UI changes
 * those values through this module — which never rebuilds the style,
 * never re-installs sources, only the minimum surgical mutation needed
 * to reflect the change.
 *
 * Why a separate module from layers.js?
 * -------------------------------------
 * layers.js is pure (no MapLibre instance, no DOM). It produces layer
 * specs given inputs. runtime.js is the impure counterpart: given a map
 * instance + new inputs, it mutates the live style. This split keeps
 * the spec generators trivially testable in Node, and the runtime
 * adapter focused on MapLibre lifecycle hazards (layer-not-present,
 * source-not-yet-loaded, race conditions during a style swap).
 *
 * Operations
 * ----------
 *   applyHypsoRamp(map, rampId)        switch ramp; instant.
 *   applyHypsoStrength(map, strength)  scale opacity curve; instant.
 *   applyHypsoMode(map, mode)          flip native↔raster↔off; surgical
 *                                       layer/source swap, no setStyle.
 *
 * All three honour `map._cart.hypso` as the canonical state — UI reads
 * from there, the runtime module writes to there alongside the paint
 * mutation. Other modules (legend, picker) listen via the `cart:hypso`
 * CustomEvent dispatched after every successful state change.
 *
 * Hillshade smart-blend
 * ---------------------
 * When the active hypso strength changes we also recompute every
 * hillshade layer's exaggeration to keep the relief stack readable —
 * see `buildBlendedHillshadeExaggeration` in layers.js. The blend can
 * be disabled by passing `{ smartBlend: false }` to applyHypsoStrength,
 * useful from tests that want to assert just the hypso paint property.
 */

import {
  HYPSO_LAYER_META,
  HYPSO_NATIVE_LAYER_ID,
  HYPSO_NATIVE_DEM_SOURCE,
  HYPSO_RASTER_LAYER_PREFIX,
  buildBlendedHillshadeExaggeration,
} from './layers.js';
import {
  buildColorReliefExpression,
  buildStrengthExpression,
  DEFAULT_STRENGTH_STOPS,
} from './expression.js';
import {
  HILLSHADE_BASE_MUL_META,
  hillshadeExaggeration,
} from '../terrain.js';
import { getRamp, getRampStops, DEFAULT_RAMP_ID } from './ramps.js';
import { contrastBoostStops } from './color.js';

/**
 * Live state stamped on the map instance. UI + runtime both read/write.
 *
 * @typedef {object} HypsoState
 * @property {string}  rampId
 * @property {number}  strength
 * @property {'native'|'raster'|'off'} mode
 * @property {boolean} bathymetry
 * @property {boolean} highContrast
 * @property {string}  theme
 * @property {Record<string, string|null>} [rasterUrls] rampId → pmtiles URL.
 * @property {Array<[number, number]>} [strengthStops]
 */

/** @returns {HypsoState} */
function getState(map) {
  const cart = map._cart ?? (map._cart = {});
  if (!cart.hypso) {
    cart.hypso = {
      rampId: DEFAULT_RAMP_ID,
      strength: 1,
      mode: 'off',
      bathymetry: true,
      highContrast: false,
      theme: cart.theme ?? 'light',
      rasterUrls: {},
      strengthStops: DEFAULT_STRENGTH_STOPS,
    };
  }
  return cart.hypso;
}

/** @param {maplibregl.Map} map */
function dispatch(map) {
  if (typeof window === 'undefined') return;
  const evt = new CustomEvent('cart:hypso', { detail: { ...getState(map) } });
  map.getContainer?.()?.dispatchEvent?.(evt);
  window.dispatchEvent(new CustomEvent('cart:hypso', { detail: { ...getState(map) } }));
}

/**
 * Find the currently-active hypso layer (native or raster). Returns
 * `null` if no hypso layer is in the live style — e.g. after the user
 * toggled hypso off and we haven't reinstalled it yet.
 *
 * @param {maplibregl.Map} map
 * @returns {object|null} Live layer object as exposed by getStyle().
 */
export function findActiveHypsoLayer(map) {
  if (typeof map.getStyle !== 'function') return null;
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return null;
  return style.layers.find((l) => l?.metadata && HYPSO_LAYER_META in l.metadata) ?? null;
}

/**
 * Apply a new active ramp. Updates the relevant paint property in place
 * (native: `color-relief-color`; raster: surgical source+layer swap).
 *
 * @param {maplibregl.Map} map
 * @param {string} rampId
 * @param {object} [opts]
 * @param {boolean} [opts.dispatch=true]
 */
export function applyHypsoRamp(map, rampId, opts = {}) {
  const { dispatch: shouldDispatch = true } = opts;
  const state = getState(map);
  state.rampId = rampId;
  const baseStops = getRampStops(rampId, state.theme);
  const stops = state.highContrast ? contrastBoostStops(baseStops) : baseStops;

  const layer = findActiveHypsoLayer(map);
  if (!layer) {
    if (shouldDispatch) dispatch(map);
    return false;
  }

  const meta = layer.metadata[HYPSO_LAYER_META];

  if (meta.mode === 'native') {
    const expr = buildColorReliefExpression(stops, { bathymetry: state.bathymetry });
    try {
      map.setPaintProperty(layer.id, 'color-relief-color', expr);
      meta.rampId = rampId;
    } catch {
      // Layer disappeared mid-flight (style swap). Caller should
      // refresh on the next styledata.
      if (shouldDispatch) dispatch(map);
      return false;
    }
    if (shouldDispatch) dispatch(map);
    return true;
  }

  if (meta.mode === 'raster') {
    const ok = swapRasterRamp(map, layer, rampId);
    if (shouldDispatch) dispatch(map);
    return ok;
  }

  if (shouldDispatch) dispatch(map);
  return false;
}

/**
 * Surgical source + layer swap for the raster path. The new ramp's
 * PMTiles archive URL is resolved from `state.rasterUrls`. If no URL
 * is configured for the target ramp, the swap is rejected and the
 * caller can choose to fall back to the previous ramp.
 *
 * @returns {boolean} true on successful swap.
 */
function swapRasterRamp(map, oldLayer, rampId) {
  const state = getState(map);
  const url = state.rasterUrls?.[rampId];
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  const newSourceId = `hypso-raster-${rampId}`;
  const newLayerId = `${HYPSO_RASTER_LAYER_PREFIX}${rampId}`;

  // Pre-existing? Just reuse.
  if (!map.getSource(newSourceId)) {
    try {
      map.addSource(newSourceId, {
        type: 'raster',
        url,
        tileSize: 256,
        minzoom: 2,
        maxzoom: 12,
      });
    } catch {
      return false;
    }
  }

  // Find old layer's z-order anchor.
  const style = map.getStyle();
  const idx = style.layers.findIndex((l) => l.id === oldLayer.id);
  const beforeId = idx >= 0 && idx + 1 < style.layers.length ? style.layers[idx + 1].id : undefined;

  try {
    map.addLayer(
      {
        id: newLayerId,
        type: 'raster',
        source: newSourceId,
        metadata: { [HYPSO_LAYER_META]: { mode: 'raster', rampId } },
        paint: {
          'raster-opacity': buildStrengthExpression(state.strength, {
            baseStops: state.strengthStops,
          }),
          'raster-resampling': 'linear',
        },
      },
      beforeId,
    );
  } catch {
    return false;
  }

  try {
    if (map.getLayer(oldLayer.id)) map.removeLayer(oldLayer.id);
    // Don't remove the old source — keep it warm so flipping back is
    // instant. The tile-cache LRU handles eviction.
  } catch {
    /* not fatal */
  }
  return true;
}

/**
 * Update the strength (opacity curve scaler) of the active hypso
 * layer. Also rebalances the hillshade exaggeration so the relief
 * stack stays readable when both layers are on.
 *
 * @param {maplibregl.Map} map
 * @param {number} strength 0..1.5
 * @param {object} [opts]
 * @param {boolean} [opts.smartBlend=true]
 * @param {boolean} [opts.dispatch=true]
 */
export function applyHypsoStrength(map, strength, opts = {}) {
  const { smartBlend = true, dispatch: shouldDispatch = true } = opts;
  const state = getState(map);
  const clamped = Math.max(0, Math.min(1.5, Number(strength) || 0));
  state.strength = clamped;

  const layer = findActiveHypsoLayer(map);
  if (layer) {
    const paintProp = layer.type === 'color-relief' ? 'color-relief-opacity' : 'raster-opacity';
    const expr = buildStrengthExpression(clamped, { baseStops: state.strengthStops });
    try {
      map.setPaintProperty(layer.id, paintProp, expr);
    } catch {
      /* swallow — UI will retry on next styledata */
    }
  }

  if (smartBlend) {
    rebalanceHillshadeForHypso(map, clamped);
  }

  if (shouldDispatch) dispatch(map);
}

/**
 * Repaint each hillshade layer's exaggeration in light of the active
 * hypso strength. When strength is 0 hillshade is left alone.
 */
function rebalanceHillshadeForHypso(map, strength) {
  if (typeof map.getStyle !== 'function') return;
  const style = map.getStyle();
  if (!style?.layers) return;
  const reduceMotion = !!map._cart?.caps?.prefersReducedMotion;
  const userMul = map._cart?.userExaggerationMul ?? 1;
  for (const layer of style.layers) {
    if (layer.type !== 'hillshade') continue;
    const baseMul = layer.metadata?.[HILLSHADE_BASE_MUL_META] ?? 1;
    const effMul = baseMul * userMul;
    const expr = strength > 0
      ? buildBlendedHillshadeExaggeration(strength, effMul)
      : hillshadeExaggeration(effMul, reduceMotion);
    try {
      map.setPaintProperty(layer.id, 'hillshade-exaggeration', expr);
    } catch {
      /* layer not attached — next styledata will pick it up */
    }
  }
}

/**
 * Update the theme bound to the hypso state and refresh the active
 * ramp expression so the colour table swaps light→dark or vice-versa
 * without a style rebuild.
 *
 * @param {maplibregl.Map} map
 * @param {'light'|'dark'} theme
 */
export function applyHypsoTheme(map, theme) {
  const state = getState(map);
  state.theme = theme;
  applyHypsoRamp(map, state.rampId);
}

/**
 * Update the bathymetry toggle and refresh the active expression.
 *
 * @param {maplibregl.Map} map
 * @param {boolean} on
 */
export function applyHypsoBathymetry(map, on) {
  const state = getState(map);
  state.bathymetry = !!on;
  applyHypsoRamp(map, state.rampId);
}

/**
 * Toggle high-contrast mode for the active ramp. The transformation
 * is performed in CIELAB by `contrastBoostStops` and applied via
 * setPaintProperty — no style rebuild, no source reload.
 *
 * @param {maplibregl.Map} map
 * @param {boolean} on
 */
export function applyHypsoHighContrast(map, on) {
  const state = getState(map);
  state.highContrast = !!on;
  applyHypsoRamp(map, state.rampId);
}

/**
 * Seed `_cart.hypso` from the initial compose-time options. Called by
 * createMap.js after the map is constructed so subsequent UI events
 * see the canonical starting state.
 *
 * @param {maplibregl.Map} map
 * @param {Partial<HypsoState>} initial
 */
export function seedHypsoState(map, initial = {}) {
  const state = getState(map);
  Object.assign(state, initial);
}
