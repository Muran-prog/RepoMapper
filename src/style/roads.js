/**
 * Road network — the centrepiece of the style.
 *
 * Approach
 * --------
 * Roads are described as data: each entry in {@link ROAD_CLASSES} maps to
 * a `class` (and optionally a `subclass`) discriminator from the
 * OpenMapTiles transportation source-layer. From that one entry we
 * generate the right casing / inline / dash / surface / lane / halo
 * layers for every `brunnel` tier (tunnel, ground, bridge), giving us
 * fine control over:
 *
 *   • per-class colour and zoom-driven width curves
 *   • per-class minZoom so motorways appear at zoom 4 but cycleways don't
 *     pop in until zoom 14
 *   • smooth multi-stop exponential width curves
 *   • casing+inline layering for crisp intersections
 *   • dashed treatment of tunnels, tracks, paths, stairs, unpaved
 *   • bridge stacking on top of surface roads
 *   • cartographic shield helper colours for secondary/tertiary
 *   • lane-count-scaled widths on motorway / trunk / primary
 *   • Carpathian serpentine double-casing at deep zoom inside the bbox
 *   • premium glow halo for hierarchy roads (motorway/trunk/primary get a
 *     full wash, secondary/tertiary a quieter rim, residentials untouched)
 *
 * The whole network reads as data, not boilerplate, and tuning the map's
 * "feel" is a matter of editing the config table at the top of the file
 * rather than hunting through dozens of layer specs.
 */

import { CARPATHIAN } from '../config.js';
import { expZoom, stepZoom, casingWidth, inFilter } from '../utils/interp.js';

// ---------------------------------------------------------------------------
// Road class catalog. Order matters: lower priority first, highest last —
// MapLibre paints in declaration order, so motorways end up on top of
// residentials at intersections, just like a paper atlas.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RoadClass
 * @property {string}   id                  Stable layer prefix.
 * @property {string|string[]} match        OMT `class` value(s).
 * @property {string|string[]} [subclassMatch]
 *     When present, restricts features to those with `subclass` in the set.
 *     Used to split "path" into cycleway/footway/steps etc.
 * @property {string[]} [subclassExclude]
 *     When present, excludes features with these `subclass` values. Used on
 *     the bare `path` class to avoid double-rendering cycleway/footway/steps.
 * @property {number}   minZoom             Layer minzoom.
 * @property {string}   inlineKey           Token key for inline colour.
 * @property {string}   casingKey           Token key for casing colour.
 * @property {Array<[number, number]>} widths   Inline widths (zoom→px).
 * @property {number}   casingExtra         Extra px applied to casing.
 * @property {boolean}  [dashed]            Render inline with a dash array.
 * @property {boolean}  [surfaceAware]      Emit a separate dashed variant for
 *                                          features with `surface=unpaved`.
 * @property {boolean}  [laneScale]         Scale width by OMT `lanes` property.
 * @property {boolean}  [carpathianDoubleCasing]
 *     Emit an extra soft halo at deep zoom inside CARPATHIAN.bbox —
 *     Imhof-style "serpentine halo" for mountain roads.
 * @property {'major'|'minor'} [glow]
 *     Premium glow halo emitted UNDER the casing on the ground brunnel.
 *     'major' = motorway/trunk/primary (full amber wash). 'minor' =
 *     secondary/tertiary (quieter rim). Residentials/services left bare.
 * @property {string}   [lineCap='round']
 */

