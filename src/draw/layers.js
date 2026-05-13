/**
 * MapLibre source + layer specs for the drawing engine.
 *
 * One GeoJSON source backs the entire engine. Layers are added on top
 * of the live style so user drawings render above the basemap and the
 * relief stack but below MapLibre's own UI overlays (controls / popups).
 *
 * Layer stack (back → front):
 *
 *   draw-fill           Polygon fills (semi-transparent)
 *   draw-line-casing    Wide halo around every line/polygon outline
 *   draw-line           Main stroke for lines, polygon outlines, connections
 *   draw-arrow-head     Arrow heads — filled polygons with no outline
 *   draw-point-halo     Glow under markers (also reads as "selected" state)
 *   draw-point          Marker dot
 *   draw-point-label    Marker number / label
 *   draw-vertex-mid     Midpoint handles (small dot at segment midpoints)
 *   draw-vertex         Vertex handles (small circle at each vertex)
 *
 * The runtime feeds a single FeatureCollection through `setData`. Each
 * feature carries a `properties.kind` discriminator that the filters
 * below use to route it to the right layer.
 */

export const SOURCE_ID = 'cart-draw';

/** Layer ids — exported so the engine can hit-test against them. */
export const LAYERS = Object.freeze({
  fill: 'cart-draw-fill',
  lineCasing: 'cart-draw-line-casing',
  line: 'cart-draw-line',
  arrowHead: 'cart-draw-arrow-head',
  pointHalo: 'cart-draw-point-halo',
  point: 'cart-draw-point',
  pointLabel: 'cart-draw-point-label',
  vertexMid: 'cart-draw-vertex-mid',
  vertex: 'cart-draw-vertex',
});

/** Layer ids that should respond to feature hit-testing for selection. */
export const HIT_LAYERS = Object.freeze([
  LAYERS.point,
  LAYERS.pointHalo,
  LAYERS.line,
  LAYERS.fill,
  LAYERS.arrowHead,
]);

/** Layer ids that carry editing handles — used by edit drag logic. */
export const HANDLE_LAYERS = Object.freeze([LAYERS.vertex, LAYERS.vertexMid]);

/**
 * Build the source descriptor. The engine swaps `data` on every state
 * change via `setData`.
 */
export function makeSource() {
  return {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    // Drawing features are small and update frequently — disable
    // clustering and keep `tolerance` tight so editing handles snap
    // exactly where the user clicked.
    tolerance: 0.0,
    buffer: 64,
  };
}

/**
 * Compose the layer stack. Returns an array of layer specs ready to be
 * `map.addLayer`-ed.
 *
 * @param {object} [opts]
 * @param {string} [opts.color]   Default stroke colour.
 * @param {string} [opts.fill]    Default fill colour.
 * @param {number} [opts.weight]  Default stroke width.
 */
