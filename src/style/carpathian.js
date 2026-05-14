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

  // Trail widths bumped ~+18% over the previous curve — marked routes
  // are the spine of mountain navigation and now read with the visual
  // weight of a regional road instead of a footpath.
  const casingWidth = expZoom([
    [z, 1.3],
    [13, 2.85],
    [16, 5.45],
    [20, 11.2],
  ]);
  const inlineWidth = expZoom([
    [z, 0.6],
    [13, 1.3],
    [16, 2.6],
    [20, 5.9],
  ]);
  // Glow halo — wide, soft, accent-tinted ring under the casing.
  // Reads as a warm aura so marked trails pop against the forest /
  // hypsometric tint without competing with the readable inline.
  const glowWidth = expZoom([
    [z, 3.0],
    [13, 6.5],
    [16, 11.5],
    [20, 22.0],
  ]);

  return [
    {
      id: 'carpathian_trail_glow',
      type: 'line',
      source: CARP_OSM,
      'source-layer': 'hiking_route',
      minzoom: z,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.trailGlow,
        'line-width': glowWidth,
        'line-blur': 3.0,
        'line-opacity': linZoom([
          [z, 0.0],
          [z + 0.5, 1.0],
        ]),
      },
    },
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

  // Peak marker glow — soft, wide, accent-coloured circle behind the
  // peak symbol. Painted FIRST so it sits below both the marker dot
  // and the label, giving every peak a quiet halo of importance.
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

  // Peak marker — crisp dot above the glow, accent-coloured ring.
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

  // Common layout for the peak label and its glow sibling — keeping them
  // identical means MapLibre's collision system treats them as one
  // unit and they never split apart.
  const peakLayout = {
    'text-field': LABEL_EXPR,
    'text-font': t.font.bold,
    // Peak text size bumped slightly to match the heavier visual
    // weight of the marker + glow stack.
    'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 14, 18, 17],
    'text-anchor': 'top',
    'text-offset': [0, 0.9],
    'text-padding': 6,
    'text-max-width': 8,
    'symbol-sort-key': ['coalesce', ['get', 'rank'], 0],
  };

  // Peak label glow — transparent text + wide blurred accent halo.
  // Painted under the readable peak label so the warm wash extends
  // outward without clobbering legibility.
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
      // Bumped halo width — peak names now read heavier on the busy
      // hypsometric / hillshade canvas.
      'text-halo-width': 2.0,
      'text-halo-blur': 0.5,
    },
  };

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
      // Bumped halo width — passes now read with consistent weight
      // alongside their peak siblings on a dense terrain canvas.
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  };

  // Order matters: glow → marker → label-glow → label so the readable
  // text floats on top of the soft halo plus the accent dot.
  return [peakGlow, peakMarker, peakGlowLabel, peak, passOrSaddleGlow, passOrSaddle];
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