/** @type {RoadClass[]} */
const ROAD_CLASSES = [
  // -------------------------------------------------------------------------
  // Subclass variants that live inside OMT's catch-all `path` class.
  // These must precede the bare `path` entry so the exclude list there
  // doesn't accidentally swallow them.
  // -------------------------------------------------------------------------
  {
    id: 'steps',
    match: 'path',
    subclassMatch: 'steps',
    minZoom: 15,
    inlineKey: 'stairs',
    casingKey: 'stairsCasing',
    widths: [
      [15, 0.6],
      [17, 1.4],
      [20, 3.6],
      [22, 8],
    ],
    casingExtra: 1.0,
    dashed: true,
    lineCap: 'butt',
  },
  {
    id: 'footway',
    match: 'path',
    subclassMatch: ['footway', 'pedestrian_way'],
    minZoom: 15,
    inlineKey: 'footway',
    casingKey: 'footwayCasing',
    widths: [
      [15, 0.4],
      [17, 1.1],
      [20, 3.0],
      [22, 6.5],
    ],
    casingExtra: 1.0,
    dashed: true,
  },
  {
    id: 'cycleway',
    match: 'path',
    subclassMatch: 'cycleway',
    minZoom: 14,
    inlineKey: 'cycleway',
    casingKey: 'cyclewayCasing',
    widths: [
      [14, 0.4],
      [16, 1.2],
      [18, 2.6],
      [20, 5.5],
      [22, 10],
    ],
    casingExtra: 1.2,
    dashed: true,
  },
  // Bare `path` — anything that's `class=path` and NOT one of the variants above.
  {
    id: 'path',
    match: 'path',
    subclassExclude: ['steps', 'footway', 'pedestrian_way', 'cycleway'],
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
    lineCap: 'butt',
  },

  // -------------------------------------------------------------------------
  // Service & neighbourhood streets. Surface-aware so rural unpaved roads
  // in the Carpathians read correctly without needing a separate `track` tag.
  // -------------------------------------------------------------------------
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
    surfaceAware: true,
  },
  {
    id: 'bus_guideway',
    match: 'bus_guideway',
    minZoom: 12,
    inlineKey: 'busGuideway',
    casingKey: 'busGuidewayCasing',
    widths: [
      [12, 0.4],
      [14, 1.6],
      [16, 3.6],
      [18, 7],
      [20, 14],
      [22, 26],
    ],
    casingExtra: 2.0,
  },
  {
    id: 'minor',
    match: 'minor',
    minZoom: 10,
    inlineKey: 'minor',
    casingKey: 'minorCasing',
    widths: [
      // Minor streets enter at z10 so urban grids are readable in the
      // mid-zoom band rather than popping in at z12. Low-zoom stops
      // are deliberately thin — the whole grid would otherwise flood
      // the canvas at country overview.
      [10, 0.28],
      [12, 0.5],
      [13, 0.95],
      [14, 1.7],
      [16, 4.1],
      [18, 7.6],
      [20, 15],
      [22, 28],
    ],
    casingExtra: 2.0,
    surfaceAware: true,
    carpathianDoubleCasing: true,
  },

  // -------------------------------------------------------------------------
  // Hierarchy tier: tertiary → secondary → primary → trunk → motorway.
  // Lane-count scaling kicks in on the three biggest classes; serpentine
  // halos on primary/secondary/tertiary inside the Carpathian bbox.
  // -------------------------------------------------------------------------
  {
    id: 'tertiary',
    match: 'tertiary',
    minZoom: 8,
    inlineKey: 'tertiary',
    casingKey: 'tertiaryCasing',
    widths: [
      // Visible web from z8 — tertiary now reads on the country
      // overview as the regional connective tissue. Stops below z10
      // are deliberately thin so the network builds gradually as the
      // user approaches detail zooms.
      [8, 0.28],
      [9, 0.42],
      [10, 0.62],
      [12, 1.85],
      [14, 4.2],
      [16, 8.0],
      [18, 13.5],
      [20, 23.5],
      [22, 43.5],
    ],
    casingExtra: 2.6,
    surfaceAware: true,
    carpathianDoubleCasing: true,
    glow: 'minor',
  },
  {
    id: 'secondary',
    match: 'secondary',
    minZoom: 7,
    inlineKey: 'secondary',
    casingKey: 'secondaryCasing',
    widths: [
      // Pulled to z7 so secondary roads read at country overview;
      // low-zoom stops bumped ~50% over the previous curve so the
      // arterial web is unmistakable even at the default boot zoom.
      [7, 0.32],
      [8, 0.5],
      [9, 0.66],
      [11, 1.85],
      [12, 2.6],
      [14, 5.4],
      [16, 9.8],
      [18, 16.5],
      [20, 30.0],
      [22, 54.5],
    ],
    casingExtra: 3.0,
    carpathianDoubleCasing: true,
    glow: 'major',
  },
  {
    id: 'primary',
    match: 'primary',
    minZoom: 6,
    inlineKey: 'primary',
    casingKey: 'primaryCasing',
    widths: [
      // Now appears at z6 (was z7). Stops at z6-z9 bumped so the
      // national primary network is the visual spine of every overview
      // shot, distinctly heavier than secondary at every zoom.
      [6, 0.42],
      [7, 0.6],
      [9, 1.35],
      [11, 2.25],
      [12, 3.1],
      [14, 6.2],
      [16, 11.0],
      [18, 18.5],
      [20, 33],
      [22, 60],
    ],
    casingExtra: 2.8,
    laneScale: true,
    carpathianDoubleCasing: true,
    glow: 'major',
  },
  {
    id: 'trunk',
    match: 'trunk',
    minZoom: 5,
    inlineKey: 'trunk',
    casingKey: 'trunkCasing',
    widths: [
      // Pulled to z5 so trunk routes show up alongside motorways at
      // the country overview; low-zoom widths boosted ~40% for clear
      // readability without zoom.
      [5, 0.42],
      [6, 0.55],
      [9, 1.5],
      [11, 2.5],
      [12, 3.6],
      [14, 7.2],
      [16, 12.0],
      [18, 21.0],
      [20, 36],
      [22, 70],
    ],
    casingExtra: 3.0,
    laneScale: true,
    glow: 'major',
  },
  {
    id: 'motorway',
    match: 'motorway',
    minZoom: 4,
    inlineKey: 'motorway',
    casingKey: 'motorwayCasing',
    widths: [
      // Motorways now anchor at z4 so the country overview reads as
      // a true backbone diagram. Low-zoom stops boosted ~50% over the
      // previous curve — the heaviest visual weight, even on a
      // pull-back to the whole nation.
      [4, 0.42],
      [5, 0.55],
      [7, 1.05],
      [9, 2.0],
      [11, 2.9],
      [12, 4.0],
      [14, 8.0],
      [16, 13.2],
      [18, 23.0],
      [20, 40],
      [22, 78],
    ],
    casingExtra: 3.4,
    laneScale: true,
    glow: 'major',
  },
];

