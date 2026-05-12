/**
 * Hypsometric ramp → MapLibre paint-expression generator.
 *
 * The renderer can drive a hypsometric tint through three different
 * MapLibre paint properties:
 *
 *   • `color-relief-color`  on a native `color-relief` layer (DEM ramp)
 *   • `raster-color`        on a `raster` layer, when MapLibre supports it
 *   • implicit (PMTiles)    — for the pre-rendered raster fallback, the
 *                             ramp is baked into the PMTiles archive at
 *                             build time and no expression is needed
 *
 * All three paths consume the same ramp dictionary entries (`light` or
 * `dark` stop arrays). This module is the single place that converts
 * stops → expression so the same densification, masking and strength
 * logic applies uniformly.
 *
 * Perceptual uniformity
 * ---------------------
 * MapLibre's `interpolate` blends adjacent stops in linear-RGB. That is
 * not perceptually uniform — bright-to-dark transitions look muddy,
 * complementary hues blend through grey. We densify the authored stops
 * in CIELAB before emitting the expression so the in-shader linear-RGB
 * blends between dense, LAB-interpolated stops are perceptually close
 * to the analytic LAB curve. See `color.js` for the math.
 *
 * Strength
 * --------
 * `strength` is a 0..1.5 multiplier that scales the layer's opacity
 * curve. 1.0 = as-authored, 0.0 = fully transparent, 1.5 = punch above
 * normal. The strength expression is meant to be slammed onto the layer
 * via `setPaintProperty(..., '*-opacity', expr)` — no style rebuild.
 *
 * Bathymetry
 * ----------
 * Stops at negative elevation are kept in the ramp expression — that
 * gives the GPU one ramp from seabed to summit, so there is no possible
 * seam at the coastline. Land-only mask is applied at the LAYER level
 * (filter, not expression) by `layers.js`.
 *
 * @typedef {[number, string]} HypsoStop
 */

import { densifyStopsLab } from './color.js';

/** Default per-gap stop count fed to the LAB densifier. */
export const DEFAULT_DENSIFY = 6;

/**
 * Build the MapLibre `interpolate` expression that maps DEM elevation
 * to colour. The expression is suitable for the `color-relief-color`
 * paint property of a native color-relief layer.
 *
 * @param {ReadonlyArray<HypsoStop>} stops Sorted ascending by elevation.
 * @param {object} [opts]
 * @param {number}  [opts.densify=DEFAULT_DENSIFY] LAB densification gap count.
 * @param {boolean} [opts.bathymetry=true] Keep negative-elevation stops.
 * @returns {Array} MapLibre expression AST.
 */
export function buildColorReliefExpression(stops, opts = {}) {
  const { densify = DEFAULT_DENSIFY, bathymetry = true } = opts;
  const filtered = bathymetry
    ? [...stops]
    : stops.filter(([elev]) => elev >= 0);
  if (filtered.length < 2) {
    // Degenerate ramp — return a single-colour expression that doesn't
    // crash the parser. Caller should have filtered to >= 1 stop.
    const fallbackColor = filtered[0]?.[1] ?? '#000000';
    return ['literal', fallbackColor];
  }
  const dense = densifyStopsLab(filtered, densify);
  const flat = dense.flat();
  return ['interpolate', ['linear'], ['elevation'], ...flat];
}

/**
 * Build the strength-modulated opacity expression for the active hypso
 * layer. The compose-time base curve fades hypso in/out by zoom (low
 * zooms get a fuller tint to convey relief; deep zooms fade out so
 * landuse colours dominate). Strength multiplies the curve uniformly.
 *
 * Returns a zoom-driven `interpolate` so MapLibre stays in expression
 * land. setPaintProperty(layerId, '...-opacity', <this>) is the live
 * update path.
 *
 * @param {number} strength 0..1.5
 * @param {object} [opts]
 * @param {Array<[number, number]>} [opts.baseStops] zoom → opacity stops.
 * @returns {Array} MapLibre expression AST.
 */
