/**
 * Coordinate grid — a toggleable 1 km reference overlay.
 *
 * The source is intentionally dynamic: a 1 km grid across Ukraine would be
 * thousands of lines and well over a million cell labels if emitted at once.
 * We keep the style source empty at compose time, then populate only the
 * current viewport from interactions.js. Labels are generated only at close
 * zooms where an individual square is readable.
 */

import { UKRAINE_BOUNDS } from '../config.js';

/** Source id for the inline grid GeoJSON. */
export const GRID_SOURCE_ID = 'cart-grid';

/** Layer ids — exported so callers can probe/remove them deterministically. */
export const GRID_LAYERS = Object.freeze({
  casing: 'cart-grid-casing',
  line: 'cart-grid-line',
  cellLabel: 'cart-grid-cell-label',
});

/** One grid square is 1 km × 1 km. */
export const GRID_CELL_SIZE_METERS = 1000;

/** The grid is too dense to be useful below neighbourhood zooms. */
export const GRID_LINE_MIN_ZOOM = 9.5;
export const GRID_LABEL_MIN_ZOOM = 12;

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEG_PER_METER_LAT = 180 / (Math.PI * EARTH_RADIUS_METERS);
const VIEW_PADDING_CELLS = 2;
const MAX_DYNAMIC_LABELS = 2500;

/** Densify long grid edges so they stay smooth under globe/projection changes. */
const SEGMENTS = 12;

