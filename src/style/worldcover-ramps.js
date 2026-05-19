/**
 * ESA WorldCover landcover-tint ramps.
 *
 * The WorldCover product (ESA + VITO, 10 m global, 2021 v200) maps every
 * pixel to one of eleven canonical surface classes. We re-paint that
 * raster as a multiply-blend overlay so vector landuse polygons get
 * supplemented by the actual satellite-classified surface — coniferous
 * forest reads darker than deciduous, polonyna grass glows yellow-green,
 * cropland mosaic reads as a warm beige wash, built-up villages contrast
 * as a neutral pink-grey, scree and rock terraces get a warm sand tone.
 *
 * Design rules
 * ------------
 *   • Every colour is *low-saturation*. The overlay is applied at
 *     opacity ~0.3 with a multiply-style blend (raster-saturation: -0.15
 *     in `composeWorldcoverLayer`); strong tints would punch through and
 *     dominate the underlying hillshade + landuse polygons.
 *   • Water (value=80) is fully transparent. The vector water_polygon
 *     layer sits ABOVE this raster in Z-order, but a transparent stop
 *     means the raster also doesn't tint coastline approximations or
 *     small lakes that the upstream OMT water layer happens to have
 *     classified differently.
 *   • Light + dark themes share the SAME hue family. Dark variants pull
 *     L* down ~15-20 % so the overlay stays readable against the deeper
 *     slate canvas without re-tinting.
 *   • This file is pure data — no expressions, no zoom lookups, no
 *     MapLibre AST. The renderer in `terrain.js` and the offline
 *     pipeline in `tools/dump-worldcover-ramp.mjs` both read these
 *     dictionaries directly.
 *
 * ESA WorldCover class table (pixel value → class):
 *
 *    10  Tree cover
 *    20  Shrubland
 *    30  Grassland
 *    40  Cropland
 *    50  Built-up
 *    60  Bare / sparse vegetation
 *    70  Snow and ice
 *    80  Permanent water bodies      (TRANSPARENT — vector water wins)
 *    90  Herbaceous wetland
 *    95  Mangroves                   (Ukraine never sees these — kept for
 *                                     compatibility with the 11-class
 *                                     reference matrix)
 *   100  Moss and lichen
 *
 * @typedef {Readonly<Record<number, string>>} WorldcoverRamp
 */

/* eslint-disable max-len */

/**
 * Built-in landcover ramps. Frozen at module-init so consumers can rely
 * on identity for memoisation. Class-80 (water) is `'transparent'` —
 * the gdaldem dump tool turns that into an `R G B A = 0 0 0 0` row, the
 * raster paint just lets the underlying hypso / hillshade show through.
 *
 * @type {Readonly<{ light: WorldcoverRamp, dark: WorldcoverRamp }>}
 */
export const WORLDCOVER_RAMPS = Object.freeze({
  light: Object.freeze({
    10: '#3a5c3c',  // Tree cover — cool conifer green, low saturation
    20: '#a8b262',  // Shrubland — yellow-olive, slightly warmer than tree
    30: '#c8c772',  // Grassland — light yellow-green for polonyna
    40: '#d4c290',  // Cropland — warm beige-green for Закарпатська lowland
    50: '#b8a2a2',  // Built-up — neutral grey-pink
    60: '#c2b294',  // Bare/sparse — warm sand for скельні поясочки
    70: '#eaeef2',  // Snow/ice — near-white with cool tint
    80: 'transparent', // Water — never tint (vector water_polygon wins)
    90: '#7a9a8a',  // Wetland — muted blue-green
    95: '#3a5c3c',  // Mangroves — same as tree cover for compatibility
    100: '#a8a896', // Moss/lichen — greenish-grey
  }),
  dark: Object.freeze({
    10: '#1f3320',  // Tree cover — deep conifer green
    20: '#5e6638',  // Shrubland — dim olive
    30: '#7a7a44',  // Grassland — muted yellow-green
    40: '#82724e',  // Cropland — dim beige-green
    50: '#6e5a5c',  // Built-up — desaturated mauve-grey
    60: '#6e5e48',  // Bare/sparse — dim warm sand
    70: '#9aa2ac',  // Snow/ice — cool light grey
    80: 'transparent', // Water
    90: '#3e5648',  // Wetland — dim blue-green
    95: '#1f3320',  // Mangroves — same as tree cover
    100: '#5e5e50', // Moss/lichen — dim greenish-grey
  }),
});

/**
 * Per-state opacity ceilings consumed by `composeWorldcoverLayer`. The
 * default curve peaks at ~0.32 in the mid-zoom band; when hypso is
 * active the curve is rescaled to peak at `hypsoActive` so the elevation
 * tint stays the dominant colour signal.
 */
export const WORLDCOVER_OPACITY = Object.freeze({
  default: 0.3,
  hypsoActive: 0.18,
});

/**
 * Stable, ordered list of canonical class values. The order doubles as
 * the iteration order for the offline gdaldem ramp emitter so every
 * build is byte-stable even when the underlying object key order
 * changes between Node versions.
 */
export const WORLDCOVER_CLASSES = Object.freeze([
  10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100,
]);

/**
 * Human-readable class names. Exposed for legend rendering and the
 * README; not consumed by the renderer.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WORLDCOVER_CLASS_NAMES = Object.freeze({
  10: 'Tree cover',
  20: 'Shrubland',
  30: 'Grassland',
  40: 'Cropland',
  50: 'Built-up',
  60: 'Bare / sparse vegetation',
  70: 'Snow and ice',
  80: 'Permanent water',
  90: 'Herbaceous wetland',
  95: 'Mangroves',
  100: 'Moss and lichen',
});

/**
 * Resolve the active ramp object for a (theme) pair. Returns the frozen
 * dictionary directly — DO NOT mutate.
 *
 * @param {'light'|'dark'} theme
 * @returns {WorldcoverRamp}
 */
export function getWorldcoverRamp(theme) {
  return theme === 'dark' ? WORLDCOVER_RAMPS.dark : WORLDCOVER_RAMPS.light;
}

/**
 * Parse a `#rrggbb` (or `transparent`) string into an `[r, g, b, a]`
 * tuple. Used by `tools/dump-worldcover-ramp.mjs` and any test that
 * needs to compare colour values byte-for-byte. Returns `null` on
 * malformed input rather than throwing — the offline pipeline already
 * has its own complaint chain.
 *
 * @param {string} hex
 * @returns {[number, number, number, number]|null}
 */
export function hexToRgba(hex) {
  if (typeof hex !== 'string') return null;
  if (hex === 'transparent') return [0, 0, 0, 0];
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255];
}