export function buildStrengthExpression(strength, opts = {}) {
  const baseStops = opts.baseStops ?? DEFAULT_STRENGTH_STOPS;
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : STRENGTH_OPACITY_CEILING;
  const clamped = Math.max(0, Math.min(1.5, Number(strength) || 0));
  // Clamp every multiplied stop at the ceiling so a high strength
  // can't push the layer into full opacity — hillshade has to stay
  // legible underneath. See STRENGTH_OPACITY_CEILING docblock above.
  const scaled = baseStops.map(([z, v]) => [
    z,
    Number(Math.min(ceiling, v * clamped).toFixed(4)),
  ]);
  return ['interpolate', ['linear'], ['zoom'], ...scaled.flat()];
}

/**
 * Default per-zoom opacity curve.
 *
 * The brief calls for hypso to read as a topographic-atlas wash at
 * overview zooms while letting hillshade re-emerge at regional+ zooms
 * so the user can read both elevation bands AND terrain texture at the
 * city/trail scale. The previous (more aggressive) curve made hypso
 * fully opaque at z=11 — that hid hillshade entirely and turned the
 * Carpathians into a flat orange melt at strength ≥ 1.0.
 *
 * Shape:
 *   z=3..6   tint dominates  (overview — colour wash is what we want)
 *   z=7..9   tint mixes with hillshade
 *   z=10..13 hillshade dominates, tint becomes a colour bias
 *   z=14+   landuse / road / building polygons take over
 *
 * Even at strength=1.5 ("Heavy") the resulting opacity is capped in
 * `buildStrengthExpression` so hillshade is always somewhat visible.
 *
 * @type {ReadonlyArray<[number, number]>}
 */
export const DEFAULT_STRENGTH_STOPS = Object.freeze([
  [3, 0.70],
  [6, 0.80],
  [9, 0.60],
  [11, 0.40],
  [13, 0.25],
  [15, 0.12],
  [17, 0.04],
]);

/**
 * Hard ceiling for the opacity each stop can reach after the strength
 * multiplier is applied. 0.92 leaves a thin (~8 %) window through which
 * the hillshade layer's per-pixel light/dark contribution still reaches
 * the user — that's what keeps the relief readable at high `Heavy`
 * strength. Picked empirically: 0.96 still washed hillshade out on the
 * Carpathian peaks; 0.85 left the tint feeling too faded.
 */
export const STRENGTH_OPACITY_CEILING = 0.92;

/**
 * Build the densified stop list as plain data — useful for legends
 * (consumer wants the colour at every densified elevation) and for
 * regression tests that compare ramps without round-tripping through
 * a MapLibre expression parser.
 *
 * @param {ReadonlyArray<HypsoStop>} stops
 * @param {object} [opts]
 * @param {number}  [opts.densify=DEFAULT_DENSIFY]
 * @param {boolean} [opts.bathymetry=true]
 * @returns {Array<HypsoStop>}
 */
export function buildDensifiedStops(stops, opts = {}) {
  const { densify = DEFAULT_DENSIFY, bathymetry = true } = opts;
  const filtered = bathymetry ? [...stops] : stops.filter(([elev]) => elev >= 0);
  return densifyStopsLab(filtered, densify);
}

/**
 * Render a gdaldem color-relief ramp file from a ramp. Used by
 * tools/build-hypso.sh so the offline raster pipeline consumes the same
 * authoritative stops the live renderer does. Format:
 *
 *   <elevation_m> <R> <G> <B> [<A>]
 *   …
 *   nv 0 0 0 0
 *
 * @param {ReadonlyArray<HypsoStop>} stops
 * @param {object} [opts]
 * @param {number}  [opts.densify=DEFAULT_DENSIFY]
 * @param {boolean} [opts.bathymetry=true]
 * @returns {string} gdaldem-compatible ramp file contents.
 */
export function buildGdaldemRamp(stops, opts = {}) {
  const dense = buildDensifiedStops(stops, opts);
  const lines = dense.map(([elev, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${Math.round(elev)} ${r} ${g} ${b} 255`;
  });
  lines.push('nv 0 0 0 0');
  return lines.join('\n') + '\n';
}
