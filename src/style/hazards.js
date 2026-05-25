/**
 * Hazardous terrain emphasis — high-visibility overlay for "hard-to-reach
 * mountains, sharp cliffs, dangerous passes" inside the Carpathian bbox.
 *
 * The data already lives inside `carpathian-osm.pmtiles` (source-layer
 * `mountain_feature`):
 *
 *   class=peak  + ele >= HAZARD.peakExtremeMinEle  → "extreme peak"
 *                                                    (Hoverla, Pip Ivan,
 *                                                    Petros, Brebeneskul…)
 *   class=peak  + ele >= HAZARD.peakHardMinEle     → "hard peak"
 *                                                    (1500–1800 m band)
 *   class=cliff                                    → cliff / sharp drop
 *   class=pass  + ele >= HAZARD.passDangerMinEle   → high mountain pass
 *
 * Cartographic intent — readability without zoom.
 *
 *   • Bright halo + ring around each marker so the symbol is unmistakeably
 *     "hazard" even at country-overview zoom (z6-9). Peak ring is magenta,
 *     cliff is teal, dangerous pass is amber-orange. None of those hues
 *     collide with the existing palette (peaks = umber, trails = red,
 *     amber-roads sit in a warmer band, contours = sepia, hypso = green
 *     → ochre → grey-white).
 *   • A loud SAFETY-label paints next to every hazard with the name (or
 *     fallback "Гора"/"Скеля"/"Перевал") + elevation. The label uses a
 *     dedicated colour token (`t.hazard.*.label`) that's distinct from
 *     `t.textPeak`, so the user can tell a hazard label from a regular
 *     peak label at a glance.
 *   • Layer is emitted LAST in the symbol stack with low (very negative)
 *     `symbol-sort-key` so collisions favour hazards over generic places.
 *
 * Z-order in `composeLayers()` — appended AFTER `carpathianLabels(t)` so
 * hazard markers / labels paint on top of every other label including
 * peak labels. This is intentional: the hazard layer is the highest-
 * priority cartographic signal, full stop.
 *
 * Source-gating — the layer composer only invokes this module when
 * `features.hazardousTerrain && hasCarpathianOsmSource` is true. The
 * underlying data lives in the same vector tiles that drive `carpathian.js`.
 */

import { CARPATHIAN } from '../config.js';
import { expZoom, linZoom } from '../utils/interp.js';

const CARP_OSM = 'carpathian-osm';

// ---------------------------------------------------------------------------
// Thresholds & per-zoom rules.
//
// `peakExtremeMinEle` = 1800 m → top tier of the Ukrainian Carpathians:
//                                  Hoverla (2061), Brebeneskul (2032),
//                                  Pip Ivan (2028), Petros (2020), …
// `peakHardMinEle`    = 1500 m → secondary tier: Свидовець, Ґорґани mid
//                                  массивів, approachable but серйозні
//                                  при погоді. Visible from z8.
// ---------------------------------------------------------------------------

const HAZARD = {
  peakExtremeMinEle: 1800,
  peakHardMinEle: 1500,
  passDangerMinEle: 1300,
  // Visible from country-overview onwards (no zoom required).
  zoomRules: {
    extremePeak: 6,
    hardPeak: 8,
    cliff: 9,
    pass: 9,
    label: 7,
  },
};

const NAME_EXPR = [
  'coalesce',
  ['get', 'name:uk'],
  ['get', 'name:en'],
  ['get', 'name'],
];

/** "<name>\n<ele> м" — same shape as the regular peak label. */
const NAME_AND_ELE = [
  'format',
  NAME_EXPR, { 'font-scale': 1.0 },
  '\n', {},
  ['concat', ['to-string', ['get', 'ele']], ' м'], { 'font-scale': 0.78 },
];

/** Cliff name OR localised fallback "Обрив". Never empty. */
const CLIFF_LABEL = [
  'format',
  [
    'coalesce',
    ['get', 'name:uk'],
    ['get', 'name:en'],
    ['get', 'name'],
    'Обрив',
  ], { 'font-scale': 1.0 },
];

/** Pass name + elevation, fallback "Перевал". */
const PASS_LABEL = [
  'format',
  [
    'coalesce',
    ['get', 'name:uk'],
    ['get', 'name:en'],
    ['get', 'name'],
    'Перевал',
  ], { 'font-scale': 1.0 },
  '\n', {},
  [
    'case',
    ['has', 'ele'],
    ['concat', ['to-string', ['get', 'ele']], ' м'],
    '',
  ], { 'font-scale': 0.78 },
];

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const extremePeakFilter = [
  'all',
  ['==', ['get', 'class'], 'peak'],
  ['has', 'ele'],
  ['>=', ['to-number', ['coalesce', ['get', 'ele'], 0]], HAZARD.peakExtremeMinEle],
];

const hardPeakFilter = [
  'all',
  ['==', ['get', 'class'], 'peak'],
  ['has', 'ele'],
  ['>=', ['to-number', ['coalesce', ['get', 'ele'], 0]], HAZARD.peakHardMinEle],
  ['<',  ['to-number', ['coalesce', ['get', 'ele'], 0]], HAZARD.peakExtremeMinEle],
];

