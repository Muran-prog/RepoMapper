/**
 * Hypsometric ramp dictionary.
 *
 * Each ramp is a curated palette mapping elevation (metres above mean
 * sea level) to sRGB colour. Negative elevations are bathymetry — they
 * are present in every ramp so the same dictionary drives both terrestrial
 * and seabed colouring without the renderer having to special-case land.
 *
 * Design rules
 * ------------
 *   • Light + dark variants share the same `elevation` axis so a theme
 *     switch is a pure colour swap; no resampling, no expression rebuild.
 *   • Every ramp covers Ukraine's vertical span end-to-end: Black-Sea
 *     trough (~-2200 m) → Hoverla (2061 m). Stops outside that range
 *     are still emitted so the colour at the limit looks intentional
 *     when the user pans into bordering Carpathian or Caucasus terrain.
 *   • Adjacent stops differ in both hue and lightness; expression.js
 *     interpolates them in CIELAB so colours stay perceptually uniform
 *     even when MapLibre falls back to linear-RGB blending in raster
 *     fallback mode.
 *   • Colour values are written as `#rrggbb`. They are pure data —
 *     no expressions, no zoom lookups. The expression generator is
 *     responsible for converting to MapLibre `interpolate` AST nodes.
 *
 * Auto-pick hint
 * --------------
 * `region` is a soft hint used by `ui/hypso/autoregion.js`. A ramp with
 * `region: 'alpine'` ranks higher when the visible viewport is dominated
 * by Carpathian terrain; `region: 'steppe'` wins for the bulk of central
 * Ukraine; `region: 'sea'` wins offshore. `region: 'global'` is the
 * neutral fallback.
 *
 * Colourblind safety
 * ------------------
 * `colorblindSafe: true` means the ramp passes deuteranopia + protanopia
 * + tritanopia simulation (verified by hand against Coblis / Sim Daltonism).
 * The ui picker labels these ramps in-place so the user knows the choice
 * is intentional rather than incidental.
 *
 * Adding a new ramp
 * -----------------
 *   1. Pick a stable kebab-case id (Latin only — it is persisted).
 *   2. Provide BOTH `light` and `dark` arrays of `[elev_m, '#rrggbb']`
 *      pairs, sorted ascending by elevation.
 *   3. Include at least one bathymetry stop (`elev_m < 0`) and one
 *      summit stop (≥ 2000 m).
 *   4. Add a `region` hint or leave it 'global'.
 *   5. Re-run `node validate.cjs` — no validator changes needed.
 *
 * @typedef {object} HypsoStop
 * @property {number} 0 Elevation in metres (negative = below sea level).
 * @property {string} 1 sRGB colour `#rrggbb`.
 *
 * @typedef {object} HypsoRamp
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {'global'|'alpine'|'steppe'|'sea'|'carpathian'} region
 * @property {boolean} colorblindSafe
 * @property {Array<[number, string]>} light
 * @property {Array<[number, string]>} dark
 */

/* eslint-disable max-len */

/** Default ramp id when none is persisted / configured. */
export const DEFAULT_RAMP_ID = 'touristAtlas';

/** Fallback ramp id when the chosen one is missing at lookup time. */
export const FALLBACK_RAMP_ID = 'touristAtlas';

/**
 * Built-in ramp dictionary. Frozen at module-init so consumers can rely
 * on object identity for memoisation.
 *
 * Order in the object is the order presented in the UI picker.
 *
 * @type {Readonly<Record<string, HypsoRamp>>}
 */
