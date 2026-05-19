/**
 * Carpathian pipeline — region-specific enhancement layers.
 *
 * This module emits overlays keyed off a custom Planetiler-built PMTiles
 * archive (`carpathian-osm` source) and an optional WhiteboxTools-derived
 * ridge/valley vector PMTiles (`ridges` source). Everything here is
 * scoped to features that *don't* exist in upstream OpenMapTiles, so it
 * never conflicts with the country-wide road/place layers.
 *
 * Source-layers expected from the custom Planetiler profile
 * (tools/carpathian-profile.yml):
 *
 *   trail            — every raw highway=path/footway/track/bridleway/
 *                      cycleway/via_ferrata/steps in the bbox, with rich
 *                      OSM attributes: sac_scale, trail_visibility,
 *                      informal, surface, bridge, ladder, ford,
 *                      mtb:scale, via_ferrata_scale, osmc:symbol, ref,
 *                      network, name(:uk|:en).
 *   hiking_route     — relation route=hiking lines (kept for backwards
 *                      compatibility but no longer the primary trail
 *                      data path).
 *   mountain_feature — points: peak, saddle, cliff, pass, spring,
 *                      cave_entrance, alpine_hut, viewpoint, drinking_water,
 *                      shelter, cairn, cross, etc. Tag `class` is the
 *                      discriminator; `rank` is -ele for tall-peak priority.
 *   forest_road      — lines with { tracktype, surface, sac_scale, 4wd_only,
 *                      motor_vehicle, access, oneway }.
 *   ski_piste        — lines
 *   cableway         — lines
 *
 * Ridge overlay source-layer (tools/build-ridges.sh):
 *   ridges           — lines with { type: ridge|valley }
 *
 * Z-order within the module (intra-module, see src/style/index.js for
 * how it interleaves with the rest):
 *
 *   ridges (dark → light)
 *   forest roads (4wd / open / restricted)
 *   informal trails (grey dotted)
 *   marked trails — glow → casing → inline (per sac_scale)
 *   via-ferrata
 *   bridges + ladders + ford symbols
 *   trail labels
 *   carpathianLabels (peaks, passes, mountain POIs)
 */

import { CARPATHIAN } from '../config.js';
import { expZoom, linZoom, inFilter } from '../utils/interp.js';

const CARP_OSM = 'carpathian-osm';
const RIDGES = 'ridges';

// ---------------------------------------------------------------------------
// Ridges — Imhof-style double-stroke enhancement. Two pixel-offset lines
// (dark below, light on top) give the characteristic shaded-ridge feel.
// ---------------------------------------------------------------------------

export function ridgeLayers(t) {
  const z = CARPATHIAN.zoomRules.ridges;
  const ridgeFilter = [
    'any',
    ['!', ['has', 'type']],
    ['==', ['get', 'type'], 'ridge'],
  ];
  const width = expZoom([
    [z, 0.25],
    [10, 0.45],
    [13, 0.8],
    [16, 1.3],
  ]);
  const opacity = linZoom([
    [z, 0],
    [z + 0.5, 0.85],
  ]);

  return [
    {
      id: 'ridge_dark',
      type: 'line',
      source: RIDGES,
      'source-layer': 'ridges',
      minzoom: z,
      filter: ridgeFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.ridgeDark,
        'line-width': width,
        'line-offset': 0.2,
        'line-opacity': opacity,
        'line-blur': 0.3,
      },
    },
    {
      id: 'ridge_light',
      type: 'line',
      source: RIDGES,
      'source-layer': 'ridges',
      minzoom: z,
      filter: ridgeFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.ridgeLight,
        'line-width': width,
        'line-offset': -0.2,
        'line-opacity': opacity,
        'line-blur': 0.3,
      },
    },
  ];
}

// ===========================================================================
// Trails
// ===========================================================================
//
// The trail subsystem reads the new `trail` source-layer (raw OSM ways)
// and emits a layered stack:
//
//   1. forestRoadLayers       — track / 4wd / forestry roads
//   2. informalTrailLayers    — informal=yes social paths (grey dots)
//   3. trailLayers            — marked trails by sac_scale (glow / casing
//                               / inline / dasharray / surface)
//   4. viaFerrataLayers       — via_ferrata serration
//   5. steepStepsLayers       — highway=steps step-imitation hatching
//   6. trailFurnitureLayers   — bridges, ladders, fords as line + symbol
//   7. trailLabels            — name/ref along the line
//
// Helpers below keep the layer factories readable. Every colour comes
// from tokens (no hardcoded hex), every width through expZoom/linZoom.
// ===========================================================================

