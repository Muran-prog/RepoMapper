/**
 * Contour lines (topographic isolines).
 *
 * Two rendering paths share this module's layer factories:
 *
 *   1. DYNAMIC — maplibre-contour (onthegomap/maplibre-contour) generates
 *      vector contours from the raster-DEM inside a Web Worker. The
 *      worker is registered by `src/map/createMap.js` and exposes a
 *      synthetic source id (see CONTOURS.dynamicSourceId below) whose
 *      tiles carry two source-layers: `contours` (lines) and
 *      `contour-text` (points, supplied by the library for labelling).
 *
 *   2. STATIC  — a pre-rendered PMTiles archive (tools/build-contours.sh)
 *      configured via CONTOURS.staticPmtilesUrl. Same source-layer names
 *      are assumed so the same layer specs render either path.
 *
 * The only style-level difference is the `source` id the layers point at,
 * which is why the factories take that id as input.
 *
 * Zoom-adaptive thresholds
 * ------------------------
 * For the DYNAMIC path the actual elevation intervals are decided by the
 * worker at runtime from CONTOURS.thresholdsByZoom; this file deals only
 * with how lines and labels LOOK, not with which ones exist.
 */

import { expZoom, linZoom } from '../utils/interp.js';

/**
 * Source-layer emitted by maplibre-contour on every generated tile.
 * Labels share the same layer — we just render them as a symbol layer
 * reading the line geometry with symbol-placement: line.
 *
 * Static archives built via tools/build-contours.sh use the same names
 * so the label/line layer specs below are portable between modes.
 */
const CONTOURS_SOURCE_LAYER = 'contours';

/**
 * Property emitted by maplibre-contour on each contour feature — 1 for
 * major isolines, 0 for minor. The worker's default `levels` option
 * decides which numeric intervals go where. Static archives built via
 * tools/build-contours.sh emit the same property name.
 */
const LEVEL_PROP = 'level';

/**
 * @typedef {object} ContourOpts
 * @property {string}  sourceId     Source id (dynamic or static).
 * @property {boolean} [labels=true] Emit the contour-label layer.
 * @property {number}  [minzoom=9]  Sync with CONTOURS.minzoom.
 */

/**
 * @param {object} t
 * @param {ContourOpts} opts
 * @returns {Array<object>}
 */
export function contourLayers(t, opts) {
  const { sourceId, labels = true, minzoom = 9 } = opts;

  const minor = {
    id: 'contour_minor',
    type: 'line',
    source: sourceId,
    'source-layer': CONTOURS_SOURCE_LAYER,
    minzoom,
    filter: ['!=', ['get', LEVEL_PROP], 1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.contourMinor,
      'line-width': expZoom([
        [9, 0.3],
        [12, 0.55],
        [16, 0.9],
        [20, 1.2],
      ]),
      'line-opacity': linZoom([
        [9, 0.0],
        [10, 0.45],
        [14, 0.8],
      ]),
    },
  };

  const major = {
    id: 'contour_major',
    type: 'line',
    source: sourceId,
    'source-layer': CONTOURS_SOURCE_LAYER,
    minzoom,
    filter: ['==', ['get', LEVEL_PROP], 1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.contourMajor,
      'line-width': expZoom([
        [9, 0.5],
        [12, 0.9],
        [16, 1.5],
        [20, 2.2],
      ]),
      'line-opacity': linZoom([
        [9, 0.0],
        [10, 0.6],
        [14, 0.95],
      ]),
    },
  };

  const out = [minor, major];
  if (!labels) return out;

  /**
   * Labels read from the same contour geometry. `symbol-placement: line`
   * repeats the elevation text along the isoline, and `text-max-angle`
   * kills placements where the line curves too tight to be legible. We
   * format with the Ukrainian ' м' suffix. Only major contours get
   * labelled to avoid turning the canvas into a digit salad.
   */
  const labelLayer = {
    id: 'contour_label',
    type: 'symbol',
    source: sourceId,
    'source-layer': CONTOURS_SOURCE_LAYER,
    minzoom: Math.max(minzoom, 11),
    filter: ['==', ['get', LEVEL_PROP], 1],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 200,
      'text-field': ['concat', ['to-string', ['get', 'ele']], ' м'],
      'text-font': t.font.regular,
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 16, 11, 20, 13],
      'text-max-angle': 25,
      'text-padding': 3,
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'viewport',
      'text-letter-spacing': 0.02,
    },
    paint: {
      'text-color': t.contourLabel,
      'text-halo-color': t.contourLabelHalo,
      'text-halo-width': 1.2,
      'text-halo-blur': 0.3,
    },
  };
  out.push(labelLayer);
  return out;
}

// Export source-layer name so createMap.js / the worker registration can
// match it without string drift.
export { CONTOURS_SOURCE_LAYER, LEVEL_PROP };
