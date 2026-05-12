/**
 * Terrain & atmosphere — relief layers plus the root-level `sky`,
 * `terrain` and `projection` style blocks.
 *
 * MapLibre v5's style-spec separates "sky" and "terrain" from the layer
 * array: they live at the style root, not as layer types. This module
 * provides three kinds of outputs:
 *
 *   hillshadeLayers(t, opts)  → Array<LayerSpec>  — 1 or 3 stacked
 *   textureShadingLayers(t)   → Array<LayerSpec>
 *   hypsometricTintLayers(t)  → Array<LayerSpec>
 *   colorReliefLayers(t)      → Array<LayerSpec>  — feature-flagged native
 *
 *   composeSky(t, opts)        → Object (root-level `sky` block)
 *   composeTerrain(opts)       → Object | null  (root-level `terrain`)
 *   composeProjection(opts)    → Object | null  (root-level `projection`)
 *
 * Everything reads from tokens; nothing hard-codes a colour.
 *
 * Hillshade stacking (Swiss-style, Imhof-inspired)
 * ------------------------------------------------
 * When `multiDir` is on we emit three hillshade layers with weighted
 * illumination directions so ridges pick up bright/dark accents from two
 * angles at once, giving the characteristic sculpted feel. Each layer
 * uses `method: 'standard'` (MapLibre's legacy algorithm, which blends
 * nicely when stacked). Using the built-in `multidirectional` method on
 * a single layer gives decent results but less control over per-direction
 * exaggeration — and no way to use different colour pairs per direction,
 * which is central to the Swiss look.
 *
 * Reduce-motion
 * -------------
 * When `reduceMotion` is true, the `composeTerrain` exaggeration function
 * collapses to 0 so the scene never tilts into a height-dependent frame,
 * and the hillshade exaggeration loses its zoom ramp (static value).
 */

import { linZoom } from '../utils/interp.js';

/** Primary DEM source id, shared by hillshade / terrain / contours. */
const SOURCE_PRIMARY = 'terrain-dem';
/** Carpathian high-resolution DEM. */
const SOURCE_CARPATHIAN = 'terrain-dem-carpathian';

// ---------------------------------------------------------------------------
// Hillshade layer factory.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HillshadeOpts
 * @property {boolean} [multiDir=false]   Stack 3 direction layers Swiss-style.
 * @property {boolean} [carpathian=false] Also emit a higher-zoom layer
 *                                         backed by the Carpathian DEM.
 * @property {boolean} [hasCarpathianSource=false] Truthy only when the
 *                                         Carpathian DEM source exists.
 * @property {boolean} [reduceMotion=false] Static (no zoom-ramped) exaggeration.
 */

/** Default per-zoom exaggeration stops. Pre-multiplied into the stops by
 *  the caller — the MapLibre style spec forbids wrapping a zoom expression
 *  in arithmetic, so we scale values in JS before building the `interpolate`.
 */
const HILLSHADE_STOPS = [
  [5, 0.1],
  [7, 0.3],
  [10, 0.45],
  [14, 0.55],
];

/**
 * Layer-metadata key that records each hillshade layer's per-direction
 * baseline multiplier (1.0 / 0.65 / 0.4 for the Swiss stack, 1.1 for the
 * Carpathian high-res). interactions.js reads it from `map.getStyle()` to
 * recompute `hillshade-exaggeration` whenever the user moves the
 * exaggeration slider — without it the slider only affects 3D terrain
 * (which itself is invisible at low zoom / flat pitch, so the user
 * perceives the slider as broken).
 */
export const HILLSHADE_BASE_MUL_META = 'cart:hillshadeBaseMul';

/**
 * Build a `hillshade-exaggeration` expression. Reduce-motion collapses to
 * a flat number; otherwise we return a linear zoom interp with values
 * pre-scaled by `mul`.
 *
 * Exported so interactions.js can rebuild the expression at runtime when
 * the slider changes the user-facing multiplier.
 */
export function hillshadeExaggeration(mul, reduceMotion) {
  if (reduceMotion) return 0.4 * mul;
  return linZoom(HILLSHADE_STOPS.map(([z, v]) => [z, v * mul]));
}