export function makeLayers({ color = '#c66809', fill = '#c66809', weight = 3 } = {}) {
  // `feature-state.selected` is toggled by the engine via setFeatureState.
  const selectedBoost = ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0];

  return [
    // ---- Fills --------------------------------------------------------
    {
      id: LAYERS.fill,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Polygon'],
        ['!=', ['get', 'kind'], 'arrow-head'],
      ],
      paint: {
        'fill-color': ['coalesce', ['get', 'fill'], fill],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 0.32,
          0.18,
        ],
        'fill-antialias': true,
      },
    },

    // ---- Line casings (halo under main strokes) -----------------------
    {
      id: LAYERS.lineCasing,
      type: 'line',
      source: SOURCE_ID,
      filter: ['any',
        ['==', '$type', 'LineString'],
        ['==', '$type', 'Polygon'],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'kind'], 'connection'],
            ['case',
              ['==', ['get', 'connectionMode'], 'optimal'], 'rgba(0, 0, 0, 0.32)',
              'rgba(0, 0, 0, 0.28)',
            ],
          'rgba(255, 255, 255, 0.85)',
        ],
        'line-width': [
          '+',
          ['+', ['coalesce', ['get', 'weight'], weight], 2.5],
          selectedBoost,
        ],
        'line-opacity': 0.85,
        'line-blur': 0.4,
      },
    },

    // ---- Main strokes -------------------------------------------------
    {
      id: LAYERS.line,
      type: 'line',
      source: SOURCE_ID,
      filter: ['any',
        ['==', '$type', 'LineString'],
        ['==', '$type', 'Polygon'],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'kind'], 'connection'],
            ['case',
              ['==', ['get', 'connectionMode'], 'optimal'], color,
              ['==', ['get', 'connectionMode'], 'mesh'],    'rgba(198, 104, 9, 0.7)',
              ['==', ['get', 'connectionMode'], 'hub'],     'rgba(0, 91, 187, 0.85)',
              color,
            ],
          ['coalesce', ['get', 'color'], color],
        ],
        'line-width': [
          '+',
          ['coalesce', ['get', 'weight'], weight],
          selectedBoost,
        ],
        'line-opacity': [
          'case',
          ['==', ['get', 'kind'], 'connection'],
            ['case',
              ['==', ['get', 'connectionMode'], 'mesh'], 0.65,
              0.9,
            ],
          ['coalesce', ['get', 'opacity'], 0.95],
        ],
        'line-dasharray': [
          'case',
          ['==', ['get', 'preview'], true], ['literal', [1.2, 1.2]],
          ['==', ['get', 'kind'], 'connection'],
            ['case',
              ['==', ['get', 'connectionMode'], 'mesh'], ['literal', [3, 2]],
              ['==', ['get', 'connectionMode'], 'hub'],  ['literal', [4, 2]],
              ['literal', [1, 0]],
            ],
          ['literal', [1, 0]],
        ],
      },
    },

    // ---- Arrow heads (always filled, never outlined) ------------------
    {
      id: LAYERS.arrowHead,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Polygon'],
        ['==', ['get', 'kind'], 'arrow-head'],
      ],
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], color],
        'fill-opacity': ['coalesce', ['get', 'opacity'], 0.95],
        'fill-antialias': true,
      },
    },

    // ---- Marker halo (under the dot) ----------------------------------
    {
      id: LAYERS.pointHalo,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['!=', ['get', 'kind'], 'vertex'],
        ['!=', ['get', 'kind'], 'vertex-mid'],
      ],
      paint: {
        'circle-radius': [
          '+',
          ['coalesce', ['get', 'radius'], 9],
          ['case',
            ['boolean', ['feature-state', 'selected'], false], 5,
            ['boolean', ['feature-state', 'hover'], false], 3,
            2,
          ],
        ],
        'circle-color': ['coalesce', ['get', 'color'], color],
        'circle-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 0.42,
          0.22,
        ],
        'circle-blur': 0.55,
      },
    },

    // ---- Marker dot ---------------------------------------------------
    {
      id: LAYERS.point,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['!=', ['get', 'kind'], 'vertex'],
        ['!=', ['get', 'kind'], 'vertex-mid'],
      ],
      paint: {
        'circle-radius': ['coalesce', ['get', 'radius'], 7],
        'circle-color': ['coalesce', ['get', 'color'], color],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 3,
          2,
        ],
        'circle-stroke-opacity': 1,
        'circle-pitch-alignment': 'map',
      },
    },

    // ---- Marker numeric label -----------------------------------------
    {
      id: LAYERS.pointLabel,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['==', ['get', 'kind'], 'marker'],
        ['has', 'order'],
      ],
      layout: {
        'text-field': ['to-string', ['get', 'order']],
        'text-size': 11,
        'text-font': ['Noto Sans Bold', 'Noto Sans Regular'],
        'text-anchor': 'center',
        'text-justify': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'symbol-z-order': 'source',
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0, 0, 0, 0.0)',
        'text-halo-width': 0,
      },
    },

    // ---- Midpoint handles (light) -------------------------------------
    {
      id: LAYERS.vertexMid,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['==', ['get', 'kind'], 'vertex-mid'],
      ],
      paint: {
        'circle-radius': 4,
        'circle-color': '#ffffff',
        'circle-stroke-color': color,
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.7,
        'circle-opacity': 0.75,
      },
    },

    // ---- Vertex handles (solid) ---------------------------------------
    {
      id: LAYERS.vertex,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['==', ['get', 'kind'], 'vertex'],
      ],
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'active'], false], 7,
          5.5,
        ],
        'circle-color': '#ffffff',
        'circle-stroke-color': color,
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 1,
        'circle-opacity': 1,
      },
    },
  ];
}

/** Find the highest place we can insert below — anywhere above the base
 *  but below interactive overlays. Returns null = append at the top. */
export function findInsertBeforeLayer(map) {
  try {
    const layers = map.getStyle()?.layers ?? [];
    // Insert above POIs / road shields but below MapLibre native controls.
    // Walk the style looking for symbol labels — they're usually the
    // top-most data-driven layers. Inserting just before them keeps the
    // drawing on top of geometry but below text so labels remain
    // readable.
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.type === 'symbol' && (l.id.includes('label') || l.id.includes('text'))) {
        return l.id;
      }
    }
  } catch {
    /* style not loaded yet */
  }
  return undefined;
}
