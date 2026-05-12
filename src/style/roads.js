/**
 * Road network — the centrepiece of the style.
 *
 * Approach
 * --------
 * Roads are described as data: each `class` in OpenMapTiles becomes one
 * entry in {@link ROAD_CLASSES}. From that entry we generate a casing
 * layer and an inline layer per `brunnel` level (ground, tunnel, bridge),
 * giving us full control over:
 *
 *   • per-class colour and width across the entire zoom range
 *   • per-class minZoom so motorways appear at zoom 4 but residentials
 *     don't pop in until zoom 12
 *   • smooth multi-stop exponential width curves
 *   • casing/inline layering for crisp intersections
 *   • dashed treatment of tunnels and tracks/paths
 *   • bridge stacking on top of ground roads
 *
 * The whole network thus reads as data, not boilerplate, and tuning the
 * map's "feel" is a matter of editing the config table at the top of the
 * file rather than hunting through dozens of layer specs.
 */

import { expZoom, linZoom, stepZoom, casingWidth, inFilter } from '../utils/interp.js';

// ---------------------------------------------------------------------------
// Road class catalog. Order matters: lower priority first, highest last —
// MapLibre paints in declaration order, so motorways end up on top of
// residentials at intersections, just like a paper atlas.
// ---------------------------------------------------------------------------

/** @typedef {Object} RoadClass
 *  @property {string}  id            stable layer prefix
 *  @property {string|string[]} match value(s) for the OMT `class` field
 *  @property {number}  minZoom       layer minzoom
 *  @property {string}  inlineKey     token key for inline colour
 *  @property {string}  casingKey     token key for casing colour
 *  @property {Array<[number, number]>} widths inline widths (zoom→px)
 *  @property {number}  casingExtra   how much wider the casing should be
 *  @property {boolean} [dashed]      render inline with a dash array
 */

const ROAD_CLASSES = [
  // path / pedestrian / track — finest tier, dashed
  {
    id: 'path',
    match: 'path',
    minZoom: 14,
    inlineKey: 'path',
    casingKey: 'pathCasing',
    widths: [
      [14, 0.4],
      [16, 1.2],
      [18, 2.8],
      [20, 6],
      [22, 11],
    ],
    casingExtra: 1.0,
    dashed: true,
  },
  {
    id: 'track',
    match: 'track',
    minZoom: 13,
    inlineKey: 'track',
    casingKey: 'trackCasing',
    widths: [
      [13, 0.4],
      [14, 0.8],
      [16, 1.8],
      [18, 4],
      [20, 8],
      [22, 14],
    ],
    casingExtra: 1.0,
    dashed: true,
  },
  {
    id: 'pedestrian',
    match: 'pedestrian',
    minZoom: 14,
    inlineKey: 'pedestrian',
    casingKey: 'pedestrianCasing',
    widths: [
      [14, 0.6],
      [16, 2.2],
      [18, 5.5],
      [20, 11],
      [22, 20],
    ],
    casingExtra: 1.0,
  },
  // service / minor — neighbourhood streets
  {
    id: 'service',
    match: 'service',
    minZoom: 13,
    inlineKey: 'service',
    casingKey: 'serviceCasing',
    widths: [
      [13, 0.4],
      [14, 1.0],
      [16, 2.6],
      [18, 5.5],
      [20, 11],
      [22, 20],
    ],
    casingExtra: 1.5,
  },
  {
    id: 'minor',
    match: 'minor',
    minZoom: 12,
    inlineKey: 'minor',
    casingKey: 'minorCasing',
    widths: [
      [12, 0.4],
      [13, 0.9],
      [14, 1.6],
      [16, 4.0],
      [18, 7.5],
      [20, 15],
      [22, 28],
    ],
    casingExtra: 2.0,
  },
  // tertiary / secondary / primary / trunk / motorway — major hierarchy
  {
    id: 'tertiary',
    match: 'tertiary',
    minZoom: 10,
    inlineKey: 'tertiary',
    casingKey: 'tertiaryCasing',
    widths: [
      [10, 0.3],
      [12, 1.0],
      [14, 2.6],
      [16, 5.5],
      [18, 10],
      [20, 18],
      [22, 34],
    ],
    casingExtra: 2.0,
  },
  {
    id: 'secondary',
    match: 'secondary',
    minZoom: 9,
    inlineKey: 'secondary',
    casingKey: 'secondaryCasing',
    widths: [
      [9, 0.3],
      [11, 0.9],
      [12, 1.6],
      [14, 3.6],
      [16, 7.0],
      [18, 12.5],
      [20, 23],
      [22, 42],
    ],
    casingExtra: 2.4,
  },
  {
    id: 'primary',
    match: 'primary',
    minZoom: 7,
    inlineKey: 'primary',
    casingKey: 'primaryCasing',
    widths: [
      [7, 0.3],
      [9, 0.7],
      [11, 1.4],
      [12, 2.2],
      [14, 4.7],
      [16, 8.5],
      [18, 14.5],
      [20, 27],
      [22, 50],
    ],
    casingExtra: 2.4,
  },
  {
    id: 'trunk',
    match: 'trunk',
    minZoom: 6,
    inlineKey: 'trunk',
    casingKey: 'trunkCasing',
    widths: [
      [6, 0.3],
      [9, 0.9],
      [11, 1.6],
      [12, 2.6],
      [14, 5.5],
      [16, 9.5],
      [18, 17],
      [20, 30],
      [22, 58],
    ],
    casingExtra: 2.6,
  },
  {
    id: 'motorway',
    match: 'motorway',
    minZoom: 5,
    inlineKey: 'motorway',
    casingKey: 'motorwayCasing',
    widths: [
      [5, 0.3],
      [7, 0.6],
      [9, 1.2],
      [11, 1.8],
      [12, 3.0],
      [14, 6.2],
      [16, 10.5],
      [18, 18.5],
      [20, 33],
      [22, 64],
    ],
    casingExtra: 3.0,
  },
];