export const RAMPS = Object.freeze({
  // Vivid tourist-atlas rainbow — the look you see on topographic-map.com,
  // Soviet туристские атласы, and most paper trekking maps. Saturated
  // green → yellow → orange → red → pink. Densely sampled so the
  // Carpathians read with 5+ distinct colour bands between 500 m and
  // Hoverla. This is the default ramp because it's what users expect
  // when they hear "hypsometric tint" without further qualifiers.
  touristAtlas: Object.freeze({
    id: 'touristAtlas',
    name: 'Туристический атлас',
    summary: 'Яркая радуга — зелёная низменность → жёлтый → оранжевый → красный → розовый альпийский.',
    region: 'global',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#5b9bc4'],
      [-1500, '#76b1d2'],
      [-500, '#9ccae0'],
      [-50, '#bcd9e8'],
      [0, '#7fcf8f'],
      [100, '#92d674'],
      [200, '#a8de63'],
      [300, '#c0e555'],
      [400, '#d4e84a'],
      [500, '#ece843'],
      [600, '#f5d83a'],
      [700, '#f8c83a'],
      [800, '#f8b53c'],
      [900, '#f89e3c'],
      [1000, '#f88840'],
      [1100, '#f47246'],
      [1200, '#ee5b48'],
      [1300, '#e74848'],
      [1400, '#dd3a48'],
      [1500, '#d0334b'],
      [1600, '#bd3454'],
      [1700, '#ab3a62'],
      [1800, '#a04575'],
      [1900, '#a0588c'],
      [2000, '#ad75a2'],
      [2200, '#c597b8'],
      [2500, '#dcb8cd'],
      [3000, '#f0d8e4'],
    ]),
    dark: Object.freeze([
      [-3000, '#08151c'],
      [-1500, '#0d2230'],
      [-500, '#102c3e'],
      [-50, '#143548'],
      [0, '#1f3a20'],
      [100, '#264524'],
      [200, '#345224'],
      [300, '#445e22'],
      [400, '#566720'],
      [500, '#6b6b1e'],
      [600, '#76621c'],
      [700, '#7d551c'],
      [800, '#7e481e'],
      [900, '#7e3a20'],
      [1000, '#7e2f24'],
      [1100, '#7c2828'],
      [1200, '#76252c'],
      [1300, '#702430'],
      [1400, '#6c2638'],
      [1500, '#682844'],
      [1600, '#642e52'],
      [1700, '#623660'],
      [1800, '#624270'],
      [1900, '#665084'],
      [2000, '#76679c'],
      [2200, '#8e83b0'],
      [2500, '#a99fc0'],
      [3000, '#c8c0d4'],
    ]),
  }),

  // Tom Patterson's "cross-blended" hypsometric tint — the de-facto
  // reference modern atlas style. Low-green → ochre → sepia → snow-pale.
  // Bathymetry uses a soft blue ramp peaking near 0 m to avoid seams.
  patterson: Object.freeze({
    id: 'patterson',
    name: 'Patterson',
    summary: 'Современный атласный кросс-блендинг — зелёные низины, охра, заснеженные вершины.',
    region: 'global',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#2c5d83'],
      [-1500, '#3d80a8'],
      [-500, '#75b1d0'],
      [-50, '#a9cfe6'],
      [0, '#d0dfb8'],
      [200, '#e9e4a8'],
      [500, '#d9b880'],
      [900, '#ad8a55'],
      [1400, '#8c7554'],
      [1800, '#b3a69a'],
      [2100, '#f1ecea'],
      [3000, '#ffffff'],
    ]),
    dark: Object.freeze([
      [-3000, '#06141d'],
      [-1500, '#0a2334'],
      [-500, '#0c2c40'],
      [-50, '#0e2a3c'],
      [0, '#16231a'],
      [200, '#232b1f'],
      [500, '#302a1b'],
      [900, '#3e3224'],
      [1400, '#46382a'],
      [1800, '#4f463e'],
      [2100, '#6f6b66'],
      [3000, '#a09a92'],
    ]),
  }),

  // Erwin Raisz / Henry-style paper-atlas palette. Less saturated, more
  // sepia. Reads as an engraving with hand-tinted plates.
  raiszHenry: Object.freeze({
    id: 'raiszHenry',
    name: 'Raisz–Henry',
    summary: 'Бумажный атлас — сепия и шалфей, сдержанная насыщенность, гравюрный вид.',
    region: 'global',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#3a637a'],
      [-1500, '#5b85a1'],
      [-500, '#90b3c8'],
      [-50, '#bccfdb'],
      [0, '#e2dfc4'],
      [200, '#dad3a5'],
      [500, '#c7ba84'],
      [900, '#a89567'],
      [1400, '#8b7551'],
      [1800, '#a89484'],
      [2100, '#e9e1d4'],
      [3000, '#f7f3ea'],
    ]),
    dark: Object.freeze([
      [-3000, '#0a1923'],
      [-1500, '#11242f'],
      [-500, '#172c39'],
      [-50, '#1c3340'],
      [0, '#2a2a1f'],
      [200, '#332e21'],
      [500, '#3e3324'],
      [900, '#473826'],
      [1400, '#4a3d2e'],
      [1800, '#544a3f'],
      [2100, '#7a7264'],
      [3000, '#a6a190'],
    ]),
  }),

  // Imhof-inspired Swiss-atlas palette. Pastel greens, alpine grey,
  // bright snow. Designed to pair with a multi-direction hillshade.
  swissAlpine: Object.freeze({
    id: 'swissAlpine',
    name: 'Швейцарские Альпы',
    summary: 'Пастель Имхофа — зелёная база, серые вершины, сияющий снег.',
    region: 'alpine',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#244c66'],
      [-1500, '#3a78a0'],
      [-500, '#8cb6cf'],
      [-50, '#bcd3e0'],
      [0, '#c5d6a8'],
      [200, '#cfdcae'],
      [500, '#d6dba0'],
      [900, '#c4bc8b'],
      [1400, '#9a9a8c'],
      [1800, '#bcbab2'],
      [2100, '#e7e5dd'],
      [3000, '#ffffff'],
    ]),
    dark: Object.freeze([
      [-3000, '#04101a'],
      [-1500, '#08202f'],
      [-500, '#0c2e44'],
      [-50, '#0d2a3a'],
      [0, '#162217'],
      [200, '#1d2a1b'],
      [500, '#22301f'],
      [900, '#363b2a'],
      [1400, '#454a3d'],
      [1800, '#52584c'],
      [2100, '#7f8278'],
      [3000, '#b5b6ad'],
    ]),
  }),

  // OpenStreetMap "physical" community style — moderate greens, tan
  // mid-elevation, slate-grey high.
  osmPhysical: Object.freeze({
    id: 'osmPhysical',
    name: 'OSM physical',
    summary: 'Открытая физическая — ровная зелень, охристые склоны, сланцевые вершины.',
    region: 'global',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#15426b'],
      [-1500, '#26679a'],
      [-500, '#5a96c2'],
      [-50, '#9cc1da'],
      [0, '#a8c97a'],
      [200, '#d4d182'],
      [500, '#cfaa6a'],
      [900, '#a07847'],
      [1400, '#76563b'],
      [1800, '#7d7264'],
      [2100, '#c8c0b6'],
      [3000, '#f4f1ea'],
    ]),
    dark: Object.freeze([
      [-3000, '#02101c'],
      [-1500, '#062236'],
      [-500, '#0c324a'],
      [-50, '#10374d'],
      [0, '#1a2516'],
      [200, '#252e19'],
      [500, '#332a1a'],
      [900, '#3a2c1a'],
      [1400, '#3a2d22'],
      [1800, '#42382f'],
      [2100, '#665f55'],
      [3000, '#999188'],
    ]),
  }),

  // Carpathian-focus — compresses lowland tones, expands the 800–1800 m
  // band so subalpine textures read clearly. Tuned to make Hoverla,
  // Pip Ivan, Petros visually distinct from each other.
  carpathianFocus: Object.freeze({
    id: 'carpathianFocus',
    name: 'Карпатский фокус',
    summary: 'Высокий динамический диапазон в субальпийском поясе 800–1800 м.',
    region: 'carpathian',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#2c5d83'],
      [-50, '#a9cfe6'],
      [0, '#d6e3bf'],
      [400, '#d0c690'],
      [800, '#b89863'],
      [1000, '#a78348'],
      [1200, '#956c3c'],
      [1400, '#82593a'],
      [1600, '#8d6c52'],
      [1800, '#a89488'],
      [2000, '#cfc7c0'],
      [2200, '#f3f0ec'],
      [3000, '#ffffff'],
    ]),
    dark: Object.freeze([
      [-3000, '#06141d'],
      [-50, '#0e2a3c'],
      [0, '#1a261c'],
      [400, '#2c2d1a'],
      [800, '#3a3320'],
      [1000, '#473828'],
      [1200, '#523c2b'],
      [1400, '#5b402d'],
      [1600, '#5d4837'],
      [1800, '#5f5448'],
      [2000, '#776f64'],
      [2200, '#9d978f'],
      [3000, '#c7c2bb'],
    ]),
  }),

  // Steppe-flat — most of Ukraine sits 0–400 m, so we spend a lot of
  // bits there and compress the alpine tail. Reads as a smooth wash on
  // the Donbas / Polissia plateaus.
  steppeFlat: Object.freeze({
    id: 'steppeFlat',
    name: 'Степной плоский',
    summary: 'Плотный градиент 0–400 м — для чёткости плато и низменностей.',
    region: 'steppe',
    colorblindSafe: false,
    light: Object.freeze([
      [-3000, '#2c5d83'],
      [-50, '#a9cfe6'],
      [0, '#d8e3b2'],
      [50, '#dde1a3'],
      [100, '#e0dd96'],
      [150, '#e3d68a'],
      [200, '#e1cb7d'],
      [300, '#cfb070'],
      [500, '#b08e58'],
      [900, '#8c7555'],
      [1400, '#8a7766'],
      [1800, '#b6ada4'],
      [2100, '#ece8e3'],
      [3000, '#ffffff'],
    ]),
    dark: Object.freeze([
      [-3000, '#06141d'],
      [-50, '#0e2a3c'],
      [0, '#1a2516'],
      [50, '#1f2818'],
      [100, '#252b1a'],
      [150, '#2c2c1c'],
      [200, '#322e1e'],
      [300, '#3c331f'],
      [500, '#473a25'],
      [900, '#54422b'],
      [1400, '#5a4a3a'],
      [1800, '#62574e'],
      [2100, '#7e7872'],
      [3000, '#a8a39d'],
    ]),
  }),

  // Colourblind-safe — luminance does the heavy lifting; hues progress
  // through ColorBrewer's "viridis"-style sequential, slightly muted so
  // it doesn't override hillshade. Verified against deutan/protan/tritan
  // simulation.
  colorblindSafe: Object.freeze({
    id: 'colorblindSafe',
    name: 'Безопасно для дальтоников',
    summary: 'Виридис с ведущей яркостью — проверено на дейтер-/прот-/тританопии.',
    region: 'global',
    colorblindSafe: true,
    light: Object.freeze([
      [-3000, '#1a2750'],
      [-1500, '#22336a'],
      [-500, '#2e4a80'],
      [-50, '#3a6796'],
      [0, '#436a8f'],
      [200, '#3f7d8a'],
      [500, '#479285'],
      [900, '#83a26a'],
      [1400, '#cfb04c'],
      [1800, '#e9b446'],
      [2100, '#f3d061'],
      [3000, '#fffacf'],
    ]),
    dark: Object.freeze([
      [-3000, '#040716'],
      [-1500, '#0a1024'],
      [-500, '#12203b'],
      [-50, '#1a3251'],
      [0, '#1c3b58'],
      [200, '#1f4c5a'],
      [500, '#256055'],
      [900, '#4a6c3d'],
      [1400, '#8a6f2a'],
      [1800, '#a17e2e'],
      [2100, '#c69a3b'],
      [3000, '#ecd07c'],
    ]),
  }),
});

