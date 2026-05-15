/**
 * Buildings — a flat 2D footprint that fades in around zoom 13, then a 3D
 * extruded layer that takes over once the camera is close enough for the
 * pseudo-perspective to be worth the extra fragment work.
 *
 * The two layers cross-fade so there's no popping at the handover zoom,
 * and the 3D layer's height curve gracefully grows out of zero so newly
 * visible buildings don't shoot up the moment they enter view.
 *
 * Landmark emphasis
 * -----------------
 * Religious, governmental, educational, civic and historic buildings get
 * a premium accent treatment: a soft outer glow + an inner glow drawn as
 * blurred line layers around the polygon ring, an accent fill, and a
 * crisp accent outline. The glow uses the warm amber accent token family
 * so landmarks read as "important" against the cool-cream regular fabric.
 *
 * The filter is permissive — it matches OMT `class`, OMT `subclass`, and
 * raw OSM `building` / `historic` / `tourism` values where they exist.
 * Backends that don't expose these properties simply produce no matches,
 * so the layer is a graceful no-op rather than an error.
 */

import { linZoom, inFilter } from '../utils/interp.js';

const SOURCE = 'openmaptiles';
const LAYER = 'building';

/**
 * OMT `class` values that flag a building as a landmark in the standard
 * planetiler-openmaptiles profile (≥3.13). Add to the set carefully —
 * any class listed here gets the full accent treatment.
 */
const LANDMARK_CLASSES = [
  'religious',
  'civic',
  'public',
  'governmental',
  'government',
  'education',
  'university',
  'college',
  'school',
  'hospital',
  'monument',
  'historic',
  'museum',
  'stadium',
  'transportation',
  'cathedral',
  'temple',
];

/**
 * Raw OSM `building`-tag values worth flagging when the backend forwards
 * them. Religious + governmental + monumental tags only — generic
 * "yes"/"residential" stay untouched.
 */
const LANDMARK_BUILDING_TAGS = [
  'cathedral',
  'church',
  'chapel',
  'mosque',
  'synagogue',
  'temple',
  'monastery',
  'shrine',
  'castle',
  'fortress',
  'palace',
  'townhall',
  'government',
  'parliament',
  'courthouse',
  'museum',
  'monument',
  'memorial',
  'university',
  'college',
  'hospital',
  'train_station',
  'transportation',
];

/**
 * Permissive landmark detector. Matches if ANY of the standard property
 * surfaces flag the building. Missing properties fall through harmlessly
 * thanks to `coalesce`.
 */
function landmarkFilter() {
  return [
    'any',
    inFilter('class', LANDMARK_CLASSES),
    inFilter('subclass', LANDMARK_CLASSES),
    inFilter('building', LANDMARK_BUILDING_TAGS),
    ['has', 'historic'],
  ];
}

/**
 * Negation of the landmark filter — used so the regular `building_2d`
 * fill renders ALL buildings (landmarks included) underneath the
 * accent fill, but the validator still sees a stable filter shape.
 *
 * We don't actually need to exclude landmarks from `building_2d` —
 * the accent fill on top will overpaint them — but keeping the filter
 * idea in code makes the layer order intent explicit if anyone reads
 * along.
 */

/**
 * Building layer factory.
 * @param {object} t              theme tokens
 * @param {object} [opts]
 * @param {boolean} [opts.threeD] enable the extrusion layer (default: true)
 */