const COMMON_TRAIL_HIGHWAYS = ['path', 'footway', 'track', 'bridleway', 'cycleway'];

/**
 * SAC-scale → inline colour. Built from tokens.sacScale.* so dark mode
 * resolves automatically. T1 green … T6 black; ungraded marked trails
 * fall back to osmc:symbol or sacScaleNeutral.
 */
function sacInlineColor(t) {
  const sac = t.sacScale;
  return [
    'match',
    ['coalesce', ['get', 'sac_scale'], 'none'],
    'hiking', sac.t1,
    'mountain_hiking', sac.t2,
    'demanding_mountain_hiking', sac.t3,
    'alpine_hiking', sac.t4,
    'demanding_alpine_hiking', sac.t5,
    'difficult_alpine_hiking', sac.t6,
    // No SAC grade → consult osmc:symbol / colour for marked routes
    [
      'match',
      ['coalesce', ['get', 'osmc_symbol'], ['get', 'colour'], 'none'],
      'red', sac.t4,
      'blue', '#1e6fb8',
      'green', sac.t1,
      'yellow', sac.t2,
      'black', sac.t6,
      'white', '#f8f8f8',
      t.sacScaleNeutral,
    ],
  ];
}

/**
 * SAC-scale → halo / dim accent. Used for label halos and the marked-
 * route glow so glow tone matches the inline category.
 */
function sacGlowColor(t) {
  const sac = t.sacScale;
  return [
    'match',
    ['coalesce', ['get', 'sac_scale'], 'none'],
    'hiking', sac.t1,
    'mountain_hiking', sac.t2,
    'demanding_mountain_hiking', sac.t3,
    'alpine_hiking', sac.t4,
    'demanding_alpine_hiking', sac.t5,
    'difficult_alpine_hiking', sac.t6,
    t.sacScaleNeutral,
  ];
}

/**
 * SAC-scale → width factor. Higher grades = thinner, since alpine
 * sections are narrow physical paths. T1/T2 1.0×, T3 0.85×, T4 0.75×,
 * T5 0.7×, T6 0.65×.
 */
const SAC_WIDTH_FACTOR = [
  'match',
  ['coalesce', ['get', 'sac_scale'], 'none'],
  'hiking', 1.0,
  'mountain_hiking', 1.0,
  'demanding_mountain_hiking', 0.85,
  'alpine_hiking', 0.75,
  'demanding_alpine_hiking', 0.7,
  'difficult_alpine_hiking', 0.65,
  0.95,
];

/**
 * Build a zoom-driven interpolation whose per-stop value is the input
 * width pre-multiplied by the per-feature SAC factor. Folding the
 * factor into each stop keeps `['zoom']` as a top-level interpolate
 * input — required by the style spec.
 *
 * @param {Array<[number, number]>} stops [zoom, basePx] pairs.
 */
function sacScaledExpZoom(stops, base = 1.4) {
  const flat = [];
  for (const [z, w] of stops) {
    flat.push(z, ['*', w, SAC_WIDTH_FACTOR]);
  }
  return ['interpolate', ['exponential', base], ['zoom'], ...flat];
}

/**
 * Per-grade visibility opacity. Returns an `interpolate(zoom, …)`
 * where each stop's value is a `match(sac_scale, …)` that gates
 * per-grade fade-ins:
 *   T1 / T2 / unknown  → in by z11
 *   T3                 → in by z12
 *   T4 / T5 / T6       → in by z13
 *
 * Multiplying by a constant is folded into each stop value so the
 * top-level operator stays `interpolate`.
 *
 * @param {number} peak  Final opacity at fully-faded-in zooms.
 */