/**
 * One hillshade spec. `id`, `direction` and per-direction exaggeration
 * multiplier come from the caller; everything colour-related is tokenised.
 */
function oneHillshade(t, { id, source, direction, exaggerationMul, method, reduceMotion, minzoom, maxzoom }) {
  const mul = typeof exaggerationMul === 'number' ? exaggerationMul : 1;
  const layer = {
    id,
    type: 'hillshade',
    source,
    // Stash the baseline mul so interactions.js can scale it by the user's
    // slider at runtime without losing the per-direction differentiation.
    metadata: { [HILLSHADE_BASE_MUL_META]: mul },
    paint: {
      'hillshade-shadow-color': t.hillshadeShadow,
      'hillshade-highlight-color': t.hillshadeHighlight,
      'hillshade-accent-color': t.hillshadeAccent,
      'hillshade-illumination-direction': direction,
      'hillshade-illumination-anchor': 'viewport',
      'hillshade-method': method ?? 'standard',
      'hillshade-exaggeration': hillshadeExaggeration(mul, reduceMotion),
    },
  };
  if (typeof minzoom === 'number') layer.minzoom = minzoom;
  if (typeof maxzoom === 'number') layer.maxzoom = maxzoom;
  return layer;
}

/**
 * @param {object} t
 * @param {HillshadeOpts} [opts]
 * @returns {Array<object>}
 */