const cliffFilter = ['==', ['get', 'class'], 'cliff'];

const dangerousPassFilter = [
  'all',
  ['==', ['get', 'class'], 'pass'],
  ['has', 'ele'],
  ['>=', ['to-number', ['coalesce', ['get', 'ele'], 0]], HAZARD.passDangerMinEle],
];

// ---------------------------------------------------------------------------
// Layer factory.
//
// Each hazard kind paints a triple:
//   1. soft outer glow (circle, blur, low alpha) — visible from far
//   2. crisp ring marker (circle stroke, no fill)               
//   3. label (symbol) — hazard-specific colour, halo for legibility
// ---------------------------------------------------------------------------

/**
 * Build a (glow + ring + label) trio for one hazard class.
 *
 * @param {object}  opts
 * @param {string}  opts.idPrefix     Layer id stem (e.g. 'hazard_peak_extreme').
 * @param {Array}   opts.filter       MapLibre filter expression.
 * @param {number}  opts.minzoom      First zoom the layers appear at.
 * @param {string}  opts.glowColor    Soft halo colour (rgba w/ alpha).
 * @param {string}  opts.ringColor    Crisp ring colour.
 * @param {string}  opts.labelColor   Label fill (DIFFERENT from any
 *                                    existing label-colour token).
 * @param {string}  opts.labelHalo    Label halo (high contrast vs ring).
 * @param {Array}   opts.labelText    text-field expression.
 * @param {Array<[number, number]>} opts.ringStops [zoom, radius_px] crisp ring.
 * @param {Array<[number, number]>} opts.glowStops [zoom, radius_px] outer halo.
 * @param {Array<[number, number]>} [opts.textSizeStops] [zoom, px] for label.
 * @param {number}  [opts.sortKey=−1e9] symbol-sort-key (very negative = always wins).
 * @param {object}  t Theme tokens.
 * @returns {Array<object>} Three layer specs in paint order.
 */
function hazardTriple(t, opts) {
  const {
    idPrefix, filter, minzoom,
    glowColor, ringColor, ringFill = 'rgba(0,0,0,0)',
    labelColor, labelHalo, labelText,
    ringStops, glowStops,
    textSizeStops = [[7, 11], [10, 13], [14, 16], [18, 18]],
    sortKey = -1e9,
    fontStack = t.font.bold,
  } = opts;

  const ringRadius = ['interpolate', ['linear'], ['zoom'],
    ...ringStops.flatMap(([z, r]) => [z, r]),
  ];
  const glowRadius = ['interpolate', ['linear'], ['zoom'],
    ...glowStops.flatMap(([z, r]) => [z, r]),
  ];
  const textSize = ['interpolate', ['linear'], ['zoom'],
    ...textSizeStops.flatMap(([z, p]) => [z, p]),
  ];
  // Smooth fade-in: 0 → 1 across the half-zoom window above `minzoom`
  // so the layer never pops in at z transitions.
  const fadeIn = linZoom([
    [minzoom - 0.5, 0],
    [minzoom + 0.3, 1],
  ]);

  return [
    // Outer halo — large, soft, low alpha. Reads from far away.
    {
      id: `${idPrefix}_glow`,
      type: 'circle',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      paint: {
        'circle-color': glowColor,
        'circle-radius': glowRadius,
        'circle-blur': 1.0,
        'circle-opacity': fadeIn,
        // No stroke on the glow — it's a fuzzy halo, not a ring.
        'circle-stroke-width': 0,
      },
    },
    // Crisp ring — high-contrast circle stroke, transparent fill so the
    // underlying terrain reads through. This is the cartographic
    // "warning sign".
    {
      id: `${idPrefix}_ring`,
      type: 'circle',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      paint: {
        'circle-color': ringFill,
        'circle-radius': ringRadius,
        'circle-stroke-color': ringColor,
        // Ring thickness mirrors radius so the marker stays readable
        // at every zoom: thin ring at z6, chunky ring at z16.
        'circle-stroke-width': expZoom([
          [minzoom, 1.4],
          [12, 2.2],
          [18, 3.5],
        ]),
        'circle-opacity': fadeIn,
        'circle-stroke-opacity': fadeIn,
      },
    },
    // Label — hazard-specific colour + halo. Sort-key is very negative
    // so MapLibre's collision arbitration always puts hazards first.
    {
      id: `${idPrefix}_label`,
      type: 'symbol',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      layout: {
        'text-field': labelText,
        'text-font': fontStack,
        'text-size': textSize,
        'text-anchor': 'top',
        'text-offset': [0, 1.0],
        'text-padding': 4,
        'text-max-width': 8,
        'text-letter-spacing': 0.02,
        'symbol-sort-key': sortKey,
        // Don't allow these labels to be culled by the regular
        // place / road / trail labels — they're the loudest signal.
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        'text-color': labelColor,
        'text-halo-color': labelHalo,
        'text-halo-width': 2.4,
        'text-halo-blur': 0.6,
        'text-opacity': fadeIn,
      },
    },
  ];
}

