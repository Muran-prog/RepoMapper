/**
 * Runtime z-order helpers for app-owned overlay layers.
 *
 * MapLibre style rebuilds drop dynamic draw/contour layers, and user
 * toggles can move style-owned settlement outlines after the style has
 * loaded. Keeping the layer-id lists here gives the drawing and contour
 * engines a shared, idempotent way to converge on the requested order.
 */

export const SETTLEMENT_CONTOURS_TOP_KEY = 'settlementContoursTop';

const DRAW_LAYER_IDS = Object.freeze([
  'cart-draw-fill',
  'cart-draw-line-casing',
  'cart-draw-line',
  'cart-draw-line-preview',
  'cart-draw-arrow-head',
  'cart-draw-point-halo',
  'cart-draw-point',
  'cart-draw-point-label',
  'cart-draw-vertex-mid',
  'cart-draw-vertex',
  'cart-draw-measure-line',
  'cart-draw-measure-badge',
]);

const AUTO_SETTLEMENT_CONTOUR_LAYER_IDS = Object.freeze([
  'settlement_outline_glow_outer',
  'settlement_outline_glow_inner',
  'settlement_outline_casing',
  'settlement_outline_inline',
  'settlement_point_glow',
  'settlement_point_casing',
  'settlement_point_inline',
  'settlement_supplement_glow_outer',
  'settlement_supplement_glow_inner',
  'settlement_supplement_casing',
  'settlement_supplement_inline',
]);

const MANUAL_SETTLEMENT_CONTOUR_LAYER_IDS = Object.freeze([
  'cart-contour-outline_glow_outer',
  'cart-contour-outline_glow_inner',
  'cart-contour-outline_casing',
  'cart-contour-outline_inline',
  'cart-contour-draft-casing',
  'cart-contour-draft',
  'cart-contour-vertex-mid',
  'cart-contour-vertex',
]);

const SETTLEMENT_CONTOUR_LAYER_IDS = Object.freeze([
  ...AUTO_SETTLEMENT_CONTOUR_LAYER_IDS,
  ...MANUAL_SETTLEMENT_CONTOUR_LAYER_IDS,
]);

function firstExistingLayer(map, ids) {
  if (!map?.getLayer) return null;
  for (const id of ids) {
    try {
      if (map.getLayer(id)) return id;
    } catch {
      return null;
    }
  }
  return null;
}

/** Current style layer-id order, or null while the style is mid-swap. */
function currentLayerOrder(map) {
  try {
    const layers = map?.getStyle?.()?.layers;
    return Array.isArray(layers) ? layers.map((l) => l.id) : null;
  } catch {
    return null;
  }
}

function sameSequence(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Move the existing subset of `ids` to the top of the stack — but ONLY
 * when they aren't already there. `map.moveLayer` dirties the style and
 * emits a fresh `styledata` even when the layer doesn't actually change
 * position; since this helper runs from the engines' styledata-driven
 * `ensureLayers` passes, unconditional moves create an endless
 * styledata → move → styledata feedback loop that keeps the map from
 * ever settling (and wipes out the drawing engine's reinstall window).
 * The no-op guard makes the pass truly idempotent so the loop converges.
 */
function moveExistingLayersToTop(map, ids) {
  if (!map?.getLayer || !map?.moveLayer) return;
  const existing = ids.filter((id) => {
    try { return !!map.getLayer(id); } catch { return false; }
  });
  if (!existing.length) return;
  const order = currentLayerOrder(map);
  if (order && sameSequence(order.slice(-existing.length), existing)) return;
  for (const id of existing) {
    try {
      map.moveLayer(id);
    } catch {
      /* style may be mid-swap; the next styledata/idle pass retries */
    }
  }
}

/**
 * Move the existing subset of `ids` directly before `beforeId`, skipping
 * the moves entirely when they're already in place (same no-op rationale
 * as `moveExistingLayersToTop`).
 */
function moveExistingLayersBefore(map, ids, beforeId) {
  if (!beforeId || !map?.getLayer || !map?.moveLayer) return;
  const existing = ids.filter((id) => {
    try { return id !== beforeId && !!map.getLayer(id); } catch { return false; }
  });
  if (!existing.length) return;
  try {
    if (!map.getLayer(beforeId)) return;
  } catch {
    return;
  }
  const order = currentLayerOrder(map);
  if (order) {
    const anchorIdx = order.indexOf(beforeId);
    if (
      anchorIdx >= existing.length
      && sameSequence(order.slice(anchorIdx - existing.length, anchorIdx), existing)
    ) return;
  }
  for (const id of existing) {
    try {
      map.moveLayer(id, beforeId);
    } catch {
      /* style may be mid-swap; the next styledata/idle pass retries */
    }
  }
}

/**
 * Apply the user-selected draw/settlement-contour z-order.
 *
 * Off/default: keep the drawing engine's normal insertion point and place
 * manual settlement-contour runtime layers below it. On: move automatic
 * and manual settlement-contour layers to the top of the MapLibre stack.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {object} [opts]
 * @param {boolean} [opts.contoursOnTop]
 */
export function applySettlementContourLayerOrder(map, opts = {}) {
  const contoursOnTop =
    typeof opts.contoursOnTop === 'boolean'
      ? opts.contoursOnTop
      : !!map?._cart?.features?.[SETTLEMENT_CONTOURS_TOP_KEY];

  if (contoursOnTop) {
    moveExistingLayersToTop(map, SETTLEMENT_CONTOUR_LAYER_IDS);
    return;
  }

  moveExistingLayersBefore(
    map,
    MANUAL_SETTLEMENT_CONTOUR_LAYER_IDS,
    firstExistingLayer(map, DRAW_LAYER_IDS),
  );
}