/**
 * Stable, UI-ordered list of all ramp ids. Order here drives the order
 * shown by the picker.
 *
 * @type {ReadonlyArray<string>}
 */
export const RAMP_IDS = Object.freeze(Object.keys(RAMPS));

/**
 * Custom ramp extension registry.
 *
 * UI code (the live editor, the JSON import flow) calls
 * `registerCustomRamps()` to inject user-authored ramps into the
 * lookup path. Built-in ramps in `RAMPS` always take precedence —
 * a user can shadow names like 'patterson' only by re-registering
 * with a distinct id, which we lint against in `store.js`.
 *
 * @type {Record<string, HypsoRamp>}
 */
const CUSTOM_RAMPS = {};

/**
 * Replace the entire set of registered custom ramps. UI invokes this
 * after loading from localStorage at boot, and again after every
 * upsert/delete. Callers are responsible for validation via
 * `ui/hypso/store.js::validateCustomRamp`.
 *
 * @param {Record<string, HypsoRamp>} ramps
 */
export function registerCustomRamps(ramps) {
  for (const id of Object.keys(CUSTOM_RAMPS)) delete CUSTOM_RAMPS[id];
  if (!ramps) return;
  for (const [id, ramp] of Object.entries(ramps)) {
    if (RAMPS[id]) continue; // never shadow a built-in
    CUSTOM_RAMPS[id] = ramp;
  }
}

