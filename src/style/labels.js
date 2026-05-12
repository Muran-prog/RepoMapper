/**
 * Labels — every text and symbol layer in the style.
 *
 * Strategy
 * --------
 * Labels are the hardest part of cartography to get right. Five rules:
 *
 *   1. PRIORITISE by importance. We use `symbol-sort-key` derived from the
 *      OpenMapTiles `rank` property (lower rank = more important place).
 *      Where rank is missing, we synthesise one from the feature class.
 *
 *   2. RESPECT collisions. `text-allow-overlap` and `icon-allow-overlap`
 *      stay off so MapLibre drops labels that would cover each other.
 *      `text-padding` scales with device density so phones (where you
 *      can't zoom as precisely) get more breathing room.
 *
 *   3. SCALE WITH ZOOM. Text grows with zoom but never explodes. Each
 *      label tier has a smooth size curve; halo and colour stay theme-
 *      consistent.
 *
 *   4. FADE IN GRACEFULLY. Every layer that appears at a zoom threshold
 *      uses an opacity interpolation around that threshold instead of a
 *      hard `minzoom` cut. The result: place names visibly grow in
 *      rather than popping into existence.
 *
 *   5. PROBE FREE SPACE. Point labels (places, POIs) use
 *      `text-variable-anchor` so the renderer can try the centre, top,
 *      bottom and sides before giving up on placement — measurably more
 *      labels survive in dense urban areas.
 *
 * Languages
 * ---------
 * Names prefer Ukrainian (`name:uk`), then English (`name:en`), then the
 * raw `name` field. This makes the map feel native to Ukraine while
 * still being legible to international users.
 *
 * Density profile
 * ---------------
 * The whole module accepts a `density`/cutoff/padding-multiplier bundle
 * coming from src/device.js so phones get a less cluttered map than
 * desktops without changing any per-layer logic. See the {@link
 * LabelOpts} typedef at the bottom of the file.
 */

import { linZoom } from '../utils/interp.js';

const SOURCE = 'openmaptiles';

/** Coalesced name expression: prefer Ukrainian, fall back gracefully. */
const NAME_EXPR = [
  'coalesce',
  ['get', 'name:uk'],
  ['get', 'name:en'],
  ['get', 'name'],
];

/** Halo settings — same in light/dark, only colour varies. */
const halo = (color, width = 1.4) => ({
  'text-halo-color': color,
  'text-halo-width': width,
  'text-halo-blur': 0.4,
});

/**
 * Build a smooth opacity fade-in centred on `atZoom`. The returned pair is
 * `{ renderMinZoom, expr }`: callers should set `minzoom: renderMinZoom` to
 * make MapLibre actually draw labels during the fade.
 *
 * @param {number} atZoom    target zoom at which the label is fully opaque
 * @param {number} maxOpacity peak opacity (defaults to 1.0)
 * @param {number} width     length of the fade in zoom levels
 */
function fadeIn(atZoom, maxOpacity = 1.0, width = 0.5) {
  const start = atZoom - width * 0.5;
  const end = atZoom + width * 0.5;
  return {
    renderMinZoom: start,
    expr: linZoom([
      [start, 0],
      [end, maxOpacity],
    ]),
  };
}

/** Rank-bound filter sugar: `rank ≤ cutoff`. */
const rankCutoffFilter = (cutoff) => [
  '<=',
  ['coalesce', ['get', 'rank'], 5],
  cutoff,
];

/** Combine a primary class filter with the active density rank cutoff. */
function classWithRank(classes, rankCutoff) {
  const classFilter =
    classes.length === 1
      ? ['==', ['get', 'class'], classes[0]]
      : ['in', ['get', 'class'], ['literal', classes]];
  return ['all', classFilter, rankCutoffFilter(rankCutoff)];
}

// ---------------------------------------------------------------------------
// Place labels — countries, regions, cities, towns, villages, neighbourhoods.
// Each tier has its own layer so we can tune minzoom & text-size separately.
// ---------------------------------------------------------------------------

