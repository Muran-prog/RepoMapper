/**
 * Swamp-cover overlay — a dedicated, toggleable "болота и топи" layer that
 * highlights every wetland polygon in a graded ORANGE palette keyed to how
 * hard the ground is to cross, the wetland sibling of the green forest-cover
 * overlay (src/style/forest-cover.js).
 *
 * Why a separate layer (and not the base `landcover_wetland` wash)?
 * -----------------------------------------------------------------
 *   • `base.js::landcover_wetland` paints the SAME `landcover` class=wetland
 *     polygons, but in a single pale sage `t.wetland` wash — it is a quiet
 *     background surface and says nothing about *type* or *traversability*.
 *   • This overlay instead classifies wetlands into a five-step
 *     TRAVERSABILITY LADDER and paints each step its own orange so a reader
 *     can tell a firm wet meadow from an impassable tidal flat at a glance.
 *
 * Presentation vs. forest-cover — the one deliberate difference:
 * -------------------------------------------------------------
 * Forest-cover forces the FLAT preset (it is near-total-coverage — the green
 * mass is the whole story). Wetlands are SPARSE, so this overlay is a pure
 * ADDITIVE layer: it never suppresses relief/3D/contours. Terrain context is
 * what lets a floodplain marsh read as a floodplain, so we keep it — the
 * orange simply sits on top. Everything else (independent toggle, persisted
 * pref, fill→edge treatment, source-gated hi-detail tier) mirrors
 * forest-cover exactly.
 *
 * Two-tier data model (mirrors forest-cover's global + hi-detail split):
 * ---------------------------------------------------------------------
 *   Tier A — `swampCoverLayers`         reads the GLOBAL OpenMapTiles
 *     `landcover` class=wetland the base map already consumes. Always
 *     present, zero new data dependency, country-wide. But the published
 *     OpenFreeMap build collapses every wetland to subclass='wetland'
 *     (verified by decoding live z12–z14 tiles), so this tier can only ever
 *     paint the single "unclassified" orange — it is the graceful base.
 *
 *   Tier B — `swampCoverClassifiedLayers` reads the `wetlands` source
 *     (a classified GeoJSON archive built offline by tools/build-wetlands.py
 *     from raw OSM `natural=wetland` + `wetland=<subtype>` — the only source
 *     that preserves the subtype). Each feature carries a `tier` property; a
 *     data-driven `match` expression paints the graded palette. Source-gated
 *     on `hasWetlandsSource` (see src/style/index.js), exactly like the 10 m
 *     forest archive is gated on `hasForest10mSource`.
 *
 * The traversability ladder (easiest → impassable) and the OSM subtypes that
 * feed each step (see tools/build_wetlands.py::TIER_BY_TYPE):
 *
 *   t1  Легко проходимые         wet_meadow                  — seasonally wet grass, firmest
 *   t2  Умеренно проходимые      marsh, saltmarsh            — herbaceous, shallow water
 *   t3  Труднопроходимые         reedbed, swamp, fen         — dense veg / woody / soft peat
 *   t4  Очень труднопроходимые   bog, string_bog             — quaking raised peat
 *   t5  Непроходимые             tidalflat, mud, mangrove    — open mud / permanent inundation
 *   mm  Соляные пруды            saltern                     — man-made salt pans (off-ramp)
 *   u0  Тип не указан            natural=wetland (no subtype) — unclassified base
 *
 * Palette is a warm gold→red "heat ramp" (hue rotates AND lightness falls as
 * ground gets harder): distinct hue + L* steps, not single-hue saturation, so
 * tiers are separable at a glance (min adjacent CIELAB ΔE ≈ 16). Man-made and
 * unclassified sit deliberately OFF the ramp (desaturated clay / pale sand).
 * All colours are theme tokens — see `t.swampCover` in src/style/tokens.js.
 */

import { linZoom } from '../utils/interp.js';