export function hillshadeLayers(t, opts = {}) {
  const {
    multiDir = false,
    carpathian = false,
    hasCarpathianSource = false,
    reduceMotion = false,
  } = opts;

  const layers = [];

  if (!multiDir) {
    // Single standard hillshade — the low/medium-profile baseline.
    layers.push(
      oneHillshade(t, {
        id: 'hillshade_primary',
        source: SOURCE_PRIMARY,
        direction: 335,
        exaggerationMul: 1,
        reduceMotion,
      }),
    );
  } else {
    // Swiss-style stack. Azimuths 315° (NW, dominant), 270° (W, softens
    // E-W ridges), 0° (N, top-down wash). Weights drop on the tertiary
    // direction so ridges don't get over-saturated.
    layers.push(
      oneHillshade(t, {
        id: 'hillshade_nw',
        source: SOURCE_PRIMARY,
        direction: 315,
        exaggerationMul: 1,
        reduceMotion,
      }),
      oneHillshade(t, {
        id: 'hillshade_w',
        source: SOURCE_PRIMARY,
        direction: 270,
        exaggerationMul: 0.65,
        reduceMotion,
      }),
      oneHillshade(t, {
        id: 'hillshade_top',
        source: SOURCE_PRIMARY,
        direction: 0,
        exaggerationMul: 0.4,
        reduceMotion,
      }),
    );
  }

  // Optional Carpathian high-resolution DEM hillshade — kicks in at the
  // Carpathian-OSM detail zoom (>= 9) so the transition hides under the
  // detail layers. When the Carpathian source is missing, we simply don't
  // emit this layer (callers pass hasCarpathianSource=false).
  if (carpathian && hasCarpathianSource) {
    layers.push(
      oneHillshade(t, {
        id: 'hillshade_carpathian',
        source: SOURCE_CARPATHIAN,
        direction: 315,
        exaggerationMul: 1.1,
        reduceMotion,
        minzoom: 9,
      }),
    );
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Texture shading — raster PNG overlay (pre-rendered via tools/build-texture-shading.sh).
// Multiply blending against hillshade would be ideal but MapLibre doesn't
// expose a blend mode; we rely on a sane opacity ramp instead.
// ---------------------------------------------------------------------------

export function textureShadingLayers(t, { reduceMotion = false } = {}) {
  // Low zooms the texture reads as noise; fade it in around z=8 where
  // ridges have detail worth emphasising.
  const opacity = reduceMotion
    ? 0.4
    : linZoom([
        [6, 0.0],
        [8, 0.25],
        [11, 0.4],
        [14, 0.5],
      ]);
  return [
    {
      id: 'texture_shading',
      type: 'raster',
      source: 'texture-shading',
      paint: {
        'raster-opacity': opacity,
        'raster-resampling': 'linear',
        'raster-contrast': 0.05,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Hypsometric tint — delegated to the dedicated hypso subsystem so the
// renderer can pick between native MapLibre `color-relief`, pre-rendered
// raster PMTiles, or simply "off". See `src/style/hypso/` for the ramp
// dictionary, expression generator, LAB densification and runtime
// paint-property surface.
//
// The old single-archive `hypso_tint` layer is preserved here behind an
// explicit `legacy: true` flag for backwards compatibility with style
// builds that point `TERRAIN.hypsometric.url` at a generic archive built
// against `tokens.hypsoStops` instead of one of the named ramp presets.
// New code should call `composeHypsoLayers` from `src/style/hypso`.
// ---------------------------------------------------------------------------

import { composeHypsoLayers } from './hypso/layers.js';
import {
  getRampStops,
  DEFAULT_RAMP_ID,
} from './hypso/ramps.js';
import { DEFAULT_STRENGTH_STOPS } from './hypso/expression.js';

/**
 * @typedef {object} HypsoTintOpts
 * @property {'native'|'raster'|'off'} mode
 * @property {string}  rampId
 * @property {'light'|'dark'} theme
 * @property {number}  strength       0..1.5 multiplier on the opacity curve.
 * @property {boolean} bathymetry     Include negative-elevation stops.
 * @property {string|null} [rasterSourceId] Source id for raster mode.
 * @property {Array<[number, number]>} [strengthStops]
 */

/**
 * Compose the active hypsometric tint layer(s). Pure — no side effects.
 *
 * @param {object} _t Tokens (unused here, ramps come from `ramps.js`).
 * @param {HypsoTintOpts} opts
 * @returns {Array<object>}
 */
export function hypsometricTintLayers(_t, opts) {
  const {
    mode,
    rampId = DEFAULT_RAMP_ID,
    theme = 'light',
    strength = 1.0,
    bathymetry = true,
    rasterSourceId = null,
    strengthStops = DEFAULT_STRENGTH_STOPS,
  } = opts ?? {};
  const stops = getRampStops(rampId, theme);
  return composeHypsoLayers({
    mode,
    rampId,
    stops,
    strength,
    bathymetry,
    rasterSourceId,
    strengthStops,
  });
}

/**
 * Legacy hypsometric tint — single raster PMTiles built against the
 * pre-hypso-subsystem ramp baked into tokens.hypsoStops. Emitted ONLY
 * when the caller asks for it explicitly via `legacy: true`. Tracked
 * here only to keep existing self-hosted builds rendering until the
 * operator migrates to the new ramp dictionary.
 *
 * @param {object} _t
 * @returns {Array<object>}
 */
export function legacyHypsoTintLayer(_t) {
  return [
    {
      id: 'hypso_tint',
      type: 'raster',
      source: 'hypso-tint',
      paint: {
        'raster-opacity': linZoom([
          [3, 0.35],
          [6, 0.5],
          [10, 0.45],
          [14, 0.2],
          [16, 0.0],
        ]),
        'raster-resampling': 'linear',
      },
    },
  ];
}

/**
 * Bathymetry — pre-rendered seabed tint that sits *below* the
 * hypsometric ramp so the 0 m boundary is the only seam. The Black-Sea
 * trough is much deeper than any DEM tile we have (Terrarium maxes out
 * around 0 m offshore), so this layer fills in the visual gap.
 *
 * @param {object} _t
 * @returns {Array<object>}
 */
export function bathymetryLayers(_t) {
  return [
    {
      id: 'bathymetry',
      type: 'raster',
      source: 'bathymetry',
      paint: {
        'raster-opacity': linZoom([
          [3, 0.85],
          [6, 0.75],
          [10, 0.6],
          [13, 0.45],
        ]),
        'raster-resampling': 'linear',
      },
    },
  ];
}

/**
 * Deprecated. Use `hypsometricTintLayers(t, { mode: 'native', … })`.
 * Kept around so any external consumer importing this name doesn't
 * suddenly crash; emits the same native-path layer as the new helper.
 */
export function colorReliefLayers(t, opts) {
  return hypsometricTintLayers(t, { mode: 'native', ...opts });
}

// ---------------------------------------------------------------------------
// Root-level blocks
// ---------------------------------------------------------------------------

/**
 * Sky / atmosphere root block. Purely token-driven; the blend ratios
 * express the amount of each colour at different parts of the sky sphere.
 *
 * @param {object} t
 * @param {object} [opts]
 * @param {boolean} [opts.reduceMotion]
 */
export function composeSky(t, opts = {}) {
  const { reduceMotion = false } = opts;
  return {
    'sky-color': t.skyTop,
    'horizon-color': t.skyHorizon,
    'fog-color': t.skyFog,
    // Blend ratios — roughly Swiss-atlas feel. We still expose a light
    // zoom interp on atmosphere-blend so the sky reads as a sharp band at
    // low zoom and fades out at deep zoom where pitch is usually 0.
    'sky-horizon-blend': 0.55,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.5,
    'atmosphere-blend': reduceMotion
      ? 0.4
      : linZoom([
          [3, 0.8],
          [7, 0.5],
          [12, 0.15],
        ]),
  };
}

/**
 * @typedef {object} TerrainOpts
 * @property {boolean} enable            Master 3D-terrain toggle.
 * @property {boolean} hasPrimaryDem     Whether the DEM source exists.
 * @property {number}  [initialExaggeration=1]
 *     Starting value applied at style-install time. interactions.js
 *     refreshes this imperatively on zoomend using `evalExaggeration`.
 */

/**
 * @param {TerrainOpts} opts
 * @returns {object|null} Root-level `terrain` block, or null when 3D is
 *                        off / DEM is missing / reduce-motion collapses it.
 */
export function composeTerrain(opts) {
  const {
    enable,
    hasPrimaryDem,
    initialExaggeration = 1,
  } = opts;

  if (!enable || !hasPrimaryDem || initialExaggeration <= 0) return null;

  // MapLibre's style spec defines `terrain.exaggeration` as a plain
  // `number` — it does NOT accept zoom-driven expressions (unlike paint
  // properties). Zoom adaptation is applied imperatively via
  // `map.setTerrain({source, exaggeration})` in interactions.js, using
  // `evalExaggeration` below for the curve.
  return {
    source: SOURCE_PRIMARY,
    exaggeration: initialExaggeration,
  };
}

/**
 * Evaluate a zoom-adaptive exaggeration curve at a given zoom level.
 * Mirrors the linZoom helper's interpolation so UI slider multipliers
 * apply identically here and in the hillshade layers.
 *
 * @param {number} zoom
 * @param {Array<[number, number]>} stops
 * @param {number} [mul=1]
 * @returns {number}
 */
export function evalExaggeration(zoom, stops, mul = 1) {
  if (!Array.isArray(stops) || stops.length === 0) return mul;
  if (zoom <= stops[0][0]) return stops[0][1] * mul;
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1] * mul;
  for (let i = 0; i < stops.length - 1; i++) {
    const [z0, v0] = stops[i];
    const [z1, v1] = stops[i + 1];
    if (zoom >= z0 && zoom <= z1) {
      const f = z1 === z0 ? 0 : (zoom - z0) / (z1 - z0);
      return (v0 + (v1 - v0) * f) * mul;
    }
  }
  return mul;
}

/**
 * @typedef {object} ProjectionOpts
 * @property {boolean} globe  Use `type: globe` (v5).
 */

/**
 * @param {ProjectionOpts} opts
 * @returns {object|null}
 */
export function composeProjection(opts) {
  if (!opts?.globe) return null;
  // The `['interpolate', 'linear', ['zoom'], Z_low, 'vertical-perspective', Z_high, 'mercator']`
  // form is supported in MapLibre v5 and gives us a smooth globe→flat
  // transition. Below z=5 we're on the globe; at z≥7 we're Mercator-flat.
  return {
    type: [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      'vertical-perspective',
      5,
      'vertical-perspective',
      7,
      'mercator',
    ],
  };
}