export function buildingLayers(t, { threeD = true } = {}) {
  const layers = [];

  // ---------------------------------------------------------------------
  // 0a) Outer building glow — wide, blurred halo around EVERY building
  //     polygon ring. Same recipe as the landmark outer glow, just
  //     tuned softer so the whole urban fabric visibly pops against
  //     the paper / slate background between z13 and the 3D handover
  //     at z16. Painted UNDER everything so the wash bleeds outward
  //     onto the surrounding fabric without softening building edges.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_glow_outer',
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.buildingGlowOuter,
      'line-width': linZoom([
        [13, 1.4],
        [15, 3.2],
        [16, 2.0],
      ]),
      'line-blur': 3.0,
      'line-opacity': linZoom([
        [13, 0.0],
        [14, 1.0],
        [16, threeD ? 0.0 : 0.6],
      ]),
    },
  });

  // ---------------------------------------------------------------------
  // 0b) Inner building glow — narrower, less blurred, more saturated.
  //     The pair of glows reads as a soft amber halo with a brighter
  //     rim at the building's silhouette. Visible across the whole z13
  //     fabric so the user always sees buildings as accent-coloured,
  //     not as flat polygons.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_glow_inner',
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.buildingGlowInner,
      'line-width': linZoom([
        [13, 0.6],
        [15, 1.6],
        [16, 1.0],
      ]),
      'line-blur': 1.0,
      'line-opacity': linZoom([
        [13, 0.0],
        [14, 1.0],
        [16, threeD ? 0.0 : 0.7],
      ]),
    },
  });

  // ---------------------------------------------------------------------
  // 1) Outer glow — wide, very blurred, low-opacity halo around the
  //    landmark polygon ring. Painted UNDER the regular building fill
  //    so the wash bleeds outward onto the surrounding fabric without
  //    softening the building's own edges.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_landmark_glow_outer',
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    filter: landmarkFilter(),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.buildingLandmarkGlowOuter,
      'line-width': linZoom([
        [13, 1.6],
        [15, 4.5],
        [18, 8.0],
        [22, 14.0],
      ]),
      'line-blur': 4.0,
      'line-opacity': linZoom([
        [13, 0.0],
        [14, 1.0],
      ]),
    },
  });

  // ---------------------------------------------------------------------
  // 2) Inner glow — narrower, less blurred, more saturated. The pair of
  //    glows reads as a soft amber halo with a brighter rim, mirroring
  //    the cartographic "important monument" treatment.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_landmark_glow_inner',
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    filter: landmarkFilter(),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.buildingLandmarkGlowInner,
      'line-width': linZoom([
        [13, 0.8],
        [15, 2.2],
        [18, 4.0],
        [22, 7.0],
      ]),
      'line-blur': 1.6,
      'line-opacity': linZoom([
        [13, 0.0],
        [14, 1.0],
      ]),
    },
  });

  // ---------------------------------------------------------------------
  // 3) Regular flat building fabric — every building, untouched.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_2d',
    type: 'fill',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    paint: {
      'fill-color': t.building,
      'fill-outline-color': t.buildingOutline,
      'fill-opacity': linZoom([
        [13, 0.55],
        [14, 0.9],
        [15, 1.0],
        // Below 0 means: hand off to the 3D layer once it can express depth.
        [16, threeD ? 0 : 1.0],
      ]),
      'fill-antialias': true,
    },
  });

  // ---------------------------------------------------------------------
  // 4) Landmark accent fill — overpaints the regular fabric for matched
  //    buildings only. Same opacity curve so it cross-fades to the 3D
  //    layer at zoom 16 like its neighbours.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_landmark_fill',
    type: 'fill',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    filter: landmarkFilter(),
    paint: {
      'fill-color': t.buildingLandmark,
      'fill-outline-color': t.buildingLandmarkOutline,
      'fill-opacity': linZoom([
        [13, 0.25],
        [14, 0.85],
        [15, 0.95],
        [16, threeD ? 0 : 1.0],
      ]),
      'fill-antialias': true,
    },
  });

  // ---------------------------------------------------------------------
  // 5) Landmark accent outline — a crisp, slightly thicker line so the
  //    building's silhouette stays distinct above the glow wash.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_landmark_outline',
    type: 'line',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    filter: landmarkFilter(),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': t.buildingLandmarkOutline,
      'line-width': linZoom([
        [13, 0.4],
        [15, 0.9],
        [18, 1.4],
        [22, 2.2],
      ]),
      'line-opacity': linZoom([
        [13, 0.0],
        [14, 0.95],
        [16, threeD ? 0 : 0.95],
      ]),
    },
  });

  if (!threeD) return layers;

  // ---------------------------------------------------------------------
  // 6) 3D extrusion — unchanged, reads at zoom ≥ 15.
  // ---------------------------------------------------------------------
  layers.push({
    id: 'building_3d',
    type: 'fill-extrusion',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 15,
    paint: {
      'fill-extrusion-color': t.building3D,
      'fill-extrusion-opacity': linZoom([
        [15, 0.0],
        [16, 0.85],
      ]),
      // OpenMapTiles exposes `render_height` and `render_min_height` after
      // the cartographic step. We grow them in from 0 over a half-zoom so
      // the extrusion doesn't pop.
      'fill-extrusion-height': [
        'interpolate',
        ['linear'],
        ['zoom'],
        15,
        0,
        16,
        ['coalesce', ['get', 'render_height'], ['get', 'height'], 5],
      ],
      'fill-extrusion-base': [
        'interpolate',
        ['linear'],
        ['zoom'],
        15,
        0,
        16,
        ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
      ],
      'fill-extrusion-vertical-gradient': true,
    },
  });

  return layers;
}