// ---------------------------------------------------------------------------
// Layer factories
// ---------------------------------------------------------------------------

const SOURCE = 'openmaptiles';
const LAYER = 'transportation';

const roundCaps = { 'line-cap': 'round', 'line-join': 'round' };
const buttCaps  = { 'line-cap': 'butt',  'line-join': 'round' };

/** Convert `[w, s, e, n]` → a closed GeoJSON Polygon for `within` filters. */
function bboxToPolygon([w, s, e, n]) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/** Computed once at module load. */
const CARPATHIAN_BBOX_POLYGON = bboxToPolygon(CARPATHIAN.bbox);

/**
 * Lane-count factor expression. 2 lanes ≈ 1.0×, 4 ≈ 1.25×, 6 ≈ 1.45×, 8 ≈ 1.6×.
 * Applied as a top-level multiplication on the zoom-driven width. Legal
 * under the style spec because the zoom expression stays inside an
 * `interpolate` — arithmetic only wraps the resulting number.
 */
function laneFactorExpr() {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'lanes'], 2],
    1, 0.85,
    2, 1.0,
    4, 1.25,
    6, 1.45,
    8, 1.6,
  ];
}

/**
 * Zoom-driven width, optionally scaled by the OMT `lanes` count. Inline
 * and casing call through this so the two stay proportional.
 *
 * The style spec requires `['zoom']` to appear ONLY as direct input to a
 * top-level `interpolate` or `step` — meaning we can't wrap the whole
 * zoom interpolation in arithmetic. Instead we push the lane factor into
 * each zoom-stop value: zoom stays at the top, the per-stop value is a
 * pure data expression of `lanes` (no zoom inside).
 *
 * @param {Array<[number, number]>} stops Width stops (zoom→px).
 * @param {number}  [extra=0]             Extra px added to every stop (for casings).
 * @param {boolean} [laneScale=false]
 */
