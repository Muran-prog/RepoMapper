/**
 * ETH Global Canopy Height ramps — Lang et al. 2023.
 *
 * Source: Lang, N., Jetz, W., Schindler, K., Wegner, J. D. — "A
 * high-resolution canopy height model of the Earth", Nature Ecology
 * & Evolution (2023). 10 m global float32 raster of canopy top
 * height in metres, 0 = no canopy / non-forest, ~50 m = old-growth
 * reference plots. License: CC BY 4.0.
 *
 * Why a height ramp on top of a binary tree-cover class?
 * ------------------------------------------------------
 * The ESA WorldCover layer paints every "tree cover" pixel with one
 * flat green hue regardless of stand age — молоді посадки після
 * рубок Гошку/Сколівщини, ровный 30-ти річний підріст і старі
 * смерекові смуги Чорногори all read the same. Lang et al.'s
 * canopy-height raster gives us a per-pixel age proxy: stack a
 * height-driven ramp ABOVE the WorldCover tree-cover wash and
 * mature stands darken into emerald while clearfells stay a light
 * grass-green. The two layers together produce the cartographic
 * "forest with depth" feel the project's brief asks for.
 *
 * Design rules
 * ------------
 *   • Stop schema is `[height_m, '#rrggbb', alpha_0_255]` — alpha
 *     is baked INTO the stop because the lowest stop must be
 *     fully transparent (height = 0 means no canopy, and the
 *     overlay must NEVER tint a meadow / village / road / lake).
 *     The offline pipeline emits the alpha straight into the
 *     gdaldem table; the live MapLibre raster source uses the
 *     same pre-rendered tiles, so the alpha makes it onto the GPU
 *     without any per-frame expression work.
 *   • Colours go from a warm, low-saturation grass-green at the
 *     bottom (light shrub / young growth) to a cool emerald near
 *     the top (mature смерекові ліси). Multiply-blend friendly:
 *     no high-saturation hue would survive the +1×0.45 opacity
 *     ceiling under the WorldCover wash anyway.
 *   • Light ↔ dark variants share the SAME hue family; dark
 *     variants pull L* down ~25 % so the multiply-blend doesn't
 *     re-saturate against the deep slate canvas. Alpha values are
 *     preserved across themes — they encode "how much canopy is
 *     here", not "how dark the theme is".
 *   • This file is pure data — no expressions, no zoom lookups,
 *     no MapLibre AST. Both the renderer (via tokens.js) and the
 *     offline build pipeline (via tools/dump-canopy-ramp.mjs)
 *     read these dictionaries directly.
 *
 * @typedef {[number, string, number]} CanopyStop
 *   Tuple of `[height_m, hex_colour, alpha_0_255]`.
 * @typedef {ReadonlyArray<CanopyStop>} CanopyRamp
 */

/**
 * Built-in canopy-height ramps. Frozen at module init so consumers
 * can rely on object identity for memoisation. The first stop
 * (height = 0) carries alpha = 0 — pixels with NO canopy stay
 * fully transparent so this overlay can NEVER tint a meadow,
 * village, road, polonyna or water surface. The brief's "пиксели
 * value=0 не должны накладывать зелёный оттенок" requirement
 * is enforced here at the data layer.
 *
 * @type {Readonly<{ light: CanopyRamp, dark: CanopyRamp }>}
 */
export const CANOPY_RAMPS = Object.freeze({
  light: Object.freeze([
    [0,  '#000000',   0], // no canopy / non-forest — fully transparent
    [1,  '#7ea060',  60], // молода поросль / кущі
    [5,  '#5e8540', 120], // середній підріст
    [15, '#3d6b32', 170], // зрілий ліс
    [30, '#2a4f24', 210], // старовозрастний — Чорногора
    [50, '#1a3618', 230], // еталонні старі смерекові смуги
  ]),
  // Dark variants — same hue family, L* pulled ~25 % down so the
  // multiply-blend doesn't crush the canvas. Alpha values match
  // the light variant exactly because alpha encodes canopy density,
  // not theme luminance.
  dark: Object.freeze([
    [0,  '#000000',   0],
    [1,  '#5e7848',  60],
    [5,  '#466330', 120],
    [15, '#2d5025', 170],
    [30, '#1f3b1b', 210],
    [50, '#132812', 230],
  ]),
});

/**
 * Per-state opacity ceilings consumed by `composeCanopyHeightLayer`.
 *
 *   • `default` — canopy is the only forest-detail layer on the
 *     stack. The mid-zoom curve in `composeCanopyHeightLayer`
 *     peaks here.
 *   • `hypsoActive` — hypsometric tint owns the dominant colour
 *     signal; canopy is dampened so the elevation tint reads
 *     through without the green wash overpowering it.
 *   • `worldcoverActive` — the WorldCover tree-cover layer is
 *     ALSO on. Canopy nudges UP because WorldCover provides a
 *     flat green underlay, and the "texture of age" we get from
 *     the canopy-height ramp benefits from a slightly stronger
 *     wash to differentiate stand ages on top of that flat tone.
 *
 * When both hypso and WorldCover are on we take the MIN of the
 * two multipliers (= more conservative): hypso suppression wins
 * over WorldCover reinforcement so the elevation tint stays the
 * dominant cue.
 */
export const CANOPY_OPACITY = Object.freeze({
  default: 0.45,
  hypsoActive: 0.30,
  worldcoverActive: 0.55,
});

/**
 * The ESA WorldCover class value that maps to "tree cover". Exposed
 * for documentation / potential future integration where we might
 * want to mask the canopy-height layer to that class only — today
 * the height ramp's transparent value-0 stop already does that
 * masking implicitly (every non-tree pixel reads ~0 m height).
 */
export const CANOPY_TREE_VALUE = 10;

/**
 * Resolve the active ramp for a theme. Returns the frozen ramp
 * directly — DO NOT mutate. Falls back to light on unknown themes
 * so a typo never crashes the renderer.
 *
 * @param {'light'|'dark'} theme
 * @returns {CanopyRamp}
 */
export function getCanopyRamp(theme) {
  return theme === 'dark' ? CANOPY_RAMPS.dark : CANOPY_RAMPS.light;
}

/**
 * Parse a `#rrggbb` string into an `[r, g, b]` triple. Returns
 * `null` on malformed input so callers can produce their own
 * complaint chain. Used by `tools/dump-canopy-ramp.mjs` and any
 * test that needs byte-exact ramp comparisons.
 *
 * @param {string} hex
 * @returns {[number, number, number]|null}
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
