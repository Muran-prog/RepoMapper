/**
 * Hypso ↔ hillshade shared zoom curves + the tiny linear-interp helper
 * both subsystems evaluate them with.
 *
 * Lives here (rather than in `terrain.js` or `layers.js`) for one
 * reason: it has NO imports of its own. That severs a circular import
 * that would otherwise exist between `terrain.js` (which needs the
 * hypso-blend curve to compose hillshade exaggeration) and
 * `hypso/layers.js` (which historically re-exported the blend curve as
 * `HILLSHADE_BLEND`). Pulling the constant into its own zero-dep file
 * lets both modules import from here without a cycle.
 *
 * No other module should redefine these curves — they're the single
 * source of truth read by the renderer pipeline and by every test
 * that asserts paint values.
 */

/**
 * `HYPSO_HILLSHADE_BLEND` — per-zoom **multiplier** applied to the
 * base hillshade-exaggeration curve when hypso is active at full
 * strength. The intent: when colour-by-elevation dominates the wash,
 * pull hillshade down a hair so the tint stays legible — but never
 * remove it. Values are fractions of base hillshade that SURVIVE
 * when `hypsoStrength === 1`. With `hypsoStrength === 0` no blend
 * applies and hillshade runs at full base strength.
 *
 * The previous (buggy) implementation in `hypso/layers.js` emitted
 * the factor as the ABSOLUTE exaggeration, which made hillshade
 * *stronger* when hypso turned on instead of weaker. The blend lives
 * here now and `terrain.js::evaluateHillshadeExaggeration` does the
 * actual multiplication.
 *
 * Conservative values: never below 0.75. We want hillshade legible
 * even at the heaviest hypso wash; the colour bias should win on hue,
 * not on luminance contrast.
 *
 * @type {ReadonlyArray<[number, number]>}
 */
export const HYPSO_HILLSHADE_BLEND = Object.freeze([
  [3, 0.85],
  [8, 0.90],
  [12, 0.95],
  [16, 1.00],
]);

/**
 * Evaluate a linear zoom interpolation over `[zoom, value]` stops at
 * the given zoom. Mirrors the math MapLibre uses for `interpolate
 * linear zoom` so the test harness and the live renderer agree.
 *
 * Endpoints are clamped (no extrapolation).
 *
 * @param {ReadonlyArray<[number, number]>} stops
 * @param {number} zoom
 * @returns {number}
 */
export function evalLinearStops(stops, zoom) {
  if (!Array.isArray(stops) || stops.length === 0) return 0;
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    if (zoom >= z0 && zoom <= z1) {
      const t = z1 === z0 ? 0 : (zoom - z0) / (z1 - z0);
      return v0 + (v1 - v0) * t;
    }
  }
  return stops[stops.length - 1][1];
}