function widthExpr(stops, extra = 0, laneScale = false) {
  if (!laneScale) {
    return extra === 0 ? expZoom(stops) : casingWidth(stops, extra);
  }
  const factor = laneFactorExpr();
  const flat = [];
  for (const [z, w] of stops) {
    flat.push(z, ['*', w + extra, factor]);
  }
  return ['interpolate', ['exponential', 1.4], ['zoom'], ...flat];
}

/**
 * Build the feature filter for a class × brunnel × optional surface variant.
 */
function classFilter(rc, brunnel, { surface } = {}) {
  const matchValues = Array.isArray(rc.match) ? rc.match : [rc.match];
  const parts = ['all'];

  parts.push(
    matchValues.length === 1
      ? ['==', ['get', 'class'], matchValues[0]]
      : inFilter('class', matchValues),
  );

  if (brunnel === 'ground') {
    parts.push(['!=', ['get', 'brunnel'], 'tunnel']);
    parts.push(['!=', ['get', 'brunnel'], 'bridge']);
  } else {
    parts.push(['==', ['get', 'brunnel'], brunnel]);
  }

  if (rc.subclassMatch) {
    const subs = Array.isArray(rc.subclassMatch) ? rc.subclassMatch : [rc.subclassMatch];
    parts.push(subs.length === 1
      ? ['==', ['get', 'subclass'], subs[0]]
      : inFilter('subclass', subs));
  }
  if (Array.isArray(rc.subclassExclude)) {
    for (const s of rc.subclassExclude) {
      parts.push(['!=', ['get', 'subclass'], s]);
    }
  }

  if (surface === 'paved') {
    // Treat missing surface as paved — most major roads in OMT don't
    // expose the property and we don't want them rendering as unpaved.
    parts.push(['!=', ['get', 'surface'], 'unpaved']);
  } else if (surface === 'unpaved') {
    parts.push(['==', ['get', 'surface'], 'unpaved']);
  }

  return parts;
}

const layerCaps = (rc) => (rc.lineCap === 'butt' ? buttCaps : roundCaps);

// ---------------------------------------------------------------------------
// Casings & inlines
// ---------------------------------------------------------------------------

function casingLayer(rc, brunnel, t, { idSuffix = '', surface, opacityScale = 1 } = {}) {
  const opacity = (brunnel === 'tunnel' ? 0.55 : 1.0) * opacityScale;
  const paint = {
    'line-color': t[rc.casingKey],
    'line-width': widthExpr(rc.widths, rc.casingExtra, rc.laneScale),
    'line-opacity': opacity,
  };
  if (brunnel === 'tunnel') {
    paint['line-dasharray'] = stepZoom(
      ['literal', [3, 2]],
      [
        [16, ['literal', [4, 2]]],
        [20, ['literal', [6, 3]]],
      ],
    );
  }
  return {
    id: `road_${brunnel}_${rc.id}${idSuffix}_casing`,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, brunnel, { surface }),
    layout: layerCaps(rc),
    paint,
  };
}

function inlineLayer(rc, brunnel, t, { idSuffix = '', surface, forceDashed = false } = {}) {
  const baseOpacity = brunnel === 'tunnel' ? 0.7 : 1.0;
  const dashed = rc.dashed || forceDashed;

  const paint = {
    'line-color': t[rc.inlineKey],
    'line-width': widthExpr(rc.widths, 0, rc.laneScale),
    'line-opacity': baseOpacity,
  };
  if (dashed) {
    // Step-based dashes avoid the swimming-dash artifact that exponential
    // width interpolation produces on dashed lines.
    paint['line-dasharray'] = stepZoom(
      ['literal', [2, 2]],
      [
        [16, ['literal', [3, 1.5]]],
        [20, ['literal', [4, 1.5]]],
      ],
    );
  }
  return {
    id: `road_${brunnel}_${rc.id}${idSuffix}`,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, brunnel, { surface }),
    layout: layerCaps(rc),
    paint,
  };
}

