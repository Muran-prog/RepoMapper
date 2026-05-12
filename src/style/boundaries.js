/**
 * Administrative boundaries — country, region (oblast), and finer levels.
 *
 * OpenMapTiles encodes boundaries in the `boundary` source layer with an
 * `admin_level` (2 = country, 4 = state/oblast, 6 = county/raion, etc.) and
 * a `disputed` flag. We render disputed lines with a distinct dash so they
 * read as provisional.
 */

import { expZoom, linZoom, stepZoom } from '../utils/interp.js';

const SOURCE = 'openmaptiles';
const LAYER = 'boundary';

export function boundaryLayers(t) {
  return [
    // -- Country (admin_level == 2) -----------------------------------------
    {
      id: 'boundary_country_outer',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 2,
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'disputed'], 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': t.countryBorder,
        'line-opacity': 0.85,
        'line-width': expZoom([
          [2, 0.6],
          [4, 1.0],
          [8, 1.6],
          [12, 2.4],
          [18, 4.0],
        ]),
      },
    },
    {
      id: 'boundary_country_disputed',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 3,
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'disputed'], 1]],
      paint: {
        'line-color': t.countryBorder,
        'line-opacity': 0.85,
        'line-width': expZoom([
          [3, 0.8],
          [12, 2.4],
        ]),
        'line-dasharray': stepZoom(
          ['literal', [2, 2]],
          [[12, ['literal', [3, 2]]]],
        ),
      },
    },
    // -- Region / oblast (admin_level == 4) ---------------------------------
    {
      id: 'boundary_region',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 4,
      filter: ['==', ['get', 'admin_level'], 4],
      paint: {
        'line-color': t.regionBorder,
        'line-opacity': linZoom([
          [4, 0.0],
          [6, 0.55],
          [12, 0.85],
        ]),
        'line-width': expZoom([
          [4, 0.4],
          [8, 1.0],
          [14, 1.6],
          [20, 2.6],
        ]),
        'line-dasharray': ['literal', [4, 2]],
      },
    },
    // -- County / raion (admin_level == 6) ----------------------------------
    {
      id: 'boundary_county',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 8,
      filter: ['==', ['get', 'admin_level'], 6],
      paint: {
        'line-color': t.cityBorder,
        'line-opacity': linZoom([
          [8, 0.0],
          [10, 0.55],
        ]),
        'line-width': expZoom([
          [8, 0.4],
          [14, 1.0],
          [20, 1.6],
        ]),
        'line-dasharray': ['literal', [3, 2]],
      },
    },
    // -- City limits (admin_level == 8) -------------------------------------
    {
      id: 'boundary_city',
      type: 'line',
      source: SOURCE,
      'source-layer': LAYER,
      minzoom: 11,
      filter: ['==', ['get', 'admin_level'], 8],
      paint: {
        'line-color': t.cityBorder,
        'line-opacity': 0.5,
        'line-width': expZoom([
          [11, 0.3],
          [16, 0.9],
          [22, 1.4],
        ]),
        'line-dasharray': ['literal', [2, 3]],
      },
    },
  ];
}
