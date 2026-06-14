/**
 * Settlement outlines — heavy, road-style boundary strokes around
 * villages, towns, cities, and hamlets.
 *
 * Why this exists
 * ---------------
 * The base style fills `landuse=residential` polygons with a soft
 * cream so urban land reads at high zoom (see `base.js::landuse_residential`).
 * That treatment is invisible at country-overview zooms — at z4-z7 a
 * village is a 1-2 px speck against a forested background, so the eye
 * loses populated places exactly when it most needs them as orientation
 * anchors. This module mirrors the road glow → casing → inline paint
 * pattern from `roads.js` and applies it to the BOUNDARY of those
 * residential polygons, giving every settlement the same heavy visual
 * presence as a major road. The result: a town reads as a framed plot
 * the moment its centre dot does, not five zoom levels later.
 *
 * Approach
 * --------
 * OMT exposes settlement land via the `landuse` source-layer. We pick
 * up `class` ∈ {residential, suburb, quarter, neighbourhood} so the
 * outline catches whatever the upstream tile schema happens to emit
 * (residential is the primary signal; the rest fill in dense urban
 * cores where suburbs / quarters carry the polygon).
 *
 * Four `line` layers are emitted per call, painted in this order:
 *
 *   1. glow_outer  — very wide, heavily blurred, low alpha. The
 *                    ambient amber-equivalent wash that says
 *                    "settlement nearby" before the eye resolves
 *                    the boundary itself.
 *   2. glow_inner  — tighter, moderate blur, higher alpha. The
 *                    visible heat ring at the boundary edge.
 *   3. casing      — the thick dark frame, opaque enough to read
 *                    on every theme.
 *   4. inline      — the bright core stroke that gives the casing
 *                    its highlight.
 *
 * Width curve mirrors the motorway curve in `roads.js`: visible from
 * z4 (~2 px total stroke), aggressive growth into city zooms
 * (~14 px at z14, ~50 px at z22). Per the brief the outline must
 * read "without zoom" — these stops put settlements at the same
 * visual weight as a primary road at every zoom band.
 *
 * Palette choice
 * --------------
 * A deep violet accent (`settlementInline` / `settlementCasing` and
 * the matching glow tokens). Roads already own amber, trails own red,
 * cliffs own teal, hazards own magenta + tangerine, forests own
 * green. Violet is unclaimed in this style system, so a settlement
 * outline reads as its own tier in the cartographic hierarchy
 * without colliding with any existing accent.
 *
 * Z-order
 * -------
 * The composer in `index.js` slots this stack BETWEEN the aeroway
 * layer (step 14) and the road stack (step 15). That keeps the heavy
 * outline above every base / landcover / landuse fill (so the wash
 * isn't buried) but BELOW roads (so the road network keeps painting
 * cleanly across settlement boundaries at high zoom). At low zooms
 * roads are thin lines, so the violet frame is the dominant signal
 * — exactly what the brief asks for.
 *
 * Toggleable
 * ----------
 * Gated by `FEATURES.settlementOutline`. Default ON. The composer
 * skips the entire stack when the flag is off, so the four layers
 * don't even reach MapLibre. UI toggle lives in the Layers panel.
 */

import { expZoom, casingWidth, inFilter } from '../utils/interp.js';
import { SETTLEMENTS_SUPPLEMENT_SOURCE } from './settlements-supplement.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE = 'openmaptiles';
const LAYER = 'landuse';

/**
 * Point source-layer carrying populated-place markers. Small villages,
 * hamlets and isolated dwellings frequently DO NOT have a
 * `landuse=residential` polygon in the upstream OMT tiles — they exist
 * only as a single `place` point. The polygon-boundary stack above can
 * therefore never frame them (there is no geometry to stroke), so the
 * brief's "every settlement reads without zoom" goal silently fails for
 * exactly the smallest places. The circle-ring stack below closes that
 * gap: it draws the same violet frame as a ring around the place POINT,
 * so a hamlet with no polygon still gets a visible settlement outline.
 */
const PLACE_LAYER = 'place';

/**
 * Place classes treated as "small settlements that need a point-ring".
 * We intentionally include `town` as well — a small town can also lack a
 * residential polygon — but exclude `city` (cities always carry a polygon
 * and a ring around them would clutter the overview).
 *
 * `locality` is included too: many Carpathian tourist bases, trailheads
 * and named spots (e.g. Заросляк at the foot of Hoverla) are mapped in
 * OSM as `place=locality` — a NAMED point with no population and usually
 * no residential polygon. Without it such hubs get no frame at all. To
 * avoid cluttering the overview with every minor урочище / поляна, the
 * `locality` ring is gated to z11+ via `PLACE_MINZOOM_BY_CLASS` and
 * drawn at a smaller radius than a hamlet (see `ringRadiusByClass`).
 */