// ---------------------------------------------------------------------------
// Carpathian double-casing — an extra-wide, soft, bg-tinted halo BEFORE
// the regular ground casing, scoped to the bbox via `within` and to
// deep zooms via minzoom 13. Reads as a quiet rim on serpentines.
// ---------------------------------------------------------------------------

const CARPATHIAN_DOUBLE_CASING_MINZOOM = 13;

function carpathianHaloLayer(rc, t) {
  return {
    id: `road_ground_${rc.id}_carp_halo`,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: CARPATHIAN_DOUBLE_CASING_MINZOOM,
    filter: [
      ...classFilter(rc, 'ground'),
      ['within', CARPATHIAN_BBOX_POLYGON],
    ],
    layout: layerCaps(rc),
    paint: {
      'line-color': t.bg,
      'line-width': widthExpr(rc.widths, rc.casingExtra + 3, rc.laneScale),
      'line-opacity': 0.45,
      'line-blur': 1.5,
    },
  };
}

// ---------------------------------------------------------------------------
// Premium glow — a soft, blurred, accent-tinted halo painted UNDER the
// casing on the ground brunnel. Scoped via the per-class `glow` flag so
// only roads marked 'major' (motorway/trunk/primary/secondary) or 'minor'
// (tertiary) get one — residentials and services stay quiet.
//
// Two-tier emission per road:
//   • OUTER: very wide (+12/+8 px past casing), heavy blur, low alpha —
//     ambient amber wash bleeding onto the surrounding fabric.
//   • INNER: tighter (+5/+3 px), moderate blur, higher alpha — visible
//     heat right at the road shoulder.
//
// Both layers are static blur (no transitions), so reduce-motion users
// get the same look without animation.
// ---------------------------------------------------------------------------

function glowHaloLayers(rc, t) {
  const major = rc.glow === 'major';

  // Outer ambient wash.
  const outer = {
    id: `road_ground_${rc.id}_glow_outer`,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, 'ground'),
    layout: layerCaps(rc),
    paint: {
      'line-color': major ? t.roadGlowMajorOuter : t.roadGlowMinorOuter,
      'line-width': widthExpr(
        rc.widths,
        rc.casingExtra + (major ? 12 : 8),
        rc.laneScale,
      ),
      'line-blur': major ? 6.0 : 4.0,
    },
  };

  // Inner heat ring.
  const inner = {
    id: `road_ground_${rc.id}_glow`,
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: rc.minZoom,
    filter: classFilter(rc, 'ground'),
    layout: layerCaps(rc),
    paint: {
      'line-color': major ? t.roadGlowMajor : t.roadGlowMinor,
      'line-width': widthExpr(
        rc.widths,
        rc.casingExtra + (major ? 5 : 3),
        rc.laneScale,
      ),
      'line-blur': major ? 2.8 : 2.0,
    },
  };

  return [outer, inner];
}

// ---------------------------------------------------------------------------
// Hierarchy-free class catalog — used when the bold-orange road treatment
// is turned OFF («Жирные оранжевые дороги» toggle / FEATURES.roadsOrangeBold).
// Every hierarchy class (the ones carrying a `glow` mark: motorway / trunk /
// primary / secondary / tertiary) is dropped ENTIRELY — no casing, no
// inline, no glow, nothing. The big orange roads simply disappear from the
// map. Non-hierarchy classes (minor / service / track / path / …) are
// untouched. The matching road labels + ref shields for the dropped
// classes are suppressed by labels.js via the `hierarchyRoadLabels` flag
// so no text floats over missing geometry.
// ---------------------------------------------------------------------------

const NO_HIERARCHY_ROAD_CLASSES = ROAD_CLASSES.filter((rc) => !rc.glow);

// ---------------------------------------------------------------------------
// Brunnel-level stack emission. Each road class produces:
//   (optional Carpathian halo) → casing → inline   [for each surface variant]
// ---------------------------------------------------------------------------

