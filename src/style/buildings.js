/**
 * Buildings — a flat 2D footprint that fades in around zoom 13, then a 3D
 * extruded layer that takes over once the camera is close enough for the
 * pseudo-perspective to be worth the extra fragment work.
 *
 * The two layers cross-fade so there's no popping at the handover zoom,
 * and the 3D layer's height curve gracefully grows out of zero so newly
 * visible buildings don't shoot up the moment they enter view.
 */

import { linZoom } from '../utils/interp.js';

const SOURCE = 'openmaptiles';
const LAYER = 'building';

/**
 * Building layer factory.
 * @param {object} t              theme tokens
 * @param {object} [opts]
 * @param {boolean} [opts.threeD] enable the extrusion layer (default: true)
 */
export function buildingLayers(t, { threeD = true } = {}) {
  const flat = {
    id: 'building_2d',
    type: 'fill',
    source: SOURCE,
    'source-layer': LAYER,
    minzoom: 13,
    paint: {
      'fill-color': t.building,
      'fill-outline-color': t.buildingOutline,
      'fill-opacity': linZoom([
        [13, 0.2],
        [14, 0.7],
        [15, 0.9],
        // Below 0 means: hand off to the 3D layer once it can express depth.
        [16, threeD ? 0 : 0.95],
      ]),
      'fill-antialias': true,
    },
  };

  if (!threeD) return [flat];

  const extruded = {
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
  };

  return [flat, extruded];
}
