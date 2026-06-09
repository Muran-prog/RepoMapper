/**
 * Forest-mode markup accents.
 *
 * A set of OPTIONAL, additive highlight layers that exist ONLY inside the
 * flat "Лесной покров" (forest-cover) view. composeLayers() pushes the
 * output of {@link forestMarkupLayers} at the very END of the layer stack,
 * guarded by `forestCover`, so:
 *
 *   • the accents always sit ON TOP (highlight semantics), and
 *   • they vanish completely the moment forest-cover is turned off — there
 *     is no other call site, so "forest-mode only" is structurally
 *     guaranteed rather than relying on a runtime guard.
 *
 * Each accent is driven by its own independent sub-flag, so the user can
 * mix them freely from the forest-mode sub-panel:
 *
 *   • forestCities      — bold blue city/town label + matching dot. The
 *                         headline toggle: settlements read instantly on
 *                         the green canvas. Because every place symbol
 *                         shares the global collision index, the bold-blue
 *                         label (higher priority via `symbol-sort-key`)
 *                         supersedes the base city label rather than
 *                         double-printing it.
 *   • forestWaterAccent — brighter, heavier waterway lines + water labels
 *                         so rivers and lakes pop against the forest fill.
 *   • forestRoadsBold   — near-black bold casing on the major road network
 *                         (motorway / trunk / primary) so the skeleton
 *                         stays legible over the green.
 *
 * Every accent reads a base OpenMapTiles source-layer (`place`, `water`,
 * `waterway`, `water_name`, `transportation`) that the base map always
 * consumes, so there is no extra source dependency or graceful-fallback
 * branch — the layers are pure paint on top of geometry that is already
 * present.
 */

const SOURCE = 'openmaptiles';

/** Coalesced name expression: prefer Ukrainian, fall back gracefully. */
const NAME_EXPR = [
  'coalesce',
  ['get', 'name:uk'],
  ['get', 'name:en'],
  ['get', 'name'],
];

/** Halo settings — colour varies by theme, geometry is shared. */
const halo = (color, width = 1.4) => ({
  'text-halo-color': color,
  'text-halo-width': width,
  'text-halo-blur': 0.4,
});

/**
 * Bold blue city/town accent. A bright dot grows with zoom under a heavy
 * blue label. `symbol-sort-key` favours cities over towns, and the layer
 * is emitted after the base label stack so it wins the global symbol
 * collision against the muted base place label at the same coordinate.
 */
function forestCityLayers(t) {
  const classes = ['city', 'town'];
  const filter = ['in', ['get', 'class'], ['literal', classes]];
  // Cities (0) outrank towns (100); within a class lower rank wins.
  const sortKey = [
    '+',
    ['match', ['get', 'class'], 'city', 0, 'town', 100, 200],
    ['coalesce', ['get', 'rank'], 5],
  ];
  const dotRadius = [
    'interpolate', ['linear'], ['zoom'],
    4, ['match', ['get', 'class'], 'city', 3.2, 1.8],
    10, ['match', ['get', 'class'], 'city', 6.0, 4.2],
    14, ['match', ['get', 'class'], 'city', 8.0, 6.0],
  ];
  const textSize = [
    'interpolate', ['linear'], ['zoom'],
    4, ['match', ['get', 'class'], 'city', 12, 10],
    8, ['match', ['get', 'class'], 'city', 17, 13],
    14, ['match', ['get', 'class'], 'city', 24, 18],
  ];
  return [
    {
      id: 'forest_city_dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'place',
      filter,
      layout: { 'circle-sort-key': sortKey },
      paint: {
        'circle-radius': dotRadius,
        'circle-color': t.forestCityAccent,
        'circle-stroke-color': t.forestCityAccentHalo,
        'circle-stroke-width': 1.6,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: 'forest_city_label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      filter,
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.bold,
        'text-size': textSize,
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-letter-spacing': 0.02,
        'text-max-width': 8,
        'text-padding': 6,
        // Lower key wins the global collision → the bold-blue accent
        // supersedes the muted base place label at the same spot.
        'symbol-sort-key': sortKey,
      },
      paint: {
        'text-color': t.forestCityAccent,
        ...halo(t.forestCityAccentHalo, 2.0),
      },
    },
  ];
}

/**
 * Vivid water accent. A brighter, heavier waterway line plus a saturated
 * water-name label so rivers and lakes carry through the flat forest fill.
 */
function forestWaterLayers(t) {
  return [
    {
      id: 'forest_water_accent_line',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      filter: ['in', ['get', 'class'], ['literal', ['river', 'canal', 'stream']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.forestWaterAccent,
        'line-opacity': 0.9,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          6, 0.8,
          10, ['match', ['get', 'class'], 'river', 2.2, 1.2],
          14, ['match', ['get', 'class'], 'river', 4.5, 2.0],
        ],
      },
    },
    {
      id: 'forest_water_accent_label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.bold,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15],
        'symbol-placement': 'point',
        'text-max-width': 7,
        'text-letter-spacing': 0.01,
      },
      paint: {
        'text-color': t.forestWaterAccent,
        ...halo(t.forestWaterAccentHalo, 1.6),
      },
    },
  ];
}

/**
 * Bold road skeleton. A single near-black casing on the major hierarchy
 * (motorway / trunk / primary) so the through-network stays readable over
 * the green without re-rendering the full base road stack.
 */
function forestRoadLayers(t) {
  return [
    {
      id: 'forest_roads_bold',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: [
        'in',
        ['get', 'class'],
        ['literal', ['motorway', 'trunk', 'primary']],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.forestRoadBold,
        'line-opacity': 0.85,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          5, 0.8,
          9, ['match', ['get', 'class'], 'motorway', 2.4, 'trunk', 2.0, 1.4],
          14, ['match', ['get', 'class'], 'motorway', 5.0, 'trunk', 4.2, 3.0],
        ],
      },
    },
  ];
}

/**
 * @typedef {object} ForestMarkupOpts
 * @property {boolean} [forestCities=true]       Bold blue city/town accent.
 * @property {boolean} [forestWaterAccent=false] Brighter rivers + water labels.
 * @property {boolean} [forestRoadsBold=false]   Bold casing on major roads.
 */

/**
 * Build the forest-mode markup accent layers. Only the enabled sub-flags
 * contribute layers; the caller (composeLayers) is responsible for gating
 * the whole bundle behind `forestCover` and emitting it at the top of the
 * stack.
 *
 * @param {object} t   Active theme tokens.
 * @param {ForestMarkupOpts} [opts]
 * @returns {object[]} MapLibre layer specs (possibly empty).
 */
export function forestMarkupLayers(t, opts = {}) {
  const {
    forestCities = true,
    forestWaterAccent = false,
    forestRoadsBold = false,
  } = opts;

  const layers = [];
  // Water + roads first so the bold city labels stay on top of them.
  if (forestWaterAccent) layers.push(...forestWaterLayers(t));
  if (forestRoadsBold) layers.push(...forestRoadLayers(t));
  if (forestCities) layers.push(...forestCityLayers(t));
  return layers;
}