// Global OpenMapTiles `landcover` class that represents wetland. Matches the
// base map's `landcover_wetland` filter so Tier A lights up exactly the same
// polygons — just in the thematic orange instead of the quiet sage wash.
const WETLAND_FILTER = ['==', ['get', 'class'], 'wetland'];

/**
 * Build the ordered `['match', ['get','tier'], t1,…, default]` colour
 * expression for a given slot ('fill' | 'edge') from the theme tokens.
 * Default arm = the unclassified (`u0`) colour, so any unknown/untagged tier
 * degrades to the same base orange Tier A uses.
 *
 * @param {object} tiers `t.swampCover.tiers`
 * @param {'fill'|'edge'} slot
 * @returns {Array} MapLibre `match` expression.
 */
function tierColor(tiers, slot) {
  return [
    'match', ['get', 'tier'],
    't1', tiers.t1[slot],
    't2', tiers.t2[slot],
    't3', tiers.t3[slot],
    't4', tiers.t4[slot],
    't5', tiers.t5[slot],
    'mm', tiers.mm[slot],
    'u0', tiers.u0[slot],
    tiers.u0[slot], // default → unclassified
  ];
}

/**
 * Tier A — global unclassified base (fill → edge). Reads the always-present
 * OpenMapTiles `landcover` source, so `composeLayers` emits it on the feature
 * flag alone (no source gate), exactly like forest-cover's global tier.
 *
 * @param {object} t Theme tokens. Reads `t.swampCover.base`.
 * @returns {Array<object>} Ordered MapLibre layer specs.
 */
export function swampCoverLayers(t) {
  const b = t.swampCover.base;
  return [
    {
      id: 'swampcover_base_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: WETLAND_FILTER,
      paint: {
        'fill-color': b.fill,
        'fill-antialias': true,
        // Softer than Tier B: this is the country-wide wash that the
        // classified archive paints over where it has coverage.
        'fill-opacity': 0.72,
      },
    },
    {
      id: 'swampcover_base_edge',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: WETLAND_FILTER,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': b.edge,
        'line-opacity': linZoom([
          [7, 0],
          [9, 0.4],
          [13, 0.6],
        ]),
        'line-width': linZoom([
          [8, 0.3],
          [13, 1.0],
          [16, 1.6],
        ]),
      },
    },
  ];
}

/**
 * Tier B — classified detail (fill → edge), painted from the `wetlands`
 * GeoJSON archive. The per-feature `tier` property drives a data-driven
 * palette so all five traversability steps (+ man-made + unclassified) read
 * in their own orange. Sits ON TOP of Tier A: where the archive has a polygon
 * the near-opaque graded fill supersedes the coarse base wash; elsewhere the
 * base wash remains the visible surface.
 *
 * Source-gated: emitted by `composeLayers` only when `swampCover` is on AND
 * `hasWetlandsSource` is true (see src/style/index.js).
 *
 * @param {object} t Theme tokens. Reads `t.swampCover.tiers`.
 * @returns {Array<object>} Ordered MapLibre layer specs (fill → edge).
 */
export function swampCoverClassifiedLayers(t) {
  const tiers = t.swampCover.tiers;
  return [
    {
      id: 'swampcover_fill',
      type: 'fill',
      source: 'wetlands',
      paint: {
        'fill-color': tierColor(tiers, 'fill'),
        'fill-antialias': true,
        // Bold, near-true palette so the tier colour reads accurately; a
        // single flat opacity keeps the multi-tone read clean at every zoom.
        'fill-opacity': 0.9,
      },
    },
    {
      id: 'swampcover_edge',
      type: 'line',
      source: 'wetlands',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': tierColor(tiers, 'edge'),
        'line-opacity': linZoom([
          [7, 0.35],
          [10, 0.6],
          [13, 0.8],
        ]),
        'line-width': linZoom([
          [7, 0.4],
          [12, 1.1],
          [16, 2.0],
        ]),
      },
    },
  ];
}
