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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE = 'openmaptiles';
const LAYER = 'landuse';

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
  ];
}
