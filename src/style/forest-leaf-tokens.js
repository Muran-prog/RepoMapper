/**
 * Forest leaf-type design tokens — Carpathian biom-colouring palette.
 *
 * The OSM `leaf_type` tag (broadleaved | needleleaved | mixed | leafless)
 * is the primary input. When it's missing the renderer cascades to the
 * legacy `wood` tag (coniferous / deciduous / mixed) and finally to a
 * `leaf_cycle` heuristic (evergreen + landuse=forest → needleleaved,
 * deciduous → broadleaved). The `unknown` slot is the catch-all so a
 * forest polygon never reads as a hole in the canvas.
 *
 * Visual brief (Carpathian read at z9-13):
 *
 *   • Чорногора / Свидовець / Ґорґани — needleleaved, cool dark green
 *   • Закарпатська лісова смуга (Угольки, Гошку, Стужиця) — broadleaved,
 *     warm yellow-green — букові праліси
 *   • Mixed bands on slopes 800-1200 m — between the two
 *   • Заповідні території (protect_class != null) — янтарна пунктирна
 *     обводка поверх біом-кольору
 *
 * Design rules
 * ------------
 *   • Every layer in `carpathian.js::forestPolygonLayers` reads ONLY
 *     these tokens — no inline literals on the layer side.
 *   • Light + dark variants share hue; dark variants pull L* down
 *     ~18-22 % so the fill reads on the deep slate canvas without
 *     re-saturating against hillshade.
 *   • Outline is darker than fill, label colour is darker than outline
 *     so a label always reads as the most saturated point of the
 *     biom-cluster (matches Patterson's "label = bull's eye" rule).
 *   • Tokens are pure data — no expressions, no zoom lookups. The
 *     style module wraps them in MapLibre AST.
 *
 * @typedef {object} ForestLeafToken
 * @property {string} fill     `fill-color` for the polygon body.
 * @property {string} outline  `line-color` for the polygon edge.
 * @property {string} label    `text-color` for the symbol layer.
 *
 * @typedef {object} ForestLeafBundle
 * @property {ForestLeafToken} needleleaved
 * @property {ForestLeafToken} broadleaved
 * @property {ForestLeafToken} mixed
 * @property {ForestLeafToken} leafless
 * @property {ForestLeafToken} unknown
 */

/**
 * Light + dark biom-colour bundles for the four canonical leaf-type
 * classes plus the `unknown` fallback.
 *
 * @type {Readonly<{ light: ForestLeafBundle, dark: ForestLeafBundle }>}
 */
export const FOREST_LEAF = Object.freeze({
  light: Object.freeze({
    // Needleleaved — Чорногора cold dark conifer green.
    needleleaved: Object.freeze({
      fill: '#3a5a3e',
      outline: '#2c4830',
      label: '#1a3018',
    }),
    // Broadleaved — букові праліси Угольки warm yellow-green.
    broadleaved: Object.freeze({
      fill: '#7a8d3e',
      outline: '#5d6f2c',
      label: '#3a4818',
    }),
    // Mixed — between the two, slightly cooler than broadleaved.
    mixed: Object.freeze({
      fill: '#5a7a3a',
      outline: '#445a2c',
      label: '#283818',
    }),
    // Leafless — dormant / клярі смуги. Warm grey-green.
    leafless: Object.freeze({
      fill: '#7d8055',
      outline: '#5e6240',
      label: '#2e3220',
    }),
    // Unknown — generic forest tone, pulls slightly toward needleleaved
    // since most untagged Carpathian forests are conifer-dominated.
    unknown: Object.freeze({
      fill: '#587548',
      outline: '#436338',
      label: '#243a1c',
    }),
  }),
  dark: Object.freeze({
    needleleaved: Object.freeze({
      fill: '#2c4630',
      outline: '#1f3422',
      label: '#a8c8a8',
    }),
    broadleaved: Object.freeze({
      fill: '#5e6e2f',
      outline: '#465320',
      label: '#c8d29a',
    }),
    mixed: Object.freeze({
      fill: '#445e2d',
      outline: '#324520',
      label: '#a8c08a',
    }),
    leafless: Object.freeze({
      fill: '#5d6042',
      outline: '#444530',
      label: '#b8b8a0',
    }),
    unknown: Object.freeze({
      fill: '#42583a',
      outline: '#324a2c',
      label: '#a0c08a',
    }),
  }),
});