function sacVisibilityOpacity(peak = 1.0) {
  // Per-grade opacity at four zoom anchors. `none` here is the
  // catch-all for ungraded marked routes; we treat them as T2.
  const at = (vals) => [
    'match',
    ['coalesce', ['get', 'sac_scale'], 'none'],
    'hiking', vals.t1,
    'mountain_hiking', vals.t2,
    'demanding_mountain_hiking', vals.t3,
    'alpine_hiking', vals.t4,
    'demanding_alpine_hiking', vals.t5,
    'difficult_alpine_hiking', vals.t6,
    vals.t2,
  ];
  return [
    'interpolate', ['linear'], ['zoom'],
    10.5, at({ t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0 }),
    11.0, at({ t1: peak, t2: peak, t3: 0, t4: 0, t5: 0, t6: 0 }),
    12.0, at({ t1: peak, t2: peak, t3: peak, t4: 0, t5: 0, t6: 0 }),
    13.0, at({ t1: peak, t2: peak, t3: peak, t4: peak, t5: peak, t6: peak }),
  ];
}

/**
 * trail_visibility tiers and their dasharrays. Each becomes its own
 * inline layer because MapLibre's `line-dasharray` doesn't accept
 * data expressions (it's a zoom-driven property only). Splitting per
 * visibility tier is also better for the GPU than a single layer with
 * a per-feature dash chooser would have been — fewer batches at every
 * zoom break.
 */
const TRAIL_VISIBILITY_TIERS = [
  { id: 'excellent', dash: null,   match: ['excellent'] }, // solid
  { id: 'good',      dash: [4, 1], match: ['good'] },
  { id: 'intermediate', dash: [3, 2], match: ['intermediate'] },
  { id: 'bad',       dash: [2, 2], match: ['bad'] },
  { id: 'horrible',  dash: [1, 2], match: ['horrible'] },
  { id: 'no',        dash: [1, 3], match: ['no'] },
];

/** Filter: marked trails (anything with a network or osmc symbol). */
function markedTrailFilter() {
  return [
    'any',
    ['has', 'network'],
    ['has', 'osmc_symbol'],
    ['has', 'colour'],
    ['has', 'ref'],
  ];
}

/** Filter: not informal — exclude `informal=yes`. */
function notInformalFilter() {
  return ['!=', ['coalesce', ['get', 'informal'], 'no'], 'yes'];
}

// ---------------------------------------------------------------------------
// Forest / unsealed mountain roads — drawn from the `forest_road` source
// layer (track/unclassified/path geometries with surface + 4wd flags).
// Comes first so marked trails paint on top.
// ---------------------------------------------------------------------------