// ---------------------------------------------------------------------------
// Layer factories
// ---------------------------------------------------------------------------

const SOURCE = 'openmaptiles';
const LAYER = 'transportation';

const roundCaps = { 'line-cap': 'round', 'line-join': 'round' };
const buttCaps = { 'line-cap': 'butt', 'line-join': 'round' };

/** Filter that selects features of the given class for the given brunnel. */
function classFilter(rc, brunnel) {
  const matchValues = Array.isArray(rc.match) ? rc.match : [rc.match];
  const baseMatch =
    matchValues.length === 1
      ? ['==', ['get', 'class'], matchValues[0]]
      : inFilter('class', matchValues);

  if (brunnel === 'ground') {
    return [
      'all',
      baseMatch,
      ['!=', ['get', 'brunnel'], 'tunnel'],
      ['!=', ['get', 'brunnel'], 'bridge'],
    ];
  }
  return ['all', baseMatch, ['==', ['get', 'brunnel'], brunnel]];
}

function casingLayer(rc, brunnel, t) {
  const id = `road_${brunnel}_${rc.id}_casing`;
  const baseOpacity =
    brunnel === 'tunnel' ? 0.55 : 1.0;

  return {
    id,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, brunnel),
    layout: rc.id === 'pedestrian' ? buttCaps : roundCaps,
    paint: {
      'line-color': t[rc.casingKey],
      'line-width': casingWidth(rc.widths, rc.casingExtra),
      'line-opacity': baseOpacity,
      ...(brunnel === 'tunnel'
        ? {
            'line-dasharray': stepZoom(
              ['literal', [3, 2]],
              [
                [16, ['literal', [4, 2]]],
                [20, ['literal', [6, 3]]],
              ],
            ),
          }
        : {}),
    },
  };
}

function inlineLayer(rc, brunnel, t) {
  const id = `road_${brunnel}_${rc.id}`;
  const baseOpacity = brunnel === 'tunnel' ? 0.7 : 1.0;

  const paint = {
    'line-color': t[rc.inlineKey],
    'line-width': expZoom(rc.widths),
    'line-opacity': baseOpacity,
  };

  if (rc.dashed) {
    // Step-based dashes avoid the swimming-dash artifact that exponential
    // width interpolation would otherwise produce on dashed lines.
    paint['line-dasharray'] = stepZoom(
      ['literal', [2, 2]],
      [
        [16, ['literal', [3, 1.5]]],
        [20, ['literal', [4, 1.5]]],
      ],
    );
  }

  return {
    id,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, brunnel),
    layout: rc.id === 'pedestrian' ? buttCaps : roundCaps,
    paint,
  };
}

/**
 * Generate (casing, inline) pair for every road class at the given brunnel
 * level, ordered low→high priority.
 */
function brunnelStack(brunnel, t) {
  const out = [];
  for (const rc of ROAD_CLASSES) out.push(casingLayer(rc, brunnel, t));
  for (const rc of ROAD_CLASSES) out.push(inlineLayer(rc, brunnel, t));
  return out;
}

// ---------------------------------------------------------------------------
// Railways — thin, dashed, drawn between ground roads and bridges so they
// pass under elevated highways.
// ---------------------------------------------------------------------------
function railways(t) {
  return [
    {
      id: 'rail_casing',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 9,
      filter: ['==', ['get', 'class'], 'rail'],
      paint: {
        'line-color': t.rail,
        'line-width': expZoom([
          [9, 0.4],
          [14, 1.6],
          [18, 3.2],
          [22, 6],
        ]),
      },
    },
    {
      id: 'rail_dash',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 11,
      filter: ['==', ['get', 'class'], 'rail'],
      paint: {
        'line-color': t.bg,
        'line-width': expZoom([
          [11, 0.4],
          [14, 0.8],
          [18, 1.4],
          [22, 2.4],
        ]),
        'line-dasharray': stepZoom(
          ['literal', [2, 2]],
          [
            [16, ['literal', [3, 3]]],
            [20, ['literal', [4, 4]]],
          ],
        ),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public entry — emits the full transportation stack, ordered for clean
// intersections:
//   1. tunnel casings + inlines  (lowest)
//   2. ground casings + inlines
//   3. railways
//   4. bridge casings + inlines  (highest)
// ---------------------------------------------------------------------------
export function roadLayers(t) {
  return [
    ...brunnelStack('tunnel', t),
    ...brunnelStack('ground', t),
    ...railways(t),
    ...brunnelStack('bridge', t),
  ];
}

/** Class IDs exposed for control modules that want to toggle road tiers. */
export const ROAD_CLASS_IDS = ROAD_CLASSES.map((r) => r.id);