function placeLabels(t, opts) {
  const {
    placeRankCutoff,
    textPaddingMul,
    enableSuburbs,
    enableNeighbourhoods,
    enableHamlets,
    density,
  } = opts;

  /**
   * Internal: build one place layer. `cfg.classes` selects features;
   * `cfg.atZoom` is the centre of the fade-in.
   */
  const place = (id, cfg) => {
    const fade = fadeIn(cfg.atZoom, cfg.opacity ?? 1.0, cfg.fadeWidth ?? 0.6);
    const filter = ['all', classWithRank(cfg.classes, placeRankCutoff)];
    if (cfg.extraFilter) filter.push(cfg.extraFilter);
    return {
      id,
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: fade.renderMinZoom,
      maxzoom: cfg.maxzoom ?? 24,
      filter,
      layout: {
        'text-field': NAME_EXPR,
        'text-font': cfg.font ?? t.font.medium,
        'text-size': cfg.size,
        // Variable anchors give MapLibre more freedom in dense areas. For
        // top-of-hierarchy places we keep the anchor centred so big city
        // names don't drift around as you pan.
        ...(cfg.variableAnchor
          ? {
              'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'],
              'text-justify': 'auto',
              'text-radial-offset': cfg.radialOffset ?? 0.5,
            }
          : {
              'text-anchor': 'center',
              'text-justify': 'center',
            }),
        'text-letter-spacing': cfg.tracking ?? 0.02,
        'text-padding': Math.round((cfg.padding ?? 6) * textPaddingMul),
        'text-max-width': 8,
        'text-transform': cfg.transform ?? 'none',
        // Lower rank = more important; smaller sort-key wins collisions.
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 5],
      },
      paint: {
        'text-color': cfg.color ?? t.textPrimary,
        ...halo(t.textHalo, cfg.haloWidth ?? 1.4),
        'text-opacity': fade.expr,
      },
    };
  };

  const layers = [
    place('label_country', {
      classes: ['country'],
      atZoom: 3,
      maxzoom: 9,
      size: ['interpolate', ['linear'], ['zoom'], 2, 11, 5, 16, 8, 22],
      font: t.font.bold,
      tracking: 0.18,
      transform: 'uppercase',
      haloWidth: 1.6,
    }),
    place('label_state', {
      classes: ['state'],
      atZoom: 5,
      maxzoom: 9,
      size: ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 14],
      font: t.font.medium,
      tracking: 0.1,
      transform: 'uppercase',
      color: t.textSecondary,
    }),
    place('label_city_large', {
      classes: ['city'],
      atZoom: 5,
      size: ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 16, 14, 22, 18, 32],
      font: t.font.bold,
      haloWidth: 1.6,
      padding: 8,
    }),
    place('label_town', {
      classes: ['town'],
      atZoom: 8,
      size: ['interpolate', ['linear'], ['zoom'], 8, 10, 12, 14, 18, 20],
      font: t.font.medium,
      variableAnchor: true,
      radialOffset: 0.4,
    }),
    place('label_village', {
      classes: ['village'],
      atZoom: 11,
      // Density gates the smallest places so phones see fewer of them
      // even when MapLibre's collision system would otherwise fit them.
      ...(density < 0.8
        ? { extraFilter: ['<=', ['coalesce', ['get', 'rank'], 5], placeRankCutoff - 1] }
        : null),
      size: ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 12, 18, 16],
      font: t.font.regular,
      variableAnchor: true,
      radialOffset: 0.4,
    }),
  ];

  if (enableHamlets) {
    layers.push(
      place('label_hamlet', {
        classes: ['hamlet', 'isolated_dwelling'],
        atZoom: 13,
        size: ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11, 20, 14],
        font: t.font.regular,
        color: t.textSecondary,
        opacity: 0.9,
        variableAnchor: true,
        radialOffset: 0.35,
      }),
    );
  }

  if (enableSuburbs) {
    layers.push(
      place('label_suburb', {
        classes: ['suburb', 'quarter'],
        atZoom: 12,
        size: ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12, 20, 15],
        font: t.font.regular,
        tracking: 0.12,
        transform: 'uppercase',
        color: t.textSecondary,
      }),
    );
  }

  if (enableNeighbourhoods) {
    layers.push(
      place('label_neighbourhood', {
        classes: ['neighbourhood'],
        atZoom: 14,
        size: ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 12, 22, 14],
        font: t.font.regular,
        color: t.textSecondary,
        opacity: 0.85,
        variableAnchor: true,
        radialOffset: 0.3,
      }),
    );
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Road labels — names along the line, plus shield-style refs at junctions.
//
// MapLibre's `symbol-placement: line` automatically follows the geometry,
// repeats every `symbol-spacing` pixels, and avoids upside-down rendering.
// ---------------------------------------------------------------------------

