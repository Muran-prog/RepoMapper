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

/**
 * Separate source for the pairwise marker measure overlay (ruler).
 * Kept distinct from the main `cart-draw` source so the measure
 * features (which are derived from markers, never persisted) cannot
 * pollute the persistent feature collection on save and so the
 * measure layers can be added/removed independently of the editing
 * stack. See `measure.js` for the pure-function feature builder.
 */
export const MEASURE_SOURCE_ID = 'cart-draw-measure';

/** Layer ids — exported so the engine can hit-test against them. */
export const LAYERS = Object.freeze({
  fill: 'cart-draw-fill',
  lineCasing: 'cart-draw-line-casing',
  line: 'cart-draw-line',
  linePreview: 'cart-draw-line-preview',
  arrowHead: 'cart-draw-arrow-head',
  pointHalo: 'cart-draw-point-halo',
  point: 'cart-draw-point',
  pointLabel: 'cart-draw-point-label',
  vertexMid: 'cart-draw-vertex-mid',
  vertex: 'cart-draw-vertex',
  measureLine: 'cart-draw-measure-line',
  measureBadge: 'cart-draw-measure-badge',
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
 * Build the source descriptor for the pairwise measure overlay. Same
 * tolerance/buffer profile as the main draw source — the features
 * come from the same kind of authoring flow and benefit from identical
 * picking accuracy, even though the measure overlay itself is not
 * directly hit-tested.
 */
export function makeMeasureSource() {
  return {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
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

  // Fraction of the stroke opacity that the fill inherits. Keeps
  // polygons readable over busy basemaps without the user needing
  // a second "fill opacity" slider. Tuned so the chosen fill colour
  // reads clearly as itself (a green fill looks green, not a faint
  // wash) while still letting the basemap show through a little.
  const FILL_OPACITY_FRACTION = 0.62;
  /** `feature.opacity` with a sensible default, clamped to [0..1]. */
  const strokeOpacityExpr = ['max', 0, ['min', 1, ['coalesce', ['get', 'opacity'], 0.95]]];
  /** Fill opacity derived from stroke opacity × the fraction above. */
  const fillOpacityExpr = ['*', strokeOpacityExpr, FILL_OPACITY_FRACTION];

  return [
    // ---- Fills --------------------------------------------------------
    {
      id: LAYERS.fill,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Polygon'],
        ['!=', 'kind', 'arrow-head'],
      ],
      paint: {
        'fill-color': ['coalesce', ['get', 'fill'], fill],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
            ['min', 1, ['*', fillOpacityExpr, 1.5]],
          fillOpacityExpr,
        ],
        'fill-antialias': true,
      },
    },

    // ---- Line casings (halo under main strokes) -----------------------
    //
    // Auto-generated "mesh" lines get a slightly darker casing so that
    // dense all-to-all connections still read as grouped without the
    // white halo visually merging them into a fat blob. Everything
    // else keeps the standard white halo.
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
          ['==', ['get', 'autoMode'], 'mesh'], 'rgba(0, 0, 0, 0.30)',
          'rgba(255, 255, 255, 0.7)',
        ],
        // A thin contrast halo — just enough to lift the stroke off the
        // basemap. Kept narrow (≈1.4 px total bleed) so the user's own
        // colour stays the dominant, vivid part of the line rather than
        // being swallowed by a fat white casing.
        'line-width': [
          '+',
          ['+', ['coalesce', ['get', 'weight'], weight], 1.4],
          selectedBoost,
        ],
        'line-opacity': 0.6,
        'line-blur': 0.3,
      },
    },

    // ---- Main strokes -------------------------------------------------
    //
    // Auto-generated and user-drawn lines share the same paint: the
    // feature carries its own `color`, `weight`, `opacity`, so the
    // renderer doesn't need to know whether the line came from a
    // sequence auto-connect, a hand-drawn polyline, or an imported
    // GeoJSON. That's what lets mode changes leave existing lines
    // untouched — there is no mode-driven style to re-apply.
    //
    // The one special case is `autoMode === 'mesh'`: a dense all-to-
    // all graph is easier to read when its strokes are a little more
    // transparent. Everything else follows the feature's own opacity.
    {
      id: LAYERS.line,
      type: 'line',
      source: SOURCE_ID,
      // Committed / auto-gen geometry only. The in-flight dashed
      // preview is a separate layer below — MapLibre cannot drive
      // `line-dasharray` from feature properties, so the dash/solid
      // split has to live in two layers rather than one expression.
      filter: ['all',
        ['any',
          ['==', '$type', 'LineString'],
          ['==', '$type', 'Polygon'],
        ],
        ['!=', 'preview', true],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], color],
        'line-width': [
          '+',
          ['coalesce', ['get', 'weight'], weight],
          selectedBoost,
        ],
        'line-opacity': [
          'case',
          ['==', ['get', 'autoMode'], 'mesh'], ['*', strokeOpacityExpr, 0.6],
          strokeOpacityExpr,
        ],
      },
    },

    // ---- In-flight preview stroke (dashed authoring ghost) ------------
    // MapLibre rejects data-driven `line-dasharray`, so the dashed
    // rubber-band that distinguishes an in-progress draft from
    // committed geometry lives in its own layer keyed on the
    // `preview` flag. Committed lines never carry that flag and are
    // drawn solid by `draw-line` above.
    {
      id: LAYERS.linePreview,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all',
        ['any',
          ['==', '$type', 'LineString'],
          ['==', '$type', 'Polygon'],
        ],
        ['==', 'preview', true],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], color],
        'line-width': ['coalesce', ['get', 'weight'], weight],
        'line-opacity': strokeOpacityExpr,
        'line-dasharray': [1.2, 1.2],
      },
    },

    // ---- Arrow heads (always filled, never outlined) ------------------
    // Arrow heads use the STROKE colour (not the fill colour) since
    // they're a stylistic extension of the shaft, and the stroke
    // opacity so they stay fully opaque with the rest of the arrow.
    {
      id: LAYERS.arrowHead,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Polygon'],
        ['==', 'kind', 'arrow-head'],
      ],
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], color],
        'fill-opacity': strokeOpacityExpr,
        'fill-antialias': true,
      },
    },

    // ---- Marker halo (under the dot) ----------------------------------
    // The halo extends noticeably beyond the dot (~5 px under default
    // radius) so it reads as a halo rather than a one-pixel ring under
    // the white stroke — that was the old "first marker invisible"
    // bug. All circle layers use viewport alignment so tilted cameras
    // don't shrink the marker to zero.
    {
      id: LAYERS.pointHalo,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['!=', 'kind', 'vertex'],
        ['!=', 'kind', 'vertex-mid'],
      ],
      paint: {
        'circle-radius': [
          '+',
          ['coalesce', ['get', 'radius'], 8],
          ['case',
            ['boolean', ['feature-state', 'selected'], false], 8,
            ['boolean', ['feature-state', 'hover'], false], 5,
            4,
          ],
        ],
        'circle-color': ['coalesce', ['get', 'color'], color],
        'circle-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
            ['min', 1, ['*', strokeOpacityExpr, 0.5]],
          ['min', 1, ['*', strokeOpacityExpr, 0.28]],
        ],
        'circle-blur': 0.5,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    },

    // ---- Marker dot ---------------------------------------------------
    {
      id: LAYERS.point,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['!=', 'kind', 'vertex'],
        ['!=', 'kind', 'vertex-mid'],
      ],
      paint: {
        'circle-radius': ['coalesce', ['get', 'radius'], 8],
        'circle-color': ['coalesce', ['get', 'color'], color],
        'circle-opacity': strokeOpacityExpr,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 3,
          2,
        ],
        'circle-stroke-opacity': strokeOpacityExpr,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    },

    // ---- Marker numeric label -----------------------------------------
    // `displayOrder` is stamped by buildCollection() on every render
    // and reflects the ACTIVE connection mode (insertion order for
    // sequence, tour order for optimal). That way the number you see
    // on a marker always matches the route drawn through it.
    {
      id: LAYERS.pointLabel,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['==', 'kind', 'marker'],
        ['has', 'displayOrder'],
      ],
      layout: {
        'text-field': ['to-string', ['get', 'displayOrder']],
        'text-size': 11,
        // Single-font stack ONLY. OpenFreeMap's glyph server (and most
        // others) 404 on multi-font stacks like
        // `Noto Sans Bold,Noto Sans Regular` — and a 404 here fails the
        // whole symbol bucket, which collapses the ENTIRE cart-draw
        // tile, making every drawing (markers, lines, fills) vanish the
        // moment a numbered marker exists. Matches `tokens.js` font.bold.
        'text-font': ['Noto Sans Bold'],
        'text-anchor': 'center',
        'text-justify': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'symbol-z-order': 'source',
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0, 0, 0, 0.35)',
        'text-halo-width': 0.8,
      },
    },

    // ---- Midpoint handles (light) -------------------------------------
    {
      id: LAYERS.vertexMid,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all',
        ['==', '$type', 'Point'],
        ['==', 'kind', 'vertex-mid'],
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
        ['==', 'kind', 'vertex'],
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

/**
 * Compose the measure overlay layer stack. Returns `[line, badge]` —
 * a thin neutral line under each pairwise segment plus a glass-style
 * badge centred on its midpoint with the formatted distance.
 *
 * Both layers read everything they need from the feature properties
 * the `buildMeasureFeatures` helper stamps, so the renderer is fully
 * data-driven and the engine can swap the source contents on every
 * render without rebuilding the layer specs.
 *
 * The line is intentionally thin (1.5 px) and slightly translucent so
 * it never competes with the user's drawn lines. The badge uses a
 * white fill with a strong dark halo and a subtle accent halo on
 * top of that — readable on both bright satellite imagery and dark
 * cartographic basemaps without theming gymnastics.
 */
export function makeMeasureLayers() {
  return [
    {
      id: LAYERS.measureLine,
      type: 'line',
      source: MEASURE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'measure-line'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        // Neutral mid-grey reads on both light and dark basemaps; a
        // very short dash pattern signals "this is a measurement, not
        // a route" so users don't confuse it with auto-connections.
        'line-color': 'rgba(34, 38, 46, 0.85)',
        'line-width': 1.5,
        'line-opacity': 0.85,
        'line-dasharray': ['literal', [2, 2]],
      },
    },
    {
      id: LAYERS.measureBadge,
      type: 'symbol',
      source: MEASURE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'measure-badge'],
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        // Single-font stack ONLY — see the note on the marker label
        // layer above. A multi-font stack 404s on OpenFreeMap glyphs
        // and would collapse the entire measure-overlay tile.
        'text-font': ['Noto Sans Bold'],
        'text-anchor': 'center',
        'text-justify': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-padding': 4,
        'symbol-z-order': 'source',
      },
      paint: {
        // White glyph with a thick dark halo gives the "halo on text"
        // legibility the brief asks for. The pure-symbol approach
        // avoids the tile-rasterised badge backgrounds MapLibre lacks
        // a native primitive for and keeps the layer stack flat
        // (one symbol = one DOM allocation per render).
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(20, 24, 30, 0.92)',
        'text-halo-width': 2.2,
        'text-halo-blur': 0.6,
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