const PLACE_CLASSES = ['town', 'village', 'hamlet', 'isolated_dwelling', 'locality'];

/**
 * Per-class minimum zoom for the point ring. Most settlement classes
 * ride the radius curve (which returns 0 px below their useful band),
 * but `locality` is noisy at country-overview zoom, so we hard-gate it
 * to z11+ where the user is reading a single valley rather than the
 * whole country.
 */
const PLACE_MINZOOM_BY_CLASS = [
  'case',
  ['==', ['get', 'class'], 'locality'], ['>=', ['zoom'], 11],
  true,
];

/** Literal `in` filter for the small-settlement place classes, plus the
 *  per-class minzoom gate above. */
const PLACE_FILTER = [
  'all',
  inFilter('class', PLACE_CLASSES),
  PLACE_MINZOOM_BY_CLASS,
];

/**
 * OMT classes treated as "settlement land". Residential is the primary
 * polygon; suburb / quarter / neighbourhood appear in dense urban cores
 * where the upstream tile schema breaks the residential super-polygon
 * into named sub-areas. We outline all of them so a Lviv suburb reads
 * with the same weight as a small village in the Carpathians.
 */
const SETTLEMENT_CLASSES = ['residential', 'suburb', 'quarter', 'neighbourhood'];

/** Reused literal `in` filter — the `landuse` source-layer carries
 *  only settlement classes that pass this test. */
const SETTLEMENT_FILTER = inFilter('class', SETTLEMENT_CLASSES);

/**
 * Inline width stops, mirroring the motorway curve in `roads.js`:
 * visible from z4 so the country overview reads as a constellation
 * of framed plots, then aggressive exponential growth into city
 * zooms so the boundary reads as a heavy frame at every band.
 *
 * @type {Array<[number, number]>}
 */
const INLINE_WIDTHS = [
  [4, 0.5],
  [5, 0.75],
  [6, 1.1],
  [7, 1.5],
  [9, 2.2],
  [11, 3.0],
  [12, 4.0],
  [14, 7.0],
  [16, 11.0],
  [18, 18.0],
  [22, 32.0],
];

/** Casing pads each inline stop by this many px on every side. */
const CASING_EXTRA = 3.0;
/** Inner glow ring sits a few px past the casing for a visible halo. */
const GLOW_INNER_EXTRA = 7.0;
/** Outer glow ring is a much wider blurred wash. */
const GLOW_OUTER_EXTRA = 14.0;

const ROUND_CAPS = { 'line-cap': 'round', 'line-join': 'round' };

// ---------------------------------------------------------------------------
// Shared perimeter-outline builder — single source of truth for the
// glow → casing → inline look.
// ---------------------------------------------------------------------------
//
// Both the supplemented-settlement stack below and the user-drawn
// "manual settlement contour" feature (src/draw/settlement-contours.js)
// trace a polygon PERIMETER with the exact same four-line treatment.
// Centralising the paint here guarantees a hand-drawn contour is
// visually indistinguishable from a data-driven settlement outline and
// keeps the width/blur/opacity curves defined in exactly one place.

/**
 * Build the four `line` layers (glow_outer → glow_inner → casing →
 * inline) that trace a polygon perimeter with the settlement look.
 *
 * @param {object}  opts
 * @param {object}  opts.t            Theme tokens (see `tokens.js`).
 * @param {string}  opts.source       Source id to draw from.
 * @param {string}  opts.idPrefix     Prefix for the generated layer ids.
 * @param {string}  [opts.sourceLayer] Vector-tile source-layer (omit for GeoJSON).
 * @param {number}  [opts.minzoom=4]  Minimum zoom for every layer.
 * @param {*}       [opts.filter]     Optional MapLibre filter applied to all four.
 * @returns {Array<object>} Layer specs in paint order.
 */