/**
 * Protected-area accent — янтарна пунктирна обводка that sits over the
 * biom fill for any polygon carrying `protect_class` (or an inferred
 * `boundary=protected_area`). Same hue family as the road / building
 * accent so заповідники read as "important" within the existing
 * cartographic vocabulary.
 *
 * @type {Readonly<{ light: { stroke: string, dash: ReadonlyArray<number> },
 *                   dark:  { stroke: string, dash: ReadonlyArray<number> } }>}
 */
export const FOREST_PROTECT = Object.freeze({
  light: Object.freeze({
    stroke: '#a86b22',
    dash: Object.freeze([3, 2]),
  }),
  dark: Object.freeze({
    // Brightened for the deep-slate canvas — same hue as the road
    // glow so the dashed outline stays in the accent family.
    stroke: '#e3a050',
    dash: Object.freeze([3, 2]),
  }),
});

/**
 * Symbol-layer label sizing + zoom-gated visibility thresholds.
 *
 *   • `fontScale` — applied as a multiplier on top of the per-zoom
 *     italic size curve in `carpathianLabels`. 0.85 keeps forest-mass
 *     names visually quieter than peak / town labels.
 *   • `minAreaForName` — m² area thresholds keyed by zoom. At z8 we
 *     only label massifs > 50 km² (Чорногірський заповідник, Свидовець,
 *     Ґорґани); at z14 the threshold drops to 1 km² so the canvas
 *     fills with smaller named tracts (Турбат, Кострич, etc.) without
 *     drowning peak labels.
 *
 * @type {Readonly<{ fontScale: number,
 *                   minAreaForName: Readonly<Record<number, number>> }>}
 */
export const FOREST_LABEL = Object.freeze({
  fontScale: 0.85,
  minAreaForName: Object.freeze({
    8: 5e7,    // 50 km² — overview, only the giant massifs read
    10: 2e7,   // 20 km²
    12: 5e6,   // 5 km²
    14: 1e6,   // 1 km²
  }),
});

/**
 * Resolve the active leaf-token bundle for a theme. Returns the frozen
 * bundle directly — DO NOT mutate. Falls back to light on unknown
 * themes so a typo never crashes the renderer.
 *
 * @param {'light'|'dark'} theme
 * @returns {ForestLeafBundle}
 */
export function getForestLeafBundle(theme) {
  return theme === 'dark' ? FOREST_LEAF.dark : FOREST_LEAF.light;
}

/**
 * Resolve the protected-area accent for a theme.
 *
 * @param {'light'|'dark'} theme
 * @returns {{ stroke: string, dash: ReadonlyArray<number> }}
 */
export function getForestProtect(theme) {
  return theme === 'dark' ? FOREST_PROTECT.dark : FOREST_PROTECT.light;
}

/**
 * Resolve the m² area threshold for forest-massif labels at a given
 * zoom. Picks the largest `minAreaForName` key ≤ `zoom`; below the
 * lowest-keyed zoom returns +Infinity (= no labels). Kept as a pure
 * helper so style + UI / tests can share the same logic.
 *
 * @param {number} zoom
 * @returns {number} Area threshold in m². +Infinity = never label.
 */
export function forestLabelMinArea(zoom) {
  const keys = Object.keys(FOREST_LABEL.minAreaForName)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  let threshold = Number.POSITIVE_INFINITY;
  for (const k of keys) {
    if (zoom >= k) threshold = FOREST_LABEL.minAreaForName[k];
  }
  return threshold;
}

/**
 * Stable, ordered list of canonical leaf-type slot ids. The order
 * doubles as the iteration order for any test or smoke-tool that
 * walks the bundle so output stays byte-stable across Node versions.
 */
export const FOREST_LEAF_KEYS = Object.freeze([
  'needleleaved',
  'broadleaved',
  'mixed',
  'leafless',
  'unknown',
]);
