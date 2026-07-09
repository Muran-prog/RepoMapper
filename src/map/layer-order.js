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

function moveExistingLayersToTop(map, ids) {
  if (!map?.getLayer || !map?.moveLayer) return;
  for (const id of ids) {
    try {
      if (map.getLayer(id)) map.moveLayer(id);
    } catch {
      /* style may be mid-swap; the next styledata/idle pass retries */
    }
  }
}

function moveExistingLayersBefore(map, ids, beforeId) {
  if (!beforeId || !map?.getLayer || !map?.moveLayer) return;
  for (const id of ids) {
    try {
      if (id !== beforeId && map.getLayer(id) && map.getLayer(beforeId)) {
        map.moveLayer(id, beforeId);
      }
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