function roadLabels(t, opts) {
  const { textPaddingMul } = opts;

  const lineLabel = (id, classes, cfg) => {
    const fade = fadeIn(cfg.atZoom, 1.0, cfg.fadeWidth ?? 0.5);
    return {
      id,
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'transportation_name',
      minzoom: fade.renderMinZoom,
      filter:
        classes.length === 1
          ? ['==', ['get', 'class'], classes[0]]
          : ['in', ['get', 'class'], ['literal', classes]],
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.medium,
        'text-size': cfg.size,
        'symbol-placement': 'line',
        'symbol-spacing': cfg.spacing ?? 250,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'text-letter-spacing': 0.02,
        'text-padding': Math.round(4 * textPaddingMul),
        'text-max-angle': 35,
      },
      paint: {
        'text-color': t.textRoad,
        ...halo(t.textRoadHalo, 1.4),
        'text-opacity': fade.expr,
      },
    };
  };

  return [
    lineLabel('label_road_motorway', ['motorway'], {
      atZoom: 11,
      size: ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13, 20, 16],
      spacing: 350,
    }),
    lineLabel('label_road_trunk_primary', ['trunk', 'primary'], {
      atZoom: 12,
      size: ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13, 20, 16],
    }),
    lineLabel('label_road_secondary_tertiary', ['secondary', 'tertiary'], {
      atZoom: 13,
      size: ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12, 20, 15],
    }),
    lineLabel('label_road_minor', ['minor', 'service'], {
      atZoom: 15,
      size: ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 12, 22, 14],
    }),
    lineLabel('label_road_path', ['path', 'track'], {
      atZoom: 16,
      size: ['interpolate', ['linear'], ['zoom'], 16, 9, 20, 12, 22, 13],
    }),
    // Highway shields — render `ref` (e.g. "M03", "H02", "E40") in a pill.
    {
      id: 'label_road_shield',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'transportation_name',
      minzoom: 7.5,
      filter: [
        'all',
        ['has', 'ref'],
        ['<=', ['get', 'ref_length'], 6],
        ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
      ],
      layout: {
        'text-field': ['get', 'ref'],
        'text-font': t.font.bold,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 11, 22, 14],
        'symbol-placement': 'line',
        'symbol-spacing': 600,
        'text-padding': Math.round(6 * textPaddingMul),
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': t.textHalo,
        'text-halo-color': t.motorwayCasing,
        'text-halo-width': 4,
        'text-halo-blur': 0.0,
        'text-opacity': linZoom([
          [7.5, 0],
          [8, 1],
        ]),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Water labels — lakes, rivers, seas. River names follow the line; lake and
// sea names sit centred on the polygon centroid.
// ---------------------------------------------------------------------------

function waterLabels(t, opts) {
  const { textPaddingMul } = opts;
  const polyFade = fadeIn(4.5, 1.0, 1.0);
  const lineFade = fadeIn(11, 1.0, 0.6);
  return [
    {
      id: 'label_water_polygon',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      minzoom: polyFade.renderMinZoom,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.italic,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 14, 16, 18],
        'text-letter-spacing': 0.05,
        'text-max-width': 8,
        'text-padding': Math.round(4 * textPaddingMul),
      },
      paint: {
        'text-color': t.textWater,
        ...halo(t.textWaterHalo, 1.4),
        'text-opacity': polyFade.expr,
      },
    },
    {
      id: 'label_water_line',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'waterway',
      filter: ['==', ['get', 'class'], 'river'],
      minzoom: lineFade.renderMinZoom,
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.italic,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 18, 14],
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'text-letter-spacing': 0.04,
        'text-max-angle': 28,
        'text-padding': Math.round(3 * textPaddingMul),
      },
      paint: {
        'text-color': t.textWater,
        ...halo(t.textWaterHalo, 1.0),
        'text-opacity': lineFade.expr,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Park labels.
// ---------------------------------------------------------------------------

function parkLabels(t, opts) {
  const { textPaddingMul } = opts;
  const fade = fadeIn(10.5, 1.0, 1.0);
  return [
    {
      id: 'label_park',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'park',
      minzoom: fade.renderMinZoom,
      filter: ['has', 'name'],
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.italic,
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 13, 22, 16],
        'text-max-width': 8,
        'text-padding': Math.round(6 * textPaddingMul),
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 5],
      },
      paint: {
        'text-color': t.textPark,
        ...halo(t.textHalo, 1.2),
        'text-opacity': fade.expr,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// POI — points of interest. We render dots first (rank-filtered for breadth)
// and labels above them (more aggressive rank filter so the canvas doesn't
// turn into alphabet soup). Variable anchors give dense urban areas a much
// higher label survival rate.
// ---------------------------------------------------------------------------

function poiLayers(t, opts) {
  const { poiRankCutoff, poiDotRankCutoff, poiSizeMul, textPaddingMul } = opts;
  const dotFade = fadeIn(14.2, 1.0, 0.8);
  const labelFade = fadeIn(15.2, 1.0, 0.8);
  return [
    {
      id: 'poi_dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: dotFade.renderMinZoom,
      filter: rankCutoffFilter(poiDotRankCutoff),
      paint: {
        'circle-color': t.poiFill,
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          1.6 * poiSizeMul,
          18,
          2.4 * poiSizeMul,
          22,
          3.2 * poiSizeMul,
        ],
        'circle-stroke-color': t.poiHalo,
        'circle-stroke-width': 1.0,
        'circle-opacity': dotFade.expr,
        'circle-stroke-opacity': dotFade.expr,
      },
    },
    {
      id: 'poi_label',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: labelFade.renderMinZoom,
      filter: rankCutoffFilter(poiRankCutoff),
      layout: {
        'text-field': NAME_EXPR,
        'text-font': t.font.regular,
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 12, 22, 14],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.7,
        'text-justify': 'auto',
        'text-padding': Math.round(4 * textPaddingMul),
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 5],
      },
      paint: {
        'text-color': t.textSecondary,
        ...halo(t.textHalo, 1.0),
        'text-opacity': labelFade.expr,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public entry.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LabelOpts
 * @property {number}  [density=1.0]              0.5 (sparse) – 1.0 (full).
 * @property {number}  [placeRankCutoff=12]       Drop place rank > cutoff.
 * @property {number}  [poiRankCutoff=6]          Drop POI labels rank > cutoff.
 * @property {number}  [poiDotRankCutoff=8]       Drop POI dots rank > cutoff.
 * @property {number}  [textPaddingMul=1.0]       Multiplier on text-padding.
 * @property {number}  [poiSizeMul=1.0]           Multiplier on POI dot radius.
 * @property {boolean} [enableNeighbourhoods=true]
 * @property {boolean} [enableHamlets=true]
 * @property {boolean} [enableSuburbs=true]
 */

/**
 * @param {object} t      Theme tokens.
 * @param {LabelOpts} [opts]
 */
export function labelLayers(t, opts = {}) {
  const merged = {
    density: 1.0,
    placeRankCutoff: 12,
    poiRankCutoff: 6,
    poiDotRankCutoff: 8,
    textPaddingMul: 1.0,
    poiSizeMul: 1.0,
    enableNeighbourhoods: true,
    enableHamlets: true,
    enableSuburbs: true,
    ...opts,
  };

  return [
    ...waterLabels(t, merged),
    ...parkLabels(t, merged),
    ...roadLabels(t, merged),
    ...placeLabels(t, merged),
    ...poiLayers(t, merged),
  ];
}
