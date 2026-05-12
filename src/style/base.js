/**
 * Base/terrain layers — the things that sit *underneath* roads, buildings,
 * and labels: paper background, land-cover (forest, grass, sand…), land-use
 * (residential, industrial, parks…), and water (oceans, lakes, rivers).
 *
 * All styling reads from design tokens so the same module produces both the
 * light and dark themes without branching.
 */

import { expZoom, linZoom, inFilter } from '../utils/interp.js';

// ---------------------------------------------------------------------------
// Background — the colour that shows through any unstyled gap.
// ---------------------------------------------------------------------------
function background(t) {
  return [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': t.bg,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Land cover — wood, grass, sand, ice, etc. OpenMapTiles puts these into the
// `landcover` source-layer with a `class` discriminator.
// ---------------------------------------------------------------------------
function landcover(t) {
  return [
    // Wood / forest — fades in early, full opacity at city zooms.
    {
      id: 'landcover_wood',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'wood'],
      paint: {
        'fill-color': t.forest,
        'fill-opacity': linZoom([
          [4, 0.45],
          [8, 0.85],
          [12, 1.0],
        ]),
      },
    },
    {
      id: 'landcover_grass',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'grass'],
      paint: {
        'fill-color': t.grass,
        'fill-opacity': linZoom([
          [6, 0.4],
          [12, 0.9],
        ]),
      },
    },
    {
      id: 'landcover_scrub',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'scrub'],
      paint: { 'fill-color': t.scrub, 'fill-opacity': 0.85 },
    },
    {
      id: 'landcover_wetland',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'wetland'],
      paint: { 'fill-color': t.wetland, 'fill-opacity': 0.7 },
    },
    {
      id: 'landcover_sand',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'sand'],
      paint: { 'fill-color': t.sand, 'fill-opacity': 0.85 },
    },
    {
      id: 'landcover_ice',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'ice'],
      paint: { 'fill-color': t.ice, 'fill-opacity': 0.85 },
    },
    {
      id: 'landcover_rock',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'rock'],
      paint: { 'fill-color': t.rock, 'fill-opacity': 0.7 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Land use — anthropogenic surfaces. Sits above landcover but below roads.
// ---------------------------------------------------------------------------
function landuse(t) {
  return [
    {
      id: 'landuse_residential',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 8,
      filter: ['==', ['get', 'class'], 'residential'],
      paint: {
        'fill-color': t.residential,
        'fill-opacity': linZoom([
          [8, 0.0],
          [10, 0.6],
          [14, 0.9],
        ]),
      },
    },
    {
      id: 'landuse_industrial',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 9,
      filter: inFilter('class', ['industrial', 'garages']),
      paint: { 'fill-color': t.industrial, 'fill-opacity': 0.75 },
    },
    {
      id: 'landuse_commercial',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 10,
      filter: ['==', ['get', 'class'], 'commercial'],
      paint: { 'fill-color': t.commercial, 'fill-opacity': 0.65 },
    },
    {
      id: 'landuse_cemetery',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 11,
      filter: ['==', ['get', 'class'], 'cemetery'],
      paint: { 'fill-color': t.cemetery, 'fill-opacity': 0.85 },
    },
    {
      id: 'landuse_hospital',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 12,
      filter: ['==', ['get', 'class'], 'hospital'],
      paint: { 'fill-color': t.hospital, 'fill-opacity': 0.6 },
    },
    {
      id: 'landuse_school',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 12,
      filter: inFilter('class', ['school', 'university']),
      paint: { 'fill-color': t.school, 'fill-opacity': 0.6 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Parks — pulled out as their own source-layer in OpenMapTiles. Painted a
// touch greener than landuse so they pop on the canvas.
// ---------------------------------------------------------------------------
function parks(t) {
  return [
    {
      id: 'park_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      paint: {
        'fill-color': t.park,
        'fill-opacity': linZoom([
          [6, 0.5],
          [12, 0.85],
        ]),
      },
    },
    {
      id: 'park_outline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'park',
      minzoom: 12,
      paint: {
        'line-color': t.forestEdge,
        'line-width': linZoom([
          [12, 0.4],
          [18, 1.4],
        ]),
        'line-opacity': 0.8,
      },
    },
    // Sport pitches sit on top of parks.
    {
      id: 'landuse_pitch',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      minzoom: 13,
      filter: ['==', ['get', 'class'], 'pitch'],
      paint: { 'fill-color': t.pitch, 'fill-opacity': 0.85 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Water is defined below, split into baseWaterFill (polygons + outlines)
// and baseWaterways (rivers, canals, streams). The split lets composeLayers
// sandwich the relief stack between them — see the public-entry section.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Aeroway — runways and taxiways. Rendered as roads but in a distinct tier.
// ---------------------------------------------------------------------------
function aeroway(t) {
  return [
    {
      id: 'aeroway_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'aeroway',
      filter: ['==', ['geometry-type'], 'Polygon'],
      minzoom: 11,
      paint: { 'fill-color': t.minor, 'fill-opacity': 0.6 },
    },
    {
      id: 'aeroway_runway',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'aeroway',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'runway']],
      minzoom: 9,
      paint: {
        'line-color': t.minor,
        'line-width': expZoom([
          [9, 0.5],
          [12, 4],
          [16, 14],
          [20, 36],
        ]),
      },
    },
    {
      id: 'aeroway_taxiway',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'aeroway',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'taxiway']],
      minzoom: 11,
      paint: {
        'line-color': t.minor,
        'line-width': expZoom([
          [11, 0.4],
          [14, 1.4],
          [18, 5],
          [22, 14],
        ]),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public entry — combined in the legacy (pre-terrain) z-order. composeLayers
// no longer calls this directly because it needs to interleave relief
// layers between water-fill and waterway; the fine-grained exports below
// are what it uses. Still exported so any future consumer that just wants
// "everything below roads" has a single import.
// ---------------------------------------------------------------------------
export function baseLayers(t) {
  return [
    ...background(t),
    ...landcover(t),
    ...landuse(t),
    ...parks(t),
    ...baseWaterFill(t),
    ...baseWaterways(t),
    ...aeroway(t),
  ];
}

// ---------------------------------------------------------------------------
// Water split — polygons (fills + outlines) separate from linear
// waterways, so composeLayers can sandwich terrain/contour/ridge layers
// between them. Lakes read better below the hillshade (water reflects
// the sky); rivers read better above (so the hillshade doesn't bleed
// their blue).
// ---------------------------------------------------------------------------

function baseWaterFill(t) {
  return [
    {
      id: 'water_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: {
        'fill-color': t.water,
        'fill-antialias': true,
      },
    },
    {
      id: 'water_intermittent',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: ['==', ['get', 'intermittent'], 1],
      paint: {
        'fill-color': t.water,
        'fill-opacity': 0.55,
      },
    },
    {
      id: 'water_outline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      minzoom: 10,
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: {
        'line-color': t.waterOutline,
        'line-width': expZoom(
          [
            [10, 0.2],
            [14, 0.5],
            [18, 1.4],
          ],
          1.3,
        ),
        'line-opacity': 0.7,
      },
    },
  ];
}

function baseWaterways(t) {
  return [
    {
      id: 'waterway_river',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      filter: ['==', ['get', 'class'], 'river'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.waterway,
        'line-width': expZoom(
          [
            [6, 0.4],
            [9, 1.0],
            [12, 1.8],
            [16, 4.0],
            [20, 12.0],
          ],
          1.3,
        ),
      },
    },
    {
      id: 'waterway_canal',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      filter: ['==', ['get', 'class'], 'canal'],
      minzoom: 9,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.waterway,
        'line-width': expZoom([
          [9, 0.4],
          [16, 2.6],
          [20, 7],
        ]),
      },
    },
    {
      id: 'waterway_stream',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      filter: inFilter('class', ['stream', 'ditch', 'drain']),
      minzoom: 13,
      paint: {
        'line-color': t.waterway,
        'line-opacity': 0.85,
        'line-width': expZoom([
          [13, 0.4],
          [18, 1.4],
          [22, 4],
        ]),
      },
    },
  ];
}

// Individual-group exports for composeLayers; each is a pure function of
// tokens. Names mirror the layer groups above.
export function baseBackground(t) { return background(t); }
export function baseLandcover(t)  { return landcover(t); }
export function baseLanduse(t)    { return landuse(t); }
export function baseParks(t)      { return parks(t); }
export { baseWaterFill, baseWaterways };
export function baseAeroway(t)    { return aeroway(t); }