/** @returns {Readonly<Record<string, HypsoRamp>>} */
export function getCustomRamps() {
  return { ...CUSTOM_RAMPS };
}

/**
 * Resolved ramp ids — built-in followed by custom (in registration
 * order). UI picker uses this to populate the dropdown without
 * special-casing custom entries.
 *
 * @returns {string[]}
 */
export function listRampIds() {
  return [...RAMP_IDS, ...Object.keys(CUSTOM_RAMPS)];
}

/**
 * Look up a ramp by id. Order:
 *   1. Built-in ramp (frozen in `RAMPS`).
 *   2. Custom ramp registered via `registerCustomRamps`.
 *   3. Default fallback ramp.
 *
 * @param {string} id
 * @returns {HypsoRamp}
 */
export function getRamp(id) {
  return RAMPS[id] || CUSTOM_RAMPS[id] || RAMPS[FALLBACK_RAMP_ID];
}

/**
 * Resolve the active stop array for the given (ramp, theme) pair.
 * Returns the array from the ramp directly — DO NOT mutate. Sorted
 * ascending by elevation. The returned shape is `[[elev, '#rrggbb'], ...]`.
 *
 * @param {string} rampId
 * @param {'light'|'dark'} theme
 * @returns {ReadonlyArray<[number, string]>}
 */
