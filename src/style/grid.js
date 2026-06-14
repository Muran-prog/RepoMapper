/**
 * Game-style coordinate grid — a toggleable "battleship" overlay.
 *
 * Draws a crisp lettered/numbered reference grid over the Ukrainian
 * extent, exactly like the tactical map grids in games (PUBG, DayZ):
 * columns are letters (A, B, C, …) running west→east, rows are numbers
 * (1, 2, 3, …) running north→south, so every cell has a battleship-style
 * designation — "A1" top-left, "B7", "J3", etc.
 *
 * It's a pure-geometry overlay computed from constants (no network, no
 * tiles), surfaced through a single inline-GeoJSON source so it survives
 * every `setStyle` rebuild like any other style feature. Gated by the
 * `grid` feature flag + the source's presence in composeLayers.
 *
 * Visibility is the whole point ("очень хорошо видно"): bright white
 * lines ride on a dark blurred casing so they read on any basemap
 * (light Cart paper OR dark satellite imagery), and the labels carry a
 * strong dark halo. Amber edge headers (letters along the top, numbers
 * down the left) frame the grid like the in-game reference.
 *
 * The grid is anchored to the world, not the screen — it pans and zooms
 * with the map, so a cell always covers the same ground. Labels use
 * allow-overlap/ignore-placement so they never get culled by collision.
 */

import { UKRAINE_BOUNDS } from '../config.js';

/** Source id for the inline grid GeoJSON. */
export const GRID_SOURCE_ID = 'cart-grid';

/** Layer ids — exported so callers can probe/remove them deterministically. */
export const GRID_LAYERS = Object.freeze({
  casing: 'cart-grid-casing',
  line: 'cart-grid-line',
  cellLabel: 'cart-grid-cell-label',
  edgeLabel: 'cart-grid-edge-label',
});

/**
 * Grid resolution. 10 columns × 7 rows yields cells that read close to
 * square on screen at the country overview (Web Mercator stretches
 * latitude by ~sec(48°)≈1.5, so a wider lon step balances a taller lat
 * step), and keeps the A–J / 1–7 labels uncluttered.
 */
const COLS = 10;
const ROWS = 7;

/** Densify long grid edges so they stay pin-straight under reprojection. */
const SEGMENTS = 24;

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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Build the grid as a single FeatureCollection:
 *   • `kind:'line'`  — every meridian + parallel of the grid (densified)
 *   • `kind:'cell'`  — one label point per cell at its centre ("B7")
 *   • `kind:'edge'`  — header letters along the top, numbers down the left
 *
 * @param {object} [opts]
 * @param {[[number,number],[number,number]]} [opts.bounds] [[w,s],[e,n]]
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 */
export function buildGridGeoJSON(opts = {}) {
  const bounds = opts.bounds ?? UKRAINE_BOUNDS;
  const cols = opts.cols ?? COLS;
  const rows = opts.rows ?? ROWS;

  const [[w, s], [e, n]] = bounds;
  const stepLon = (e - w) / cols;
  const stepLat = (n - s) / rows;
  const features = [];

  // Vertical lines (meridians) at every column boundary.
  for (let i = 0; i <= cols; i += 1) {
    const lon = w + i * stepLon;
    const coords = [];
    for (let k = 0; k <= SEGMENTS; k += 1) {
      coords.push([lon, lerp(s, n, k / SEGMENTS)]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  // Horizontal lines (parallels) at every row boundary.
  for (let j = 0; j <= rows; j += 1) {
    const lat = s + j * stepLat;
    const coords = [];
    for (let k = 0; k <= SEGMENTS; k += 1) {
      coords.push([lerp(w, e, k / SEGMENTS), lat]);
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  // Per-cell centre labels — the battleship designation "<letter><row>".
  // Row 1 sits at the NORTH edge (top), so we count rows down from `n`.
  for (let j = 0; j < rows; j += 1) {
    const latCenter = n - (j + 0.5) * stepLat;
    for (let i = 0; i < cols; i += 1) {
      const lonCenter = w + (i + 0.5) * stepLon;
      features.push({
        type: 'Feature',
        properties: { kind: 'cell', label: `${columnLetter(i)}${j + 1}` },
        geometry: { type: 'Point', coordinates: [lonCenter, latCenter] },
      });
    }
  }

  // Edge headers — letters along the top, numbers down the left, inset a
  // touch so they sit just inside the frame rather than straddling it.
  const insetLat = stepLat * 0.16;
  const insetLon = stepLon * 0.16;
  for (let i = 0; i < cols; i += 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'edge', label: columnLetter(i) },
      geometry: {
        type: 'Point',
        coordinates: [w + (i + 0.5) * stepLon, n - insetLat],
      },
    });
  }
  for (let j = 0; j < rows; j += 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'edge', label: `${j + 1}` },
      geometry: {
        type: 'Point',
        coordinates: [w + insetLon, n - (j + 0.5) * stepLat],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/** Inline-GeoJSON source spec for the grid. */
export function gridSourceSpec(opts = {}) {
  return { type: 'geojson', data: buildGridGeoJSON(opts) };
}

/**
 * Grid layer stack — casing → line → cell labels → edge headers.
 * White lines on a dark blurred casing read on any basemap; labels
 * carry a strong halo and never collide-cull.
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
      minzoom: 0,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#0b1018',
        'line-opacity': 0.5,
        'line-blur': 0.6,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          3, 2.2, 7, 3.6, 11, 5.5, 15, 7,
        ],
      },
    },
    // Bright white core — the visible grid line.
    {
      id: GRID_LAYERS.line,
      type: 'line',
      source,
      filter: lineFilter,
      minzoom: 0,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': 0.85,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          3, 0.7, 7, 1.3, 11, 2, 15, 2.6,
        ],
      },
    },
    // Per-cell battleship designation ("B7"), always visible.
    {
      id: GRID_LAYERS.cellLabel,
      type: 'symbol',
      source,
      filter: ['==', ['get', 'kind'], 'cell'],
      minzoom: 0,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': t.font.bold,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          4, 11, 6, 14, 9, 19, 12, 26, 15, 32,
        ],
      },
      paint: {
        'text-color': '#ffffff',
        'text-opacity': 0.92,
        'text-halo-color': '#0b1018',
        'text-halo-width': 1.7,
        'text-halo-blur': 0.4,
      },
    },
    // Amber header letters/numbers framing the grid edges.
    {
      id: GRID_LAYERS.edgeLabel,
      type: 'symbol',
      source,
      filter: ['==', ['get', 'kind'], 'edge'],
      minzoom: 0,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': t.font.bold,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          4, 13, 7, 18, 10, 26, 13, 34,
        ],
      },
      paint: {
        'text-color': '#ffd54a',
        'text-halo-color': '#1b1402',
        'text-halo-width': 2,
        'text-halo-blur': 0.3,
      },
    },
  ];
}
