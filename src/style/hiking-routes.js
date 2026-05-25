/**
 * Hiking-route ribbons — render OSM `route=hiking` relations as
 * continuous coloured ribbons painted UNDER the existing trail glow,
 * so a single named route (Закарпатський ландшафтний шлях, Чорногірський
 * хребет, Нескучна стежка, …) reads as ONE ribbon from start to end
 * regardless of how many `way`s it stitches across.
 *
 * Source: `hiking_route` source-layer of `carpathian-osm.pmtiles`
 * (built by `tools/carpathian-profile.yml` from OSM relations).
 *
 * Stack position (set in src/style/index.js::composeLayers):
 *
 *     hillshade / hypso / texture
 *  ↓  this module                    ← coloured ribbon "underlay"
 *  ↓  carpathian_trail_glow          ← per-trail glow
 *  ↓  carpathian_trail_casing
 *  ↓  carpathian_trail_inline*       ← per-sac_scale dashed inline
 *
 * Source-gated through `carpathianOsm` availability + a feature flag
 * (`FEATURES.hikingRoutes`, default true). Both off → silent no-op,
 * graceful fallback on cold environments.
 *
 * Colour resolution is done ENTIRELY in the style expression — no JS
 * preprocessing, no per-feature transforms. Order:
 *
 *   1. `osmc:symbol` (first segment, the `<waycolour>` field)
 *   2. `colour` (free-form OSM tag)
 *   3. `network` (iwn=red, nwn=blue, rwn=yellow, lwn=green)
 *   4. neutral fallback
 *
 * Two parallel ribbons are emitted per match:
 *
 *   • base ribbon — full width, soft edges (line-blur), opacity ~0.5,
 *     reads as a smooth coloured underlay.
 *   • highlight ribbon (optional, gated by `tokens.hikingRouteHighlight`
 *     when present, otherwise always-on) — ~50 % of the base width,
 *     no blur, lower opacity (~0.35) on top — that's the classic
 *     "double-ribbon" cue you see on the OSM Hiking Map.
 *
 * Multi-route stacking: when two routes share a way, MapLibre paints
 * features in tile order; we additionally drive `line-sort-key` from
 * `rank` (when present) so heavier networks (iwn/nwn) win over local
 * ones at every zoom.
 */

import { CARPATHIAN, FEATURES } from '../config.js';
import { expZoom, linZoom } from '../utils/interp.js';

const CARP_OSM = 'carpathian-osm';
const SOURCE_LAYER = 'hiking_route';

// ---------------------------------------------------------------------------
// osmc:symbol parser — pure helper, no JS preprocessing of features.
//
// `osmc:symbol` is the de-facto standard OSM tag for hiking-route
// way-marking. Format is colon-separated:
//
//   <waycolour>:<background>[:<foreground>[:<foreground2>]]:<textcolour>
//
// Only the first segment (`<waycolour>`) carries the route's "ribbon
// colour"; everything else describes the painted symbol that hangs on
// trees / cairns / signs and is meant for a SYMBOL layer, not the
// ribbon. So we extract segment 0 with `slice` and key into a colour
// match table on the style side.
//
// Pure helper: takes a token bundle, returns a MapLibre `match`
// expression that resolves a route's ribbon colour via the cascade
// described in the file header. No JS-side transformation of feature
// properties — the expression evaluates per-feature on the GPU.
// ---------------------------------------------------------------------------

/**
 * Build the OSMC → palette match expression. Pulls the FIRST segment
 * of `osmc:symbol` (the `<waycolour>` field) and maps it to a token-
 * driven palette. Falls through to `colour`, then `network`, then a
 * neutral.
 *
 * @param {object} t  Resolved token bundle from `getTokens(theme)`.
 * @returns {Array}   MapLibre match expression.
 */