/** Column index (0-based) → spreadsheet-style letter (A…Z, AA…). */
export function columnLetter(i) {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function emptyGridGeoJSON() {
  return { type: 'FeatureCollection', features: [] };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function gridMetrics(bounds = UKRAINE_BOUNDS) {
  const [[w, s], [e, n]] = bounds;
  const refLat = (s + n) / 2;
  const stepLat = GRID_CELL_SIZE_METERS * DEG_PER_METER_LAT;
  const stepLon = stepLat / Math.max(0.01, Math.cos(toRad(refLat)));

  return {
    w,
    s,
    e,
    n,
    stepLon,
    stepLat,
    cols: Math.ceil((e - w) / stepLon),
    rows: Math.ceil((n - s) / stepLat),
  };
}

function expandBounds(bounds, metrics) {
  const [[w, s], [e, n]] = bounds;
  return [
    [w - metrics.stepLon * VIEW_PADDING_CELLS, s - metrics.stepLat * VIEW_PADDING_CELLS],
    [e + metrics.stepLon * VIEW_PADDING_CELLS, n + metrics.stepLat * VIEW_PADDING_CELLS],
  ];
}

function intersectBounds(a, b) {
  const [[aw, as], [ae, an]] = a;
  const [[bw, bs], [be, bn]] = b;
  const w = Math.max(aw, bw);
  const s = Math.max(as, bs);
  const e = Math.min(ae, be);
  const n = Math.min(an, bn);
  if (w >= e || s >= n) return null;
  return [[w, s], [e, n]];
}

function queryBoundsFor(viewportBounds, metrics) {
  return intersectBounds(
    expandBounds(viewportBounds, metrics),
    [[metrics.w, metrics.s], [metrics.e, metrics.n]],
  );
}

function lineCoords(lonOrLat, start, end, axis) {
  const coords = [];
  for (let k = 0; k <= SEGMENTS; k += 1) {
    const v = lerp(start, end, k / SEGMENTS);
    coords.push(axis === 'lon' ? [lonOrLat, v] : [v, lonOrLat]);
  }
  return coords;
}

function dynamicRanges(metrics, query) {
  const [[qw, qs], [qe, qn]] = query;
  return {
    colLineStart: clamp(Math.floor((qw - metrics.w) / metrics.stepLon), 0, metrics.cols),
    colLineEnd: clamp(Math.ceil((qe - metrics.w) / metrics.stepLon), 0, metrics.cols),
    rowLineStart: clamp(Math.floor((metrics.n - qn) / metrics.stepLat), 0, metrics.rows),
    rowLineEnd: clamp(Math.ceil((metrics.n - qs) / metrics.stepLat), 0, metrics.rows),
    colCellStart: clamp(Math.floor((qw - metrics.w) / metrics.stepLon), 0, metrics.cols - 1),
    colCellEnd: clamp(Math.floor((qe - metrics.w) / metrics.stepLon), 0, metrics.cols - 1),
    rowCellStart: clamp(Math.floor((metrics.n - qn) / metrics.stepLat), 0, metrics.rows - 1),
    rowCellEnd: clamp(Math.floor((metrics.n - qs) / metrics.stepLat), 0, metrics.rows - 1),
  };
}

function gridSignature(viewportBounds, zoom, fullBounds = UKRAINE_BOUNDS) {
  if (zoom < GRID_LINE_MIN_ZOOM) return 'empty';
  const metrics = gridMetrics(fullBounds);
  const query = queryBoundsFor(viewportBounds, metrics);
  if (!query) return 'outside';
  const r = dynamicRanges(metrics, query);
  return [
    zoom >= GRID_LABEL_MIN_ZOOM ? 'labels' : 'lines',
    r.colLineStart,
    r.colLineEnd,
    r.rowLineStart,
    r.rowLineEnd,
    r.colCellStart,
    r.colCellEnd,
    r.rowCellStart,
    r.rowCellEnd,
  ].join('|');
}

function mapViewportBounds(map) {
  const b = map.getBounds?.();
  if (!b) return UKRAINE_BOUNDS;
  return [
    [b.getWest(), b.getSouth()],
    [b.getEast(), b.getNorth()],
  ];
}

function addCellLabels(features, metrics, query, ranges) {
  const [[qw, qs], [qe, qn]] = query;
  const cols = ranges.colCellEnd - ranges.colCellStart + 1;
  const rows = ranges.rowCellEnd - ranges.rowCellStart + 1;
  if (cols <= 0 || rows <= 0 || cols * rows > MAX_DYNAMIC_LABELS) return;

  for (let j = ranges.rowCellStart; j <= ranges.rowCellEnd; j += 1) {
    const lat = metrics.n - (j + 0.5) * metrics.stepLat;
    if (lat < qs || lat > qn || lat < metrics.s || lat > metrics.n) continue;

    for (let i = ranges.colCellStart; i <= ranges.colCellEnd; i += 1) {
      const lon = metrics.w + (i + 0.5) * metrics.stepLon;
      if (lon < qw || lon > qe || lon < metrics.w || lon > metrics.e) continue;
      features.push({
        type: 'Feature',
        properties: { kind: 'cell', label: `${columnLetter(i)}${j + 1}` },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
    }
  }
}

/**
 * Build the visible 1 km grid as a FeatureCollection:
 *   • `kind:'line'` — meridians/parallels spaced at 1 km
 *   • `kind:'cell'` — close-zoom cell label points only
 *
 * @param {object} [opts]
 * @param {[[number,number],[number,number]]} [opts.bounds] Full grid bounds.
 * @param {[[number,number],[number,number]]} [opts.viewportBounds] Current map viewport.
 * @param {number} [opts.zoom] Current map zoom.
 */
export function buildGridGeoJSON(opts = {}) {
  const zoom = opts.zoom ?? GRID_LINE_MIN_ZOOM;
  if (zoom < GRID_LINE_MIN_ZOOM) return emptyGridGeoJSON();

  const bounds = opts.bounds ?? UKRAINE_BOUNDS;
  const metrics = gridMetrics(bounds);
  const viewportBounds = opts.viewportBounds ?? bounds;
  const query = queryBoundsFor(viewportBounds, metrics);
  if (!query) return emptyGridGeoJSON();

  const [[qw, qs], [qe, qn]] = query;
  const ranges = dynamicRanges(metrics, query);
  const features = [];

  // Vertical lines (north/south) at every 1 km column boundary.
  for (let i = ranges.colLineStart; i <= ranges.colLineEnd; i += 1) {
    const lon = metrics.w + i * metrics.stepLon;
    if (lon < metrics.w || lon > metrics.e) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: lineCoords(lon, qs, qn, 'lon') },
    });
  }

  // Horizontal lines (west/east) at every 1 km row boundary.
  for (let j = ranges.rowLineStart; j <= ranges.rowLineEnd; j += 1) {
    const lat = metrics.n - j * metrics.stepLat;
    if (lat < metrics.s || lat > metrics.n) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: lineCoords(lat, qw, qe, 'lat') },
    });
  }

  if (zoom >= GRID_LABEL_MIN_ZOOM) {
    addCellLabels(features, metrics, query, ranges);
  }

  return { type: 'FeatureCollection', features };
}

