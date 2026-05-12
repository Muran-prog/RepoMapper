/**
 * Tiny helpers for building MapLibre `interpolate` / `step` expressions.
 *
 * Style files compose their zoom-driven width and opacity curves out of
 * primitive `[zoom, value]` stops; this module turns those stops into
 * proper expression AST nodes. Keeping the helpers here means the style
 * files read like data, not like AST plumbing.
 */

/**
 * Exponential zoom interpolation. Suits line-widths and circle radii where
 * we want gentle scaling at low zooms and aggressive growth at high ones.
 *
 * @param {Array<[number, number]>} stops Pairs of [zoom, value].
 * @param {number} [base=1.4] Exponential base. >1 favours high zooms.
 */
export const expZoom = (stops, base = 1.4) => [
  'interpolate',
  ['exponential', base],
  ['zoom'],
  ...stops.flat(),
];

/**
 * Linear zoom interpolation — preferred for opacity, text-size, dasharrays.
 */
export const linZoom = (stops) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...stops.flat(),
];

/**
 * Step expression, evaluated at integer zoom boundaries. Useful for layout
 * properties (which only re-evaluate at integer zooms anyway) and for
 * dash arrays where smooth interpolation creates the well-known "swimming
 * dashes" artifact (see maplibre-gl-js#4583).
 */
export const stepZoom = (defaultValue, stops) => [
  'step',
  ['zoom'],
  defaultValue,
  ...stops.flat(),
];

/**
 * `case` expression sugar. Pairs of [test, value], terminated by a default.
 *
 *   matchCase([
 *     [['==', ['get', 'class'], 'motorway'], 'red'],
 *     [['==', ['get', 'class'], 'trunk'],    'orange'],
 *   ], 'gray')
 */
export const matchCase = (pairs, fallback) => [
  'case',
  ...pairs.flatMap(([test, value]) => [test, value]),
  fallback,
];

/**
 * Convenience: an `["in", ["get", key], ["literal", values]]` filter.
 * Replaces the deprecated `["in", key, ...values]` short form.
 */
export const inFilter = (key, values) => [
  'in',
  ['get', key],
  ['literal', values],
];

/**
 * Zoom-driven width for a casing — slightly thicker than its inline.
 */
export const casingWidth = (innerStops, extraPx = 2, base = 1.4) =>
  expZoom(
    innerStops.map(([z, w]) => [z, w === 0 ? 0 : w + extraPx]),
    base,
  );