export function settlementPerimeterLayers({
  t,
  source,
  idPrefix,
  sourceLayer,
  minzoom = 4,
  filter,
}) {
  const base = (extra) => {
    const spec = { source, minzoom, layout: ROUND_CAPS };
    if (sourceLayer) spec['source-layer'] = sourceLayer;
    if (filter) spec.filter = filter;
    return spec;
  };
  return [
    {
      ...base(),
      id: `${idPrefix}_glow_outer`,
      type: 'line',
      paint: {
        'line-color': t.settlementGlowOuter,
        'line-width': casingWidth(INLINE_WIDTHS, GLOW_OUTER_EXTRA),
        'line-blur': 5.0,
      },
    },
    {
      ...base(),
      id: `${idPrefix}_glow_inner`,
      type: 'line',
      paint: {
        'line-color': t.settlementGlow,
        'line-width': casingWidth(INLINE_WIDTHS, GLOW_INNER_EXTRA),
        'line-blur': 2.0,
      },
    },
    {
      ...base(),
      id: `${idPrefix}_casing`,
      type: 'line',
      paint: {
        'line-color': t.settlementCasing,
        'line-width': casingWidth(INLINE_WIDTHS, CASING_EXTRA),
        'line-opacity': 0.95,
      },
    },
    {
      ...base(),
      id: `${idPrefix}_inline`,
      type: 'line',
      paint: {
        'line-color': t.settlementInline,
        'line-width': expZoom(INLINE_WIDTHS),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Point-ring geometry — fallback frame for polygon-less small settlements.
// ---------------------------------------------------------------------------
//
// Per place class the ring radius grows with zoom so a village reads as a
// small framed plot on overview and a larger one as you zoom in. Cities
// are excluded entirely (they always carry a polygon). The width family
// mirrors the polygon glow → casing → inline relationship: inline is the
// bright core, casing pads it, glow is the wide soft halo.

/** Per-class ring radius (px) by zoom. Bigger class = bigger ring.
 *  `locality` (tourist bases, trailheads, named spots) tracks the
 *  hamlet curve but a touch smaller, and only after its z11 gate. */
const ringRadiusByClass = (townV, villageV, hamletV, isoV, localityV) => [
  'match', ['get', 'class'],
  'town', townV,
  'village', villageV,
  'hamlet', hamletV,
  'isolated_dwelling', isoV,
  'locality', localityV,
  0,
];

/** Core ring radius — visible from z4, grows into hiking zooms. */
const RING_RADIUS = ['interpolate', ['linear'], ['zoom'],
  4, ringRadiusByClass(3.0, 2.2, 1.6, 1.2, 0),
  7, ringRadiusByClass(5.0, 3.6, 2.6, 2.0, 0),
  10, ringRadiusByClass(8.0, 6.0, 4.4, 3.4, 0),
  13, ringRadiusByClass(14.0, 11.0, 8.0, 6.0, 5.0),
  16, ringRadiusByClass(26.0, 20.0, 15.0, 11.0, 9.0),
];

/** Glow ring sits a few px outside the core ring. */
const RING_GLOW_RADIUS = ['interpolate', ['linear'], ['zoom'],
  4, ringRadiusByClass(4.5, 3.4, 2.6, 2.0, 0),
  7, ringRadiusByClass(7.0, 5.2, 4.0, 3.2, 0),
  10, ringRadiusByClass(11.0, 8.4, 6.4, 5.0, 0),
  13, ringRadiusByClass(18.0, 14.0, 10.5, 8.0, 7.0),
  16, ringRadiusByClass(32.0, 25.0, 19.0, 14.0, 12.0),
];

/** Bright inline ring stroke — the core highlight. */
const RING_INLINE_WIDTH = ['interpolate', ['linear'], ['zoom'],
  4, 1.0, 9, 1.6, 14, 2.6, 18, 4.0,
];
/** Casing ring stroke — slightly wider, painted under the inline. */
const RING_CASING_WIDTH = ['interpolate', ['linear'], ['zoom'],
  4, 2.5, 9, 3.4, 14, 5.0, 18, 7.0,
];
/** Glow ring stroke — wide soft halo. */
const RING_GLOW_WIDTH = ['interpolate', ['linear'], ['zoom'],
  4, 3.0, 9, 4.5, 14, 7.0, 18, 10.0,
];

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

/**
 * Build the four-layer settlement outline stack.
 *
 * @param {object} t Theme tokens (see `tokens.js`).
 * @returns {Array<object>} MapLibre layer specs in paint order.
 */
export function settlementOutlineLayers(t) {
  return [
    // Outer ambient wash — very wide, heavily blurred. Reads as a
    // soft violet halo around populated land at every zoom.
    {
      id: 'settlement_outline_glow_outer',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 4,
      filter: SETTLEMENT_FILTER,
      layout: ROUND_CAPS,
      paint: {
        'line-color': t.settlementGlowOuter,
        'line-width': casingWidth(INLINE_WIDTHS, GLOW_OUTER_EXTRA),
        'line-blur': 5.0,
      },
    },
    // Inner heat ring — tighter, moderate blur, higher alpha. Gives
    // the boundary a visible halo right where it meets the rural
    // surrounding fabric.
    {
      id: 'settlement_outline_glow_inner',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 4,
      filter: SETTLEMENT_FILTER,
      layout: ROUND_CAPS,
      paint: {
        'line-color': t.settlementGlow,
        'line-width': casingWidth(INLINE_WIDTHS, GLOW_INNER_EXTRA),
        'line-blur': 2.0,
      },
    },
    // Casing — the thick dark frame, near-opaque so it reads on every
    // theme and underneath every relief overlay.
    {
      id: 'settlement_outline_casing',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 4,
      filter: SETTLEMENT_FILTER,
      layout: ROUND_CAPS,
      paint: {
        'line-color': t.settlementCasing,
        'line-width': casingWidth(INLINE_WIDTHS, CASING_EXTRA),
        'line-opacity': 0.95,
      },
    },
    // Inline — the bright violet core stroke that gives the casing
    // its highlight, painted last so it sits on top of every other
    // outline layer.
    {
      id: 'settlement_outline_inline',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 4,
      filter: SETTLEMENT_FILTER,
      layout: ROUND_CAPS,
      paint: {
        'line-color': t.settlementInline,
        'line-width': expZoom(INLINE_WIDTHS),
      },
    },

    // --- Point-ring fallback for polygon-less small settlements -------
    //
    // Glow ring — a soft violet halo around the place POINT, matching
    // the polygon glow above. Drawn for towns / villages / hamlets /
    // isolated dwellings that have no residential polygon to frame.
    {
      id: 'settlement_point_glow',
      type: 'circle',
      source: SOURCE,
      'source-layer': PLACE_LAYER,
      minzoom: 4,
      filter: PLACE_FILTER,
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': RING_GLOW_RADIUS,
        'circle-stroke-color': t.settlementGlow,
        'circle-stroke-width': RING_GLOW_WIDTH,
        'circle-stroke-opacity': 0.9,
        'circle-blur': 0.6,
        'circle-pitch-alignment': 'map',
      },
    },
    // Casing ring — the dark frame, painted under the bright inline ring
    // exactly like the polygon casing → inline pairing above.
    {
      id: 'settlement_point_casing',
      type: 'circle',
      source: SOURCE,
      'source-layer': PLACE_LAYER,
      minzoom: 4,
      filter: PLACE_FILTER,
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': RING_RADIUS,
        'circle-stroke-color': t.settlementCasing,
        'circle-stroke-width': RING_CASING_WIDTH,
        'circle-stroke-opacity': 0.95,
        'circle-pitch-alignment': 'map',
      },
    },
    // Inline ring — the bright violet core stroke, the point-equivalent
    // of `settlement_outline_inline`. Painted last so the ring reads as
    // the dominant settlement cue for polygon-less places.
    {
      id: 'settlement_point_inline',
      type: 'circle',
      source: SOURCE,
      'source-layer': PLACE_LAYER,
      minzoom: 4,
      filter: PLACE_FILTER,
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': RING_RADIUS,
        'circle-stroke-color': t.settlementInline,
        'circle-stroke-width': RING_INLINE_WIDTH,
        'circle-pitch-alignment': 'map',
      },
    },

    // --- Perimeter outline for supplemented, OSM-unmapped settlements --
    //
    // Some places (e.g. the Заросляк mountain base at the foot of Hoverla)
    // have no `landuse=residential` polygon and no `place` node in OSM —
    // only a POI point and a few scattered buildings — so neither the
    // polygon-outline stack nor the place-point ring above can match them.
    //
    // settlements-supplement.js supplies a real boundary polygon for each
    // such place; the four layers below trace its PERIMETER with the exact
    // same glow → casing → inline treatment as the landuse outline, so a
    // supplemented place reads identically to every other settlement
    // (outlined по периметру, not a synthetic circle).
    ...settlementPerimeterLayers({
      t,
      source: SETTLEMENTS_SUPPLEMENT_SOURCE,
      idPrefix: 'settlement_supplement',
      minzoom: 4,
    }),
  ];
}