function brunnelStack(brunnel, t, opts) {
  const out = [];
  // The class catalog is swappable: the bold-orange treatment uses the
  // canonical ROAD_CLASSES; the toggle-off variant uses the filtered
  // catalog with the hierarchy classes removed, so their layers are
  // never emitted. Surviving layer ids stay identical either way.
  const classes = opts.classes ?? ROAD_CLASSES;

  // 1) Premium glow halos (ground only — bridges/tunnels skip the wash
  //    so elevated/buried roads don't bleed colour off-geometry).
  //    Order matters: glow must paint UNDER both the Carpathian halo
  //    and the casing so the casing's crisp edge isn't softened.
  //    Two layers per road: outer ambient wash → inner heat ring.
  //    Only emitted in the bold-orange state (FEATURES.roadsOrangeBold →
  //    the «Жирные оранжевые дороги» toggle); the filtered catalog
  //    carries no `glow` marks, so this loop is a structural no-op there.
  if (brunnel === 'ground' && opts.glow) {
    for (const rc of classes) {
      if (rc.glow) out.push(...glowHaloLayers(rc, t));
    }
  }

  // 2) Carpathian halos (ground only, gated by feature flag from caller).
  if (brunnel === 'ground' && opts.carpathianDoubleCasing) {
    for (const rc of classes) {
      if (rc.carpathianDoubleCasing) out.push(carpathianHaloLayer(rc, t));
    }
  }

  // 3) Casings (one per class, never split by surface — the surface only
  //    affects the inline's dashing, not the casing).
  for (const rc of classes) {
    out.push(casingLayer(rc, brunnel, t));
  }

  // 4) Inlines (surface-aware classes emit paved+unpaved; others a single layer).
  for (const rc of classes) {
    if (rc.surfaceAware) {
      out.push(inlineLayer(rc, brunnel, t, { idSuffix: '_paved', surface: 'paved' }));
      out.push(inlineLayer(rc, brunnel, t, { idSuffix: '_unpaved', surface: 'unpaved', forceDashed: true }));
    } else {
      out.push(inlineLayer(rc, brunnel, t));
    }
  }

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
//   2. ground casings + inlines (with optional Carpathian halos)
//   3. railways
//   4. bridge casings + inlines  (highest)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RoadOpts
 * @property {boolean} [shieldsMinor=true]
 *     Cartographic shields for secondary/tertiary (consumed by labels.js).
 * @property {boolean} [carpathianDoubleCasing=true]
 *     Imhof-style extra-wide halo on serpentine roads inside the Carpathian
 *     bbox at deep zoom. Off-switchable for low-profile users.
 * @property {boolean} [orangeBold=true]
 *     The bold ORANGE hierarchy road network (motorway → tertiary):
 *     orange inline fills, amber casings, the premium glow wash, and
 *     the boosted overview width curves. Driven by
 *     FEATURES.roadsOrangeBold via the «Жирные оранжевые дороги»
 *     toggle in the Layers panel. Off → those classes are NOT emitted
 *     at all (no casing / inline / glow) — the orange roads disappear
 *     from the map entirely; minor streets, services, tracks and paths
 *     keep rendering as usual.
 */

/**
 * @param {object}   t
 * @param {RoadOpts} [opts]
 */
export function roadLayers(t, opts = {}) {
  const { carpathianDoubleCasing = true, orangeBold = true } = opts;
  const classes = orangeBold ? ROAD_CLASSES : NO_HIERARCHY_ROAD_CLASSES;
  return [
    ...brunnelStack('tunnel', t, { carpathianDoubleCasing: false, glow: false, classes }),
    ...brunnelStack('ground', t, { carpathianDoubleCasing, glow: orangeBold, classes }),
    ...railways(t),
    ...brunnelStack('bridge', t, { carpathianDoubleCasing: false, glow: false, classes }),
  ];
}

/** Class IDs exposed for control modules that want to toggle road tiers. */
export const ROAD_CLASS_IDS = ROAD_CLASSES.map((r) => r.id);
