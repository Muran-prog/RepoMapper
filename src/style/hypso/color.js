/**
 * Perceptually-uniform colour conversion in CIELAB.
 *
 * Two ramps that look "close enough" in sRGB hex usually drift apart
 * when MapLibre or gdaldem interpolates between them — high-saturation
 * blends through muddy greys, low-luminance gaps look like cliffs.
 * CIELAB is the standard perceptually-uniform working space: equal
 * Euclidean distances correspond to roughly equal perceptual differences.
 *
 * This module is dependency-free and small on purpose: the brief calls
 * for ≤ 50 LOC, no npm packages. It exposes:
 *
 *   hexToLab(hex)             '#rrggbb' → [L, a, b]
 *   labToHex([L, a, b])       inverse, gamut-clamped to sRGB.
 *   lerpHexLab(a, b, t)       perceptually-uniform interpolation.
 *   densifyStopsLab(stops, n) Insert n LAB-interpolated stops between
 *                             every consecutive pair of input stops.
 *
 * The densifier is what binds CIELAB into the rendering pipeline: we
 * feed MapLibre / gdaldem a denser ramp so their built-in linear-RGB
 * interpolation between adjacent stops matches the perceptual curve
 * we'd compute analytically.
 *
 * D65 reference white. Reverse formulae avoid Math.pow(x, 1/3) for the
 * inverse — we use the inverse of the piecewise f(t) directly.
 *
 * @typedef {[number, number, number]} Lab
 * @typedef {[number, string]} HypsoStop
 */

const REF_X = 0.95047;
const REF_Y = 1.00000;
const REF_Z = 1.08883;
const EPS = 0.008856;
const KAPPA = 903.3;

const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const finv = (t) => {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (t - 16 / 116) / 7.787;
};
const c2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2c = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (c) => Math.max(0, Math.min(255, Math.round(c * 255)));
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2hex = ([r, g, b]) => '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');

/** @param {string} hex @returns {Lab} */
export function hexToLab(hex) {
  const [r, g, b] = hex2rgb(hex);
  const [R, G, B] = [c2l(r / 255), c2l(g / 255), c2l(b / 255)];
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / REF_X;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / REF_Y;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / REF_Z;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** @param {Lab} lab @returns {string} */
export function labToHex([L, a, b]) {
  const fy = (L + 16) / 116;
  const X = finv(a / 500 + fy) * REF_X;
  const Y = finv(fy) * REF_Y;
  const Z = finv(fy - b / 200) * REF_Z;
  const R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
  const B = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  return rgb2hex([clamp01(l2c(R)), clamp01(l2c(G)), clamp01(l2c(B))]);
}

/** Perceptually-uniform LAB interpolation of two sRGB hex colours. */
export function lerpHexLab(a, b, t) {
  const A = hexToLab(a);
  const B = hexToLab(b);
  return labToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/**
 * High-contrast LAB boost. Stretches every stop's lightness around the
 * ramp's midpoint by `factor`, keeping (a, b) intact so hues read the
 * same way. Used by the "High contrast" picker toggle, and triggered
 * automatically when `prefers-contrast: more` is set at the OS.
 *
 * @param {ReadonlyArray<HypsoStop>} stops
 * @param {number} [factor=1.45] Lightness multiplier around the mid-L.
 * @returns {Array<HypsoStop>}
 */
export function contrastBoostStops(stops, factor = 1.45) {
  if (!Array.isArray(stops) || stops.length === 0) return [];
  const labs = stops.map(([e, hex]) => [e, hexToLab(hex)]);
  const ls = labs.map(([, lab]) => lab[0]);
  const midL = (Math.min(...ls) + Math.max(...ls)) / 2;
  return labs.map(([e, [L, a, b]]) => {
    const newL = Math.max(0, Math.min(100, midL + (L - midL) * factor));
    return [e, labToHex([newL, a, b])];
  });
}

/**
 * Insert `n` LAB-interpolated stops between every consecutive pair of
 * input stops. The endpoints are preserved verbatim — this keeps the
 * authored colours identifiable in the legend.
 *
 * @param {ReadonlyArray<HypsoStop>} stops Sorted asc by elevation.
 * @param {number} [n=6] Number of in-between stops per gap.
 * @returns {Array<HypsoStop>}
 */
export function densifyStopsLab(stops, n = 6) {
  if (!Array.isArray(stops) || stops.length < 2 || n < 1) return [...(stops ?? [])];
  const out = [stops[0]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [e0, c0] = stops[i];
    const [e1, c1] = stops[i + 1];
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([e0 + (e1 - e0) * t, lerpHexLab(c0, c1, t)]);
    }
    out.push(stops[i + 1]);
  }
  return out;
}