export function getRampStops(rampId, theme) {
  const ramp = getRamp(rampId);
  return theme === 'dark' ? ramp.dark : ramp.light;
}

/**
 * Predicate: does this ramp include bathymetric stops (any stop with
 * elev < 0)? Used to decide whether bathymetry layers can read from
 * the same ramp or need their own dedicated colour table.
 *
 * @param {string} rampId
 * @returns {boolean}
 */
export function rampHasBathymetry(rampId) {
  const r = getRamp(rampId);
  return r.light.some(([elev]) => elev < 0) && r.dark.some(([elev]) => elev < 0);
}

/**
 * Project the dark/light stops to a single CSS-gradient string for
 * legend rendering. Returns 'linear-gradient(...)' from low (bottom)
 * to high (top) — caller is responsible for the gradient direction.
 *
 * The output is *not* perceptually uniform; it relies on the browser's
 * native linear-RGB interpolation. For perceptually uniform results in
 * the map paint, use `buildColorReliefExpression` from expression.js.
 *
 * @param {string} rampId
 * @param {'light'|'dark'} theme
 * @returns {string} CSS `linear-gradient(...)` value.
 */
export function rampToCssGradient(rampId, theme) {
  const stops = getRampStops(rampId, theme);
  if (stops.length === 0) return 'transparent';
  const elevMin = stops[0][0];
  const elevMax = stops[stops.length - 1][0];
  const span = elevMax - elevMin || 1;
  const pieces = stops.map(([elev, color]) => {
    const pct = ((elev - elevMin) / span) * 100;
    return `${color} ${pct.toFixed(2)}%`;
  });
  return `linear-gradient(to top, ${pieces.join(', ')})`;
}