/** Inline-GeoJSON source spec for the dynamic grid. */
export function gridSourceSpec() {
  return { type: 'geojson', data: emptyGridGeoJSON() };
}

/** Update the live grid source with the current viewport slice. */
export function syncGridSource(map) {
  if (!map || typeof map.getSource !== 'function') return;

  let source;
  try {
    source = map.getSource(GRID_SOURCE_ID);
  } catch {
    return;
  }

  const cart = map._cart ?? {};
  if (!source || typeof source.setData !== 'function') {
    cart.gridSourceRef = null;
    cart.gridSig = '';
    if (map._cart) map._cart = cart;
    return;
  }

  if (cart.gridSourceRef !== source) {
    cart.gridSourceRef = source;
    cart.gridSig = '';
  }

  const zoom = map.getZoom?.() ?? 0;
  const viewportBounds = mapViewportBounds(map);
  const sig = gridSignature(viewportBounds, zoom);
  if (cart.gridSig === sig) return;

  cart.gridSig = sig;
  source.setData(buildGridGeoJSON({ viewportBounds, zoom }));
  if (map._cart) map._cart = cart;
}

/**
 * Grid layer stack — casing → line → cell labels.
 * White lines on a dark blurred casing read on any basemap; labels appear
 * only once individual 1 km cells have enough screen space.
 *
 * @param {object} t  theme tokens (for the font stack)
 * @param {object} [opts]
 * @param {string} [opts.source]
 */
export function gridLayers(t, opts = {}) {
  const source = opts.source ?? GRID_SOURCE_ID;
  const lineFilter = ['==', ['get', 'kind'], 'line'];

  return [
    // Dark, soft backing so bright lines never vanish on light paper.
    {
      id: GRID_LAYERS.casing,
      type: 'line',
      source,
      filter: lineFilter,
      minzoom: GRID_LINE_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#0b1018',
        'line-opacity': 0.58,
        'line-blur': 0.7,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          9.5, 4.6, 11, 7.4, 14, 11, 17, 14,
        ],
      },
    },
    // Bright white core — the visible grid line.
    {
      id: GRID_LAYERS.line,
      type: 'line',
      source,
      filter: lineFilter,
      minzoom: GRID_LINE_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': 0.94,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          9.5, 1.8, 11, 3, 14, 4.6, 17, 5.8,
        ],
      },
    },
    // Per-cell designation ("AB123"), generated only near the viewport.
    {
      id: GRID_LAYERS.cellLabel,
      type: 'symbol',
      source,
      filter: ['==', ['get', 'kind'], 'cell'],
      minzoom: GRID_LABEL_MIN_ZOOM,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': t.font.bold,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          12, 12, 14, 16, 17, 22,
        ],
      },
      paint: {
        'text-color': '#ffffff',
        'text-opacity': 0.94,
        'text-halo-color': '#0b1018',
        'text-halo-width': 1.8,
        'text-halo-blur': 0.4,
      },
    },
  ];
}