export function forestRoadLayers(t) {
  const z = CARPATHIAN.zoomRules.forestRoads;
  const opacity = linZoom([
    [z, 0],
    [z + 0.5, 0.85],
  ]);
  const width = expZoom([
    [z, 0.4],
    [13, 0.9],
    [15, 2.0],
    [18, 4.5],
    [22, 9],
  ]);
  return [
    // 4wd-only / restricted forestry roads — dashed brown.
    {
      id: 'carpathian_forest_road_4wd',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'forest_road',
      minzoom: z,
      filter: [
        'any',
        ['==', ['coalesce', ['get', '4wd_only'], 'no'], 'yes'],
        ['==', ['coalesce', ['get', 'access'], 'yes'], 'forestry'],
        ['==', ['coalesce', ['get', 'motor_vehicle'], 'yes'], 'forestry'],
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.pathCasing,
        'line-width': width,
        'line-dasharray': ['literal', [3, 2]],
        'line-opacity': opacity,
      },
    },
    // Generic forestry / track. Soft, low-contrast.
    {
      id: 'carpathian_forest_road',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'forest_road',
      minzoom: z,
      filter: [
        'all',
        ['!=', ['coalesce', ['get', '4wd_only'], 'no'], 'yes'],
        ['!=', ['coalesce', ['get', 'access'], 'yes'], 'forestry'],
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.track,
        'line-width': width,
        'line-dasharray': ['literal', [4, 2]],
        'line-opacity': opacity,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Informal trails — `informal=yes`, no marking. Tiny grey dots.
// ---------------------------------------------------------------------------

export function informalTrailLayers(t) {
  const z = CARPATHIAN.zoomRules.informalTrails;
  return [
    {
      id: 'carpathian_trail_informal',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: [
        'all',
        inFilter('highway', COMMON_TRAIL_HIGHWAYS),
        ['==', ['coalesce', ['get', 'informal'], 'no'], 'yes'],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.trailInformal,
        'line-width': expZoom([
          [z, 0.4],
          [15, 0.9],
          [18, 1.6],
        ]),
        'line-dasharray': ['literal', [1, 2.5]],
        'line-opacity': linZoom([
          [z, 0],
          [z + 0.5, 0.7],
        ]),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Marked / graded trails — the heart of the enhancement.
// ---------------------------------------------------------------------------

export function trailLayers(t) {
  const z = CARPATHIAN.zoomRules.trails;

  // Each curve folds the per-feature SAC factor into every stop so
  // `['zoom']` stays the top-level `interpolate` input.
  const inlineWidth = sacScaledExpZoom([
    [z, 0.6],
    [13, 1.4],
    [16, 2.8],
    [20, 6.2],
  ]);
  const casingWidth = sacScaledExpZoom([
    [z, 1.4],
    [13, 3.0],
    [16, 5.6],
    [20, 11.5],
  ]);
  const glowWidth = sacScaledExpZoom([
    [z, 3.0],
    [13, 6.5],
    [16, 11.5],
    [20, 22.0],
  ]);

  // Trail filter: any of the common path-like highways AND not informal.
  const baseFilter = [
    'all',
    inFilter('highway', COMMON_TRAIL_HIGHWAYS),
    notInformalFilter(),
  ];

  const layers = [
    // Glow — only for MARKED routes (network/osmc/ref present) so the
    // canvas isn't drowned in halos under every social trail.
    {
      id: 'carpathian_trail_glow',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: ['all', ...baseFilter.slice(1), markedTrailFilter()],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': sacGlowColor(t),
        'line-width': glowWidth,
        'line-blur': 3.0,
        'line-opacity': sacVisibilityOpacity(0.45),
      },
    },
    // Casing — light halo behind every (non-informal) trail.
    {
      id: 'carpathian_trail_casing',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: baseFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.carpathianTrailCasing,
        'line-width': casingWidth,
        'line-opacity': sacVisibilityOpacity(0.85),
      },
    },
  ];

  // Inline — one layer per trail_visibility tier. MapLibre disallows
  // data-driven `line-dasharray`, so we shard. The 'excellent' tier
  // is emitted as the canonical inline (no `_excellent` suffix) so any
  // external smoke-test relying on the layer id keeps working; the
  // others get explicit suffixes.
  //
  // The 'excellent' tier filter ALSO accepts features without a
  // `trail_visibility` tag — that's the most common case (most marked
  // routes don't carry the tag) and we don't want them invisible.
  for (const tier of TRAIL_VISIBILITY_TIERS) {
    const tierFilter = [...baseFilter];
    if (tier.id === 'excellent') {
      tierFilter.push([
        'any',
        ['!', ['has', 'trail_visibility']],
        ['==', ['get', 'trail_visibility'], 'excellent'],
      ]);
    } else {
      tierFilter.push(['==', ['get', 'trail_visibility'], tier.id]);
    }

    const id = tier.id === 'excellent'
      ? 'carpathian_trail_inline'
      : `carpathian_trail_inline_${tier.id}`;
    const paint = {
      'line-color': sacInlineColor(t),
      'line-width': inlineWidth,
      'line-opacity': sacVisibilityOpacity(0.95),
    };
    if (tier.dash) paint['line-dasharray'] = ['literal', tier.dash];

    layers.push({
      id,
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: tierFilter,
      layout: { 'line-cap': tier.dash ? 'butt' : 'round', 'line-join': 'round' },
      paint,
    });
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Via-ferrata — black serration over the trail inline.
// ---------------------------------------------------------------------------

export function viaFerrataLayers(t) {
  const z = CARPATHIAN.zoomRules.viaFerrata;
  const inlineWidth = expZoom([
    [z, 0.8],
    [16, 2.0],
    [20, 4.5],
  ]);
  // Serration sits on top — same shape, ~40 % thicker so the dashes
  // visibly bracket the red inline.
  const serrationWidth = expZoom([
    [z, 1.1],
    [16, 2.8],
    [20, 6.3],
  ]);
  return [
    // Red base inline — same colour family as alpine trails so via-
    // ferratas read consistent with a T4/T5 grade.
    {
      id: 'carpathian_via_ferrata_inline',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: ['==', ['get', 'highway'], 'via_ferrata'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.sacScale.t4,
        'line-width': inlineWidth,
        'line-opacity': linZoom([
          [z, 0],
          [z + 0.5, 1],
        ]),
      },
    },
    // Black serration — thin dashed line over the red.
    {
      id: 'carpathian_via_ferrata_serration',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: ['==', ['get', 'highway'], 'via_ferrata'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.trailViaFerrata,
        'line-width': serrationWidth,
        'line-dasharray': ['literal', [1, 2]],
        'line-opacity': linZoom([
          [z, 0],
          [z + 0.5, 0.9],
        ]),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// highway=steps — frequent perpendicular hatching imitating stairs.
// ---------------------------------------------------------------------------

export function steepStepsLayers(t) {
  const z = 14;
  const stepsWidth = expZoom([
    [z, 1.0],
    [17, 2.2],
    [20, 4.5],
  ]);
  // Casing is a separate curve at 2× the inline so the casing reads
  // as a structural plank under the perpendicular hatching.
  const casingWidth = expZoom([
    [z, 2.0],
    [17, 4.4],
    [20, 9.0],
  ]);
  return [
    {
      id: 'carpathian_trail_steps_casing',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: ['==', ['get', 'highway'], 'steps'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.carpathianTrailCasing,
        'line-width': casingWidth,
        'line-opacity': 0.85,
      },
    },
    {
      id: 'carpathian_trail_steps',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: ['==', ['get', 'highway'], 'steps'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.sacScale.t6,
        'line-width': stepsWidth,
        // Tight perpendicular dash imitates the step risers.
        'line-dasharray': ['literal', [0.6, 0.6]],
        'line-opacity': 0.95,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Trail furniture — bridges (white perpendicular hatching) + ladders + fords.
// ---------------------------------------------------------------------------

export function trailFurnitureLayers(t) {
  const bridgeMinzoom = 14;
  const bridgeWidth = expZoom([
    [bridgeMinzoom, 1.6],
    [17, 3.6],
    [20, 7.5],
  ]);
  // Ladder is ~60 % of bridge width — narrower hatching imitates rungs.
  const ladderWidth = expZoom([
    [bridgeMinzoom, 1.0],
    [17, 2.2],
    [20, 4.5],
  ]);
  return [
    // Bridge — extra-wide white casing imitates a structural plank.
    {
      id: 'carpathian_trail_bridge',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: bridgeMinzoom,
      filter: ['==', ['coalesce', ['get', 'bridge'], 'no'], 'yes'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.trailBridge,
        'line-width': bridgeWidth,
        'line-opacity': 0.95,
      },
    },
    // Ladder — repeated short hatch.
    {
      id: 'carpathian_trail_ladder',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: 15,
      filter: ['==', ['coalesce', ['get', 'ladder'], 'no'], 'yes'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.sacScale.t6,
        'line-width': ladderWidth,
        'line-dasharray': ['literal', [0.4, 0.4]],
        'line-opacity': 0.9,
      },
    },
    // Ford symbol along the line.
    {
      id: 'carpathian_trail_ford',
      type: 'symbol',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: 14,
      filter: [
        'all',
        ['has', 'ford'],
        ['!=', ['coalesce', ['get', 'ford'], 'no'], 'no'],
      ],
      layout: {
        'text-field': '~',
        'text-font': t.font.bold,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 16],
        'symbol-placement': 'line',
        'symbol-spacing': 60,
        'text-pitch-alignment': 'viewport',
        'text-rotation-alignment': 'viewport',
      },
      paint: {
        'text-color': t.textWater,
        'text-halo-color': t.textWaterHalo,
        'text-halo-width': 1.6,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Trail labels — name / ref along the line, with via-ferrata grade suffix.
// ---------------------------------------------------------------------------

export function trailLabels(t) {
  const z = CARPATHIAN.zoomRules.trailLabels;
  const labelExpr = [
    'case',
    // via-ferrata: suffix the K-grade if present
    ['==', ['get', 'highway'], 'via_ferrata'],
    [
      'case',
      ['has', 'via_ferrata_scale'],
      [
        'concat',
        [
          'coalesce',
          ['get', 'name:uk'],
          ['get', 'name:en'],
          ['get', 'name'],
          ['get', 'ref'],
          'via ferrata',
        ],
        ' (',
        ['get', 'via_ferrata_scale'],
        ')',
      ],
      [
        'coalesce',
        ['get', 'name:uk'],
        ['get', 'name:en'],
        ['get', 'name'],
        ['get', 'ref'],
        'via ferrata',
      ],
    ],
    // Otherwise: ref preferred, name fallback.
    [
      'coalesce',
      ['get', 'ref'],
      ['get', 'name:uk'],
      ['get', 'name:en'],
      ['get', 'name'],
    ],
  ];
  return [
    {
      id: 'carpathian_trail_label',
      type: 'symbol',
      source: CARP_OSM,
      'source-layer': 'trail',
      minzoom: z,
      filter: [
        'all',
        inFilter('highway', [...COMMON_TRAIL_HIGHWAYS, 'via_ferrata']),
        ['any', ['has', 'name'], ['has', 'name:uk'], ['has', 'name:en'], ['has', 'ref']],
        notInformalFilter(),
      ],
      layout: {
        'text-field': labelExpr,
        'text-font': t.font.bold,
        'text-size': ['interpolate', ['linear'], ['zoom'], z, 9, 16, 12, 20, 14],
        'symbol-placement': 'line',
        'symbol-spacing': 250,
        'text-pitch-alignment': 'viewport',
        'text-rotation-alignment': 'map',
        'text-letter-spacing': 0.02,
        'text-padding': 4,
        'text-max-angle': 35,
        'symbol-sort-key': [
          // Ranked by SAC severity so alpine routes win collisions over
          // T1 strolls. Lower sort-key = higher priority.
          'match',
          ['coalesce', ['get', 'sac_scale'], 'none'],
          'difficult_alpine_hiking', 0,
          'demanding_alpine_hiking', 1,
          'alpine_hiking', 2,
          'demanding_mountain_hiking', 3,
          'mountain_hiking', 4,
          'hiking', 5,
          6,
        ],
      },
      paint: {
        'text-color': sacGlowColor(t),
        'text-halo-color': t.carpathianTrailCasing,
        'text-halo-width': 1.6,
        'text-halo-blur': 0.4,
      },
    },
  ];
}

// ===========================================================================
// Mountain feature labels & POI markers
// ===========================================================================
//
// Source-layer `mountain_feature` is a heterogeneous point layer keyed by
// `class`. The legacy peak / pass / saddle treatment lives in
// carpathianLabels(); the new POI marker tier (alpine_hut, spring,
// cave_entrance, viewpoint, cairn, …) is folded into the same export so
// callers don't need a second wiring step.
// ===========================================================================

const NAME_EXPR = [
  'coalesce',
  ['get', 'name:uk'],
  ['get', 'name:en'],
  ['get', 'name'],
];

const ELE_EXPR = ['concat', ['to-string', ['get', 'ele']], ' м'];
const LABEL_EXPR = [
  'format',
  NAME_EXPR, { 'font-scale': 1.0 },
  '\n', {},
  ELE_EXPR, { 'font-scale': 0.75 },
];

/**
 * Build a (marker glow + dot + name label) triple for a mountain POI
 * class. Returned as an array of layers in correct paint order.
 *
 * `dotRadius` is supplied as raw [zoom, px] stops so we can derive a
 * separate (larger) glow curve without nesting `['zoom']` inside an
 * arithmetic op — required by the style spec.
 */
function mountainPoiTriple(t, opts) {
  const {
    id, classes, minzoom,
    color, glowColor,
    dotStops = [[12, 2.0], [16, 3.4], [20, 5.0]],
    labelText = '?',
    labelSize = ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 11, 20, 13],
    sortBoost = 0,
  } = opts;

  const filter = inFilter('class', classes);
  const sortKey = ['+', sortBoost, ['coalesce', ['get', 'rank'], 0]];

  // Build dot + glow radius interpolations directly from stops so
  // each stays a clean top-level interpolate(zoom, …).
  const dotRadius = ['interpolate', ['linear'], ['zoom'],
    ...dotStops.flatMap(([z, r]) => [z, r]),
  ];
  const glowRadius = ['interpolate', ['linear'], ['zoom'],
    ...dotStops.flatMap(([z, r]) => [z, r * 2.5]),
  ];

  return [
    // Glow halo.
    {
      id: `${id}_glow`,
      type: 'circle',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      paint: {
        'circle-color': glowColor,
        'circle-radius': glowRadius,
        'circle-blur': 1.0,
        'circle-opacity': 0.7,
      },
    },
    // Symbol with a small text glyph + the place name.
    {
      id: `${id}_marker`,
      type: 'symbol',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      layout: {
        'text-field': [
          'format',
          labelText, { 'font-scale': 1.0 },
          ' ', {},
          NAME_EXPR, { 'font-scale': 0.85 },
        ],
        'text-font': t.font.bold,
        'text-size': labelSize,
        'text-anchor': 'left',
        'text-offset': [0.6, 0],
        'text-padding': 5,
        'text-max-width': 8,
        'symbol-sort-key': sortKey,
      },
      paint: {
        'text-color': color,
        'text-halo-color': t.textHalo,
        'text-halo-width': 1.6,
        'text-halo-blur': 0.4,
      },
    },
    // Crisp dot above the glow so the POI reads even before its label fades in.
    {
      id,
      type: 'circle',
      source: CARP_OSM,
      'source-layer': 'mountain_feature',
      minzoom,
      filter,
      paint: {
        'circle-color': color,
        'circle-radius': dotRadius,
        'circle-stroke-color': t.textHalo,
        'circle-stroke-width': 1.0,
        'circle-opacity': 1.0,
      },
    },
  ];
}

export function carpathianLabels(t) {
  const { zoomRules } = CARPATHIAN;

  // ---- Peaks ---------------------------------------------------------
  const peakGlow = {
    id: 'carpathian_peak_glow',
    type: 'circle',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: zoomRules.peaks,
    filter: ['==', ['get', 'class'], 'peak'],
    paint: {
      'circle-color': t.peakMarkerGlow,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 12, 9, 18, 14],
      'circle-blur': 1.0,
      'circle-opacity': 1.0,
    },
  };

  const peakMarker = {
    id: 'carpathian_peak_marker',
    type: 'circle',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: zoomRules.peaks,
    filter: ['==', ['get', 'class'], 'peak'],
    paint: {
      'circle-color': t.peakMarker,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.6, 12, 2.6, 18, 4.2],
      'circle-stroke-color': t.textPeakHalo,
      'circle-stroke-width': 1.2,
      'circle-opacity': 1.0,
      'circle-stroke-opacity': 1.0,
    },
  };

  const peakLayout = {
    'text-field': LABEL_EXPR,
    'text-font': t.font.bold,
    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 14, 18, 17],
    'text-anchor': 'top',
    'text-offset': [0, 0.9],
    'text-padding': 6,
    'text-max-width': 8,
    'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
  };

  const peakGlowLabel = {
    id: 'label_peak_glow',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: zoomRules.peaks,
    filter: ['==', ['get', 'class'], 'peak'],
    layout: peakLayout,
    paint: {
      'text-color': 'rgba(0,0,0,0)',
      'text-halo-color': t.textPeakGlow,
      'text-halo-width': 4.0,
      'text-halo-blur': 2.5,
    },
  };

  const peak = {
    id: 'label_peak',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: zoomRules.peaks,
    filter: ['==', ['get', 'class'], 'peak'],
    layout: peakLayout,
    paint: {
      'text-color': t.textPeak,
      'text-halo-color': t.textPeakHalo,
      'text-halo-width': 2.0,
      'text-halo-blur': 0.5,
    },
  };

  // ---- Passes / saddles ---------------------------------------------
  const passLayout = {
    'text-field': LABEL_EXPR,
    'text-font': t.font.italic,
    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 12, 20, 14],
    'text-anchor': 'center',
    'text-padding': 4,
    'text-max-width': 8,
    'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
  };

  const passOrSaddleGlow = {
    id: 'label_pass_saddle_glow',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: Math.min(zoomRules.passes, zoomRules.saddles),
    filter: inFilter('class', ['pass', 'saddle']),
    layout: passLayout,
    paint: {
      'text-color': 'rgba(0,0,0,0)',
      'text-halo-color': t.textPeakGlow,
      'text-halo-width': 3.2,
      'text-halo-blur': 2.0,
    },
  };

  const passOrSaddle = {
    id: 'label_pass_saddle',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: Math.min(zoomRules.passes, zoomRules.saddles),
    filter: inFilter('class', ['pass', 'saddle']),
    layout: passLayout,
    paint: {
      'text-color': t.textPass,
      'text-halo-color': t.textPassHalo,
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  };

  // ---- Mountain POIs ------------------------------------------------
  // Each tier's minzoom = zoomRules.mountainPoi by default; we offset
  // a little for the densest ones (drinking_water/toilets) so the
  // canvas isn't drowned at z12.
  const poiZ = zoomRules.mountainPoi;

  // Huts & shelters — house glyph (🏠 fallback to "△").
  const huts = mountainPoiTriple(t, {
    id: 'carpathian_poi_hut',
    classes: ['alpine_hut', 'wilderness_hut', 'shelter'],
    minzoom: poiZ,
    color: t.sacScale.t4,
    glowColor: t.peakMarkerGlow,
    labelText: '⌂',
    sortBoost: 0,
  });

  // Springs & drinking water — droplet symbol.
  const springs = mountainPoiTriple(t, {
    id: 'carpathian_poi_spring',
    classes: ['spring', 'drinking_water'],
    minzoom: poiZ + 1,
    color: t.textWater,
    glowColor: t.peakMarkerGlow,
    labelText: '◊',
    sortBoost: 100,
  });

  // Caves.
  const caves = mountainPoiTriple(t, {
    id: 'carpathian_poi_cave',
    classes: ['cave_entrance'],
    minzoom: poiZ,
    color: t.sacScale.t6,
    glowColor: t.peakMarkerGlow,
    labelText: 'C',
    sortBoost: 50,
  });

  // Viewpoints.
  const viewpoints = mountainPoiTriple(t, {
    id: 'carpathian_poi_viewpoint',
    classes: ['viewpoint'],
    minzoom: poiZ,
    color: t.sacScale.t3,
    glowColor: t.peakMarkerGlow,
    labelText: '◉',
    sortBoost: 25,
  });

  // Cairns / crosses — small accent dot, late zoom.
  const cairns = mountainPoiTriple(t, {
    id: 'carpathian_poi_cairn',
    classes: ['cairn', 'cross', 'wayside_shrine'],
    minzoom: poiZ + 2,
    color: t.textPass,
    glowColor: t.textPeakGlow,
    labelText: '✚',
    dotStops: [[14, 1.6], [18, 2.8]],
    sortBoost: 200,
  });

  // Order: glow → marker → label-glow → label, then mountain POIs.
  return [
    peakGlow, peakMarker, peakGlowLabel, peak,
    passOrSaddleGlow, passOrSaddle,
    ...huts,
    ...viewpoints,
    ...caves,
    ...springs,
    ...cairns,
  ];
}

// ---------------------------------------------------------------------------
// Cableways & ski pistes — thin auxiliaries for high-zoom mountain detail.
// ---------------------------------------------------------------------------

export function cablewayLayers(t) {
  const z = CARPATHIAN.zoomRules.cableways;
  return [
    {
      id: 'cableway',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'cableway',
      minzoom: z,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': t.textSecondary,
        'line-width': expZoom([
          [z, 0.6],
          [15, 1.2],
          [18, 2.0],
        ]),
        'line-dasharray': ['literal', [3, 3]],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'ski_piste',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'ski_piste',
      minzoom: CARPATHIAN.zoomRules.skiPistes,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.ice,
        'line-width': expZoom([
          [CARPATHIAN.zoomRules.skiPistes, 1.2],
          [16, 2.8],
          [20, 6],
        ]),
        'line-opacity': 0.85,
      },
    },
  ];
}
