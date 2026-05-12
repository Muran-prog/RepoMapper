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
 * layer. The base curve sets per-zoom opacity (now near-flat — see
 * DEFAULT_STRENGTH_STOPS for the design); strength multiplies it
 * uniformly. Returns a zoom-driven `interpolate` so MapLibre evaluates
 * it per-frame at the current zoom.
 *
 * IMPORTANT: callers that need a numeric value at a specific zoom
 * should use `evaluateStrengthAtZoom` below — that's the JS-side
 * mirror used by tests and by the runtime's "constant push" fallback
 * (`runtime.js::applyHypsoStrengthAtZoom`) which sidesteps any
 * potential renderer-side bug in zoom-driven `color-relief-opacity`
 * evaluation. Both paths emit numerically identical results.
 *
 * @param {number} strength 0..1.5
 * @param {object} [opts]
 * @param {Array<[number, number]>} [opts.baseStops] zoom → opacity stops.
 * @param {number} [opts.ceiling]                    Per-stop opacity ceiling.
 * @returns {Array} MapLibre expression AST.
 */
export function buildStrengthExpression(strength, opts = {}) {
  const baseStops = opts.baseStops ?? DEFAULT_STRENGTH_STOPS;
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : STRENGTH_OPACITY_CEILING;
  const clamped = Math.max(0, Math.min(1.5, Number(strength) || 0));
  const scaled = baseStops.map(([z, v]) => [
    z,
    Number(Math.min(ceiling, Math.max(0, v * clamped)).toFixed(4)),
  ]);
  return ['interpolate', ['linear'], ['zoom'], ...scaled.flat()];
}

/**
 * Pure scalar evaluator for the strength curve at a given zoom. The
 * runtime's zoom-handler uses this to push a CONSTANT opacity to
 * MapLibre whenever the camera moves, which guarantees the result the
 * user sees matches the curve regardless of any quirk in how MapLibre
 * evaluates `color-relief-opacity` zoom expressions. Tests use it to
 * assert determinism across the full zoom range.
 *
 * @param {object} opts
 * @param {number} opts.zoom
 * @param {number} [opts.strength=1]
 * @param {ReadonlyArray<[number, number]>} [opts.baseStops]
 * @param {number} [opts.ceiling]
 * @returns {number}
 */
export function evaluateStrengthAtZoom({
  zoom,
  strength = 1,
  baseStops = DEFAULT_STRENGTH_STOPS,
  ceiling = STRENGTH_OPACITY_CEILING,
}) {
  if (!Array.isArray(baseStops) || baseStops.length === 0) return 0;
  const s = Math.max(0, Math.min(1.5, Number(strength) || 0));
  const stops = baseStops.map(([z, v]) => [
    z,
    Math.min(ceiling, Math.max(0, v * s)),
  ]);
  // Linear interpolation, clamped at the endpoints.
  if (zoom <= stops[0][0]) return Number(stops[0][1].toFixed(4));
  if (zoom >= stops[stops.length - 1][0]) {
    return Number(stops[stops.length - 1][1].toFixed(4));
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    if (zoom >= z0 && zoom <= z1) {
      const t = z1 === z0 ? 0 : (zoom - z0) / (z1 - z0);
      return Number((v0 + (v1 - v0) * t).toFixed(4));
    }
  }
  return Number(stops[stops.length - 1][1].toFixed(4));
}

/**
 * Default per-zoom opacity curve.
 *
 * Design constraint (per user feedback): hypso must read AS THE SAME
 * THING at every zoom — no "disappears at deep zoom" and no "solid
 * wash at z=11" surprises. The previous curve dropped opacity from
 * 0.80 (z=6) to 0.04 (z=17), a 20× swing that the user perceived as
 * a flickering, unstable layer. The new curve is intentionally flat
 * across the operating range:
 *
 *   z=3..6    0.60   (overview wash with hillshade reading through)
 *   z=7..14   0.55   (steady through the regional + city zooms)
 *   z=18      0.50   (gentle taper so building polygons can dominate
 *                     at kerb-level zoom without fighting the tint)
 *
 * The narrow 0.50–0.60 band is heavy enough to read as a colour wash
 * but light enough that the hillshade stack (which sits ABOVE hypso
 * in z-order) always punches through. Hillshade visibility is
 * additionally protected by `HYPSO_HILLSHADE_BLEND` in `terrain.js`,
 * which leaves at least 75 % of base hillshade exaggeration at any
 * zoom — see that comment for the rationale.
 *
 * Strength then multiplies these stops uniformly: at strength=0 the
 * layer is invisible, at strength=1 the curve is as-authored, at
 * strength=1.5 ("Heavy") opacity bumps toward — but never crosses —
 * STRENGTH_OPACITY_CEILING below.
 *
 * @type {ReadonlyArray<[number, number]>}
 */
export const DEFAULT_STRENGTH_STOPS = Object.freeze([
  [3, 0.60],
  [6, 0.60],
  [9, 0.58],
  [11, 0.56],
  [13, 0.55],
  [15, 0.53],
  [18, 0.50],
]);

/**
 * Hard ceiling for the opacity each stop can reach after the strength
 * multiplier is applied. 0.85 leaves at least a 15 % window through
 * which the hillshade layer's per-pixel light/dark contribution still
 * reaches the user — that's what keeps the relief readable at high
 * `Heavy` strength.
 *
 * Lowered from 0.92 → 0.85 in concert with the curve flattening: the
 * old ceiling was only ever hit by the aggressive 0.80 stop × heavy
 * strength, which is exactly the combo that produced the "solid red
 * wash, no relief" symptom the user reported.
 */
export const STRENGTH_OPACITY_CEILING = 0.85;

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