/**
 * Compose the hazardous-terrain overlay.
 *
 * Returns layers in correct paint order:
 *
 *   1. extreme peak glow / ring / label   (≥1800 m, magenta)
 *   2. hard peak glow / ring / label      (1500–1800 m, deep red-orange)
 *   3. cliff glow / ring / label          (teal)
 *   4. dangerous high pass glow / ring / label (≥1300 m, amber)
 *
 * Order matches priority — the hardest peaks paint first so they sit
 * underneath cliff markers when geometry coincides (rare). The label
 * sort-keys still arbitrate so the priority cascade reads:
 *
 *   extreme peak (≥1800 m)  > cliff  > dangerous pass  > hard peak (1500-1800)
 *
 * @param {object} t Theme tokens (must contain a `t.hazard.*` namespace).
 * @returns {Array<object>} Layer specs.
 */
export function hazardLayers(t) {
  const layers = [];

  // ---- Extreme peaks (the loudest tier) ------------------------------
  layers.push(...hazardTriple(t, {
    idPrefix: 'hazard_peak_extreme',
    filter: extremePeakFilter,
    minzoom: HAZARD.zoomRules.extremePeak,
    glowColor: t.hazard.peak.glow,
    ringColor: t.hazard.peak.ring,
    labelColor: t.hazard.peak.label,
    labelHalo: t.hazard.peak.halo,
    labelText: NAME_AND_ELE,
    // Crisp ring small at country zoom, chunky at hiking zooms.
    ringStops: [[6, 5], [9, 7], [12, 9], [16, 12], [20, 16]],
    glowStops: [[6, 11], [9, 14], [12, 18], [16, 24], [20, 32]],
    textSizeStops: [[6, 11], [10, 13], [14, 16], [18, 19]],
    // Far more negative than any peak label sort-key (which uses
    // -ele, peaking around -2000) so extreme peaks ALWAYS win.
    sortKey: -1e9,
  }));

  // ---- Hard peaks (1500-1800 m) -------------------------------------
  layers.push(...hazardTriple(t, {
    idPrefix: 'hazard_peak_hard',
    filter: hardPeakFilter,
    minzoom: HAZARD.zoomRules.hardPeak,
    glowColor: t.hazard.peakHard.glow,
    ringColor: t.hazard.peakHard.ring,
    labelColor: t.hazard.peakHard.label,
    labelHalo: t.hazard.peakHard.halo,
    labelText: NAME_AND_ELE,
    ringStops: [[8, 4.5], [12, 7], [16, 10], [20, 14]],
    glowStops: [[8, 10], [12, 14], [16, 20], [20, 28]],
    textSizeStops: [[8, 10], [12, 12], [16, 14], [20, 17]],
    sortKey: -9e8,
  }));

  // ---- Cliffs (sharp drops) -----------------------------------------
  layers.push(...hazardTriple(t, {
    idPrefix: 'hazard_cliff',
    filter: cliffFilter,
    minzoom: HAZARD.zoomRules.cliff,
    glowColor: t.hazard.cliff.glow,
    ringColor: t.hazard.cliff.ring,
    labelColor: t.hazard.cliff.label,
    labelHalo: t.hazard.cliff.halo,
    labelText: CLIFF_LABEL,
    ringStops: [[9, 4], [12, 6], [16, 9], [20, 13]],
    glowStops: [[9, 9], [12, 13], [16, 18], [20, 26]],
    textSizeStops: [[9, 10], [12, 12], [16, 14], [20, 16]],
    fontStack: t.font.italic,
    sortKey: -8e8,
  }));

  // ---- Dangerous high passes ----------------------------------------
  layers.push(...hazardTriple(t, {
    idPrefix: 'hazard_pass_danger',
    filter: dangerousPassFilter,
    minzoom: HAZARD.zoomRules.pass,
    glowColor: t.hazard.passDanger.glow,
    ringColor: t.hazard.passDanger.ring,
    labelColor: t.hazard.passDanger.label,
    labelHalo: t.hazard.passDanger.halo,
    labelText: PASS_LABEL,
    ringStops: [[9, 4], [12, 6], [16, 8], [20, 11]],
    glowStops: [[9, 9], [12, 12], [16, 16], [20, 22]],
    textSizeStops: [[9, 9], [12, 11], [16, 13], [20, 15]],
    fontStack: t.font.italic,
    sortKey: -7e8,
  }));

  return layers;
}

/**
 * Layer ids emitted by `hazardLayers()` — exported so the validator
 * (and any future imperative code) can assert presence/absence without
 * duplicating the list.
 */
export const HAZARD_LAYER_IDS = Object.freeze([
  'hazard_peak_extreme_glow',
  'hazard_peak_extreme_ring',
  'hazard_peak_extreme_label',
  'hazard_peak_hard_glow',
  'hazard_peak_hard_ring',
  'hazard_peak_hard_label',
  'hazard_cliff_glow',
  'hazard_cliff_ring',
  'hazard_cliff_label',
  'hazard_pass_danger_glow',
  'hazard_pass_danger_ring',
  'hazard_pass_danger_label',
]);