function ribbonColorExpr(t) {
  // Palette per the brief — ten OSMC colour names mapped to project
  // tokens where possible (sacScale.* keeps the trail palette
  // coherent), or to fixed hexes for hues sacScale doesn't carry.
  const sac = t.sacScale;
  const palette = [
    'red',           sac.t4,         // alpine red
    'blue',          '#1e6fb8',
    'green',         sac.t1,         // hiking green
    'yellow',        sac.t2,         // mountain-hiking yellow
    'black',         sac.t6,         // alpine black
    'white',         '#f0f0f0',
    'orange',        '#e07b00',
    'purple',        '#7a3ba0',
    'violet',        '#7a3ba0',
    'brown',         '#8a5a2b',
  ];

  // Network → fallback colour. iwn (international) → red, nwn
  // (national) → blue, rwn (regional) → yellow, lwn (local) → green.
  // Anything else collapses to the neutral.
  const networkFallback = [
    'match',
    ['coalesce', ['get', 'network'], 'lwn'],
    'iwn', sac.t4,
    'nwn', '#1e6fb8',
    'rwn', sac.t2,
    'lwn', sac.t1,
    t.sacScaleNeutral,
  ];

  // `colour` tag fallback — same palette, applied to the raw OSM
  // value when osmc:symbol isn't set.
  const colourTagFallback = [
    'match',
    ['coalesce', ['get', 'colour'], 'none'],
    ...palette,
    networkFallback,
  ];

  // First segment of osmc:symbol — slice up to the first colon. When
  // the tag is missing we synthesise an empty string so the slice
  // result is `''` and falls through the match's default arm.
  const firstSegment = [
    'slice',
    ['coalesce', ['get', 'osmc_symbol'], ''],
    0,
    ['index-of', ':', ['concat', ['coalesce', ['get', 'osmc_symbol'], ''], ':']],
  ];

  return [
    'match',
    firstSegment,
    ...palette,
    colourTagFallback,
  ];
}

// ---------------------------------------------------------------------------
// Geometry curves — base ribbon + highlight overlay.
// ---------------------------------------------------------------------------

/**
 * Width curve of the base ribbon: ~3 px on z9 → ~14 px on z18. The
 * ribbon must read wider than the trail inline (which sits at ~3 px
 * around z16) at every zoom so it visibly underlays the dashed inline.
 *
 * Tuned in pairs with the trail-inline widths in `carpathian.js` — the
 * casing curve there peaks at ~5.8 px @ z16 and ~11.5 px @ z20, so
 * keeping our ribbon at 9 px @ z16 and 14 px @ z18 lands it on the
 * outside of the casing without overpainting it.
 */
const BASE_WIDTH_STOPS = [
  [9, 3],
  [11, 5],
  [13, 7],
  [16, 9],
  [18, 14],
];

/**
 * Soft opacity curve for the base ribbon. Stays UNDER 0.6 even at
 * the peak zoom so the relief beneath remains legible — the brief
 * explicitly asks for the ribbon to read as an underlay, not a paint.
 * Drops back at z20 so deeply zoomed urban / steppe tiles aren't
 * dominated by a flat colour band.
 */
const BASE_OPACITY_STOPS = [
  [9, 0],
  [9.5, 0.45],
  [16, 0.55],
  [20, 0.4],
];

// ---------------------------------------------------------------------------
// Layer factory.
// ---------------------------------------------------------------------------

/**
 * Build the hiking-route ribbon layer specs. Returns an array of
 * MapLibre layer objects: [base ribbon, highlight ribbon, label].
 *
 * Composer in `src/style/index.js` slots this between the relief
 * stack and `carpathian_trail_glow` (see file header). All three
 * layers are gated by feature flag + source availability — when
 * either is missing, the composer skips the call entirely and the
 * style validates / renders as if this module didn't exist.
 *
 * @param {object} t  Token bundle from `getTokens(theme)`.
 * @returns {Array<object>}
 */
