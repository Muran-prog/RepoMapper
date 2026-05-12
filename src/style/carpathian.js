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
 *   hiking_route     — lines with { osmc_symbol, network, ref, name }
 *   mountain_feature — points with { class: peak|saddle|cliff|pass, ele, name, prominence }
 *   forest_road      — lines with { tracktype, surface, sac_scale, trail_visibility, name }
 *   ski_piste        — lines
 *   cableway         — lines
 *
 * Ridge overlay source-layer (tools/build-ridges.sh):
 *
 *   ridges           — lines with { type: ridge|valley } (latter optional)
 *
 * Z-order within the module:
 *   ridges (dark → light)  — below everything
 *   trails (casing → dash) — above roads (composeLayers interleaves)
 *   carpathianLabels       — above all labels
 */

import { CARPATHIAN } from '../config.js';
import { expZoom, linZoom, inFilter } from '../utils/interp.js';

const CARP_OSM = 'carpathian-osm';
const RIDGES = 'ridges';

// ---------------------------------------------------------------------------
// Ridges — Imhof-style double-stroke enhancement. Two pixel-offset lines
// (dark below, light on top) give the characteristic shaded-ridge feel.
// MapLibre's `line-offset` is expressed in the same units as line-width,
// so the offsets scale with zoom automatically.
// ---------------------------------------------------------------------------

/**
 * @param {object} t
 * @returns {Array<object>}
 */
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

// ---------------------------------------------------------------------------
// Hiking trails — light halo (casing) + dashed red inline. Colour and
// dashing come from tokens so dark theme can invert appropriately.
// ---------------------------------------------------------------------------

/**
 * Colour an OSM-CN (osmc_symbol) colour code if present. We recognise
 * the six most common trail colours and fall back to the theme's dim
 * red for anything else. This only drives the inline colour; the casing
 * stays neutral.
 */
function trailInlineColor(t) {
  return [
    'match',
    ['coalesce', ['get', 'osmc_symbol'], ['get', 'colour'], 'red'],
    'red', t.carpathianTrail,
    'blue', '#1e6fb8',
    'green', '#2f8b3d',
    'yellow', '#e4b02e',
    'black', '#2a2a2a',
    'white', '#f8f8f8',
    t.carpathianTrailDim,
  ];
}

export function trailLayers(t) {
  const z = CARPATHIAN.zoomRules.trails;

  const casingWidth = expZoom([
    [z, 1.1],
    [13, 2.4],
    [16, 4.6],
    [20, 9.5],
  ]);
  const inlineWidth = expZoom([
    [z, 0.5],
    [13, 1.1],
    [16, 2.2],
    [20, 5.0],
  ]);

  return [
    {
      id: 'carpathian_trail_casing',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'hiking_route',
      minzoom: z,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.carpathianTrailCasing,
        'line-width': casingWidth,
        'line-opacity': linZoom([
          [z, 0.0],
          [z + 0.5, 0.85],
        ]),
      },
    },
    {
      id: 'carpathian_trail_inline',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'hiking_route',
      minzoom: z,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': trailInlineColor(t),
        'line-width': inlineWidth,
        'line-dasharray': ['literal', [2, 1.5]],
        'line-opacity': 0.95,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Carpathian labels — peaks, passes, saddles with elevation. Priority
// sorting via symbol-sort-key (negative rank so taller peaks win; this
// assumes the Planetiler profile sets `rank = 10000 - ele` for sortable
// descending order, see tools/carpathian-profile.yml).
// ---------------------------------------------------------------------------

const NAME_EXPR = [
  'coalesce',
  ['get', 'name:uk'],
  ['get', 'name:en'],
  ['get', 'name'],
];

/** Format elevation as "1234 м" where the value is the `ele` prop. */
const ELE_EXPR = ['concat', ['to-string', ['get', 'ele']], ' м'];

/** Two-line label: name on top, elevation below (via \n). */
const LABEL_EXPR = ['format', NAME_EXPR, { 'font-scale': 1.0 }, '\n', {}, ELE_EXPR, { 'font-scale': 0.75 }];

export function carpathianLabels(t) {
  const { zoomRules } = CARPATHIAN;

  const peak = {
    id: 'label_peak',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: zoomRules.peaks,
    filter: ['==', ['get', 'class'], 'peak'],
    layout: {
      'text-field': LABEL_EXPR,
      'text-font': t.font.bold,
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 12, 13, 18, 16],
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
      'text-padding': 6,
      'text-max-width': 8,
      // Lower sort-key wins collisions in MapLibre — feed rank directly.
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
    },
    paint: {
      'text-color': t.textPeak,
      'text-halo-color': t.textPeakHalo,
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  };

  const passOrSaddle = {
    id: 'label_pass_saddle',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': 'mountain_feature',
    minzoom: Math.min(zoomRules.passes, zoomRules.saddles),
    filter: inFilter('class', ['pass', 'saddle']),
    layout: {
      'text-field': LABEL_EXPR,
      'text-font': t.font.italic,
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 12, 20, 14],
      'text-anchor': 'center',
      'text-padding': 4,
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
    },
    paint: {
      'text-color': t.textPass,
      'text-halo-color': t.textPassHalo,
      'text-halo-width': 1.2,
      'text-halo-blur': 0.3,
    },
  };

  return [peak, passOrSaddle];
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