export function hikingRouteLayers(t) {
  const z = CARPATHIAN.zoomRules.trails;          // 9 — match trail entry zoom
  const labelZ = CARPATHIAN.zoomRules.trailLabels; // 12 — line-placed labels
  const colour = ribbonColorExpr(t);

  // line-sort-key drives stacking when multiple ribbons share a way:
  // higher rank routes paint on top. Falls back to 0 when the field
  // isn't present in the tile (older builds of carpathian-osm.pmtiles
  // didn't carry `rank` — graceful fallback to undefined ordering,
  // which still works because MapLibre keeps tile-order stable).
  const sortKey = ['coalesce', ['get', 'rank'], 0];

  const baseRibbon = {
    id: 'hiking_route_ribbon',
    type: 'line',
    source: CARP_OSM,
    'source-layer': SOURCE_LAYER,
    minzoom: z,
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-sort-key': sortKey,
    },
    paint: {
      'line-color': colour,
      'line-width': expZoom(BASE_WIDTH_STOPS),
      'line-opacity': linZoom(BASE_OPACITY_STOPS),
      // Soft halo edges — keeps the ribbon from reading as a hard
      // painted stroke. Constant 1.5 px is enough to feather the
      // edges at every zoom without bleeding into adjacent ribbons.
      'line-blur': 1.5,
    },
  };

  // Highlight overlay — same geometry, ~50 % width, lower opacity,
  // no blur. Yields the OSM-Hiking-Map "double-ribbon" effect.
  // Optionally gated by an opt-in token (`tokens.hikingRouteHighlight`)
  // so themes can disable the highlight by setting the token to a
  // falsy value; default behaviour is to always emit it because the
  // brief calls it "(опц., …)" but recommends it for the hiking-map
  // look.
  const highlightEnabled = t.hikingRouteHighlight !== false;
  const highlightRibbon = highlightEnabled
    ? {
        id: 'hiking_route_ribbon_highlight',
        type: 'line',
        source: CARP_OSM,
        'source-layer': SOURCE_LAYER,
        minzoom: z,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'line-sort-key': sortKey,
        },
        paint: {
          'line-color': colour,
          // 50 % of the base width — fold the multiplier into every
          // stop so the top-level operator stays `interpolate`.
          'line-width': expZoom(
            BASE_WIDTH_STOPS.map(([zz, w]) => [zz, w * 0.5]),
          ),
          // Constant 0.35 across the visible band; no blur so the
          // highlight reads as a crisp inner stripe.
          'line-opacity': linZoom([
            [z, 0],
            [z + 0.5, 0.35],
            [20, 0.3],
          ]),
        },
      }
    : null;

  // Label layer — line-placed name with a coloured fill matching the
  // ribbon and a bg-token halo. Sort-key is set so route labels win
  // collisions against generic trail labels (which rank trails by
  // sac_scale starting at 0). We push hiking-route labels to
  // negative values: international routes (iwn) at -3, national
  // (nwn) -2, regional (rwn) -1, local (lwn) 0; falls back to 0 if
  // `network` is missing.
  const label = {
    id: 'hiking_route_label',
    type: 'symbol',
    source: CARP_OSM,
    'source-layer': SOURCE_LAYER,
    minzoom: labelZ,
    filter: [
      'any',
      ['has', 'name:uk'],
      ['has', 'name:en'],
      ['has', 'name'],
      ['has', 'ref'],
    ],
    layout: {
      'text-field': [
        'coalesce',
        ['get', 'name:uk'],
        ['get', 'name:en'],
        ['get', 'name'],
        ['get', 'ref'],
      ],
      'text-font': t.font.bold,
      'text-size': ['interpolate', ['linear'], ['zoom'],
        labelZ - 1, 9,
        16, 13,
      ],
      'symbol-placement': 'line',
      'symbol-spacing': 400,
      'text-pitch-alignment': 'viewport',
      'text-rotation-alignment': 'map',
      'text-letter-spacing': 0.02,
      'text-padding': 4,
      'text-max-angle': 35,
      // Negative sort-keys so we beat the trail-label sort-keys (0..6)
      // and the hazard-label sort-keys (which sit at < -1e6 — way
      // below us) at the collision arbiter.
      'symbol-sort-key': [
        'match',
        ['coalesce', ['get', 'network'], 'lwn'],
        'iwn', -3,
        'nwn', -2,
        'rwn', -1,
        'lwn', 0,
        0,
      ],
    },
    paint: {
      'text-color': colour,
      'text-halo-color': t.bg,
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  };

  return [baseRibbon, ...(highlightRibbon ? [highlightRibbon] : []), label];
}

// ---------------------------------------------------------------------------
// Re-exports for testability — the validator imports the helper to
// double-check the colour cascade compiles cleanly even when no
// composer call is made.
// ---------------------------------------------------------------------------

export { ribbonColorExpr };

/**
 * Capability gate used by the composer. Centralised here so callers
 * don't have to remember which two flags need to AND.
 *
 * @param {object} a
 * @param {boolean} [a.hasCarpathianOsmSource]
 * @param {boolean} [a.featureOn]
 * @returns {boolean}
 */
export function shouldEmitHikingRoutes({ hasCarpathianOsmSource, featureOn }) {
  return Boolean(featureOn && hasCarpathianOsmSource);
}

/** Default feature-flag value, mirrors `FEATURES.hikingRoutes`. */
export const HIKING_ROUTES_DEFAULT_ENABLED = FEATURES.hikingRoutes ?? true;
