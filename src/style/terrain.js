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
 *
 *  Exported so the unified helper below + the test harness can reason
 *  about the base curve without re-declaring it.
 */
export const HILLSHADE_STOPS = Object.freeze([
  [5, 0.30],
  [7, 0.42],
  [10, 0.55],
  [14, 0.65],
  [18, 0.65],
]);

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

// The hypso↔hillshade blend curve + the linear-interp helper live in
// `hypso/curves.js` because they're shared with `hypso/layers.js`. We
// re-export them here under their existing names so callers that
// imported them from `terrain.js` continue to work without churn.
import { HYPSO_HILLSHADE_BLEND, evalLinearStops } from './hypso/curves.js';
export { HYPSO_HILLSHADE_BLEND, evalLinearStops };

/**
 * Pure scalar evaluator for the FINAL hillshade-exaggeration at a
 * specific zoom, taking every contributor into account in one place:
 *
 *   final = base(zoom) × baseMul × userMul × hypsoBlend(zoom, strength)
 *
 *   where:
 *     base(zoom)        — HILLSHADE_STOPS interpolated at zoom
 *     baseMul           — per-direction multiplier (1.0/0.65/0.4/1.1)
 *     userMul           — exaggeration slider (0.5..2)
 *     hypsoBlend(z, s)  — 1 - s × (1 - HYPSO_HILLSHADE_BLEND(z))
 *                         (s clamped to [0,1] for the blend; strength
 *                         above 1.0 doesn't deepen the reduction)
 *
 * The result is clamped to [0, 1] because the MapLibre style spec
 * limits `hillshade-exaggeration` to that range.
 *
 * @param {object} opts
 * @param {number} opts.zoom
 * @param {number} [opts.baseMul=1]
 * @param {number} [opts.userMul=1]
 * @param {number} [opts.hypsoStrength=0]  0 = no blend (hypso off / s=0)
 * @param {boolean} [opts.hypsoActive=false] If false, blend is bypassed.
 * @param {boolean} [opts.reduceMotion=false]
 * @returns {number}
 */
export function evaluateHillshadeExaggeration({
  zoom,
  baseMul = 1,
  userMul = 1,
  hypsoStrength = 0,
  hypsoActive = false,
  reduceMotion = false,
}) {
  const base = reduceMotion ? 0.4 : evalLinearStops(HILLSHADE_STOPS, zoom);
  let blend = 1;
  if (hypsoActive && hypsoStrength > 0) {
    const s = Math.max(0, Math.min(1, Number(hypsoStrength) || 0));
    const factor = evalLinearStops(HYPSO_HILLSHADE_BLEND, zoom);
    blend = 1 - s * (1 - factor);
  }
  const raw = base * baseMul * (Number(userMul) || 0) * blend;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Build a `hillshade-exaggeration` expression that bakes in every
 * contributor. Returns a zoom interpolation when reduce-motion is off
 * (and constants otherwise) so MapLibre can re-evaluate per frame
 * without an extra JS hop. The same factors are also exposed via the
 * scalar `evaluateHillshadeExaggeration` for test / fallback paths.
 *
 * @param {object} opts  — same shape as evaluateHillshadeExaggeration,
 *                         except `zoom` is omitted.
 * @returns {Array|number}
 */
export function buildHillshadeExaggerationExpr(opts = {}) {
  const {
    baseMul = 1,
    userMul = 1,
    hypsoStrength = 0,
    hypsoActive = false,
    reduceMotion = false,
  } = opts;
  if (reduceMotion) {
    return evaluateHillshadeExaggeration({
      zoom: 0,
      baseMul,
      userMul,
      hypsoStrength,
      hypsoActive,
      reduceMotion: true,
    });
  }
  // Sample the analytic curve at every integer zoom from the lowest
  // contributing stop to the highest. We sample densely (not just at
  // the original `[zoom, value]` knots) because the spec clamps
  // `hillshade-exaggeration` to [0, 1], and MapLibre interpolates the
  // expression's stops linearly — without intermediate samples the
  // interpolation between a clamped stop (e.g. 1.0) and an unclamped
  // neighbour drifts noticeably from the analytic curve.
  //
  // Sampling at every integer zoom keeps the worst-case interpolation
  // error well below 1 % of the curve's range, which the test harness
  // verifies.
  const allZooms = [
    ...HILLSHADE_STOPS.map((s) => s[0]),
    ...HYPSO_HILLSHADE_BLEND.map((s) => s[0]),
  ];
  const lo = Math.floor(Math.min(...allZooms));
  const hi = Math.ceil(Math.max(...allZooms));
  const stops = [];
  for (let z = lo; z <= hi; z++) {
    stops.push([
      z,
      Number(evaluateHillshadeExaggeration({
        zoom: z,
        baseMul,
        userMul,
        hypsoStrength,
        hypsoActive,
        reduceMotion: false,
      }).toFixed(4)),
    ]);
  }
  return linZoom(stops);
}

/**
 * Backwards-compatible thin wrapper around the new helper. Kept under
 * its old name so any external consumer (or a stale validator import)
 * doesn't break. New code should call `buildHillshadeExaggerationExpr`
 * directly so hypso state is propagated.
 *
 * @param {number} mul   Combined baseMul × userMul.
 * @param {boolean} reduceMotion
 */
export function hillshadeExaggeration(mul, reduceMotion) {
  return buildHillshadeExaggerationExpr({
    baseMul: 1,
    userMul: mul,
    hypsoActive: false,
    reduceMotion,
  });
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
      // Initial value is the base curve with the per-direction mul; the
      // hypso lifecycle in `interactions.js` overwrites this with the
      // unified expression (base × userMul × hypso blend) on every
      // styledata so the live result tracks state correctly. The
      // transition is collapsed to 0 so subsequent setPaintProperty
      // updates don't drift through 220ms easing — that was the source
      // of the "hillshade flickers" symptom when the user dragged the
      // exaggeration slider or toggled hypso.
      'hillshade-exaggeration': buildHillshadeExaggerationExpr({
        baseMul: mul,
        userMul: 1,
        hypsoActive: false,
        reduceMotion,
      }),
      'hillshade-exaggeration-transition': { duration: 0, delay: 0 },
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
// Sky-View Factor overlay.
//
// SVF is a pre-rendered greyscale raster whose pixel values encode the
// fraction of the upper hemisphere visible from each ground point —
// dark = enclosed (canyon, cirque, narrow valley), light = open. We
// stack it ABOVE the hillshade so it darkens the same pixels that
// hillshade leaves flat (low azimuth coverage), surfacing detail that
// single-direction illumination smears out.
//
// MapLibre doesn't expose a per-layer blend mode, so we approximate
// "multiply" with `raster-saturation: -1` (force greyscale) +
// zoom-aware `raster-opacity` + a small negative `raster-brightness-min`
// so light SVF pixels (open ridges) leave the underlying hillshade
// untouched while dark SVF pixels (canyons) darken it.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SkyViewFactorOpts
 * @property {boolean} [reduceMotion=false]
 */

/**
 * @param {object} _t
 * @param {SkyViewFactorOpts} [opts]
 * @returns {Array<object>}
 */
export function skyViewFactorLayers(_t, opts = {}) {
  const { reduceMotion = false } = opts;
  // Mute below z9: at overview zooms the canyon detail isn't readable
  // and the layer just darkens the hillshade. Peak strength lands near
  // z12-z14 where the user can resolve individual ravines.
  const opacity = reduceMotion
    ? 0.35
    : linZoom([
        [8, 0.0],
        [9, 0.25],
        [11, 0.45],
        [13, 0.5],
        [16, 0.45],
      ]);
  return [
    {
      id: 'sky_view_factor',
      type: 'raster',
      source: 'sky-view-factor',
      // SVF gets useful only inside the alpine detail zooms.
      minzoom: 9,
      paint: {
        'raster-opacity': opacity,
        // Force greyscale — even if the source PNG had any chroma
        // (it shouldn't), the multiply effect must read as a pure
        // luminance modulation.
        'raster-saturation': -1,
        // Push the bright end down a touch so high-SVF (open) pixels
        // don't lighten the underlying hillshade.
        'raster-contrast': 0.1,
        'raster-resampling': 'linear',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ESA WorldCover landcover-tint overlay.
//
// Multiply-blend raster painted on top of the hillshade stack so the
// underlying landuse polygons get supplemented by the actual 10 m
// satellite classification. Reads from the colour table baked into
// `worldcover-ramps.js` via the offline `tools/dump-worldcover-ramp.mjs`
// pipeline, so the rendered tile pixels and the live tokens stay in
// lock-step at every theme.
//
// MapLibre doesn't expose a literal "multiply" blend mode for raster
// layers, so we approximate it with:
//
//   • Low opacity ceiling (~0.32 default; ~0.18 when hypso is active)
//     so the underlying landuse / hillshade still reads through.
//   • `raster-saturation: -0.15` to take the edge off the ramp's
//     already low-saturation hex values.
//   • `raster-contrast: +0.05` to keep classes distinguishable after
//     opacity dampening.
//   • Z-order placement above hillshade and below texture-shading
//     (handled by `composeLayers` — see src/style/index.js).
// ---------------------------------------------------------------------------

import { WORLDCOVER_OPACITY } from './worldcover-ramps.js';
import { CANOPY_OPACITY } from './canopy-height-ramps.js';

/**
 * @typedef {object} WorldcoverOpts
 * @property {boolean} [hypsoActive=false]
 *           When true, scale the opacity ceiling down to
 *           `WORLDCOVER_OPACITY.hypsoActive` so the elevation tint
 *           stays the dominant colour signal.
 * @property {boolean} [reduceMotion=false]
 *           When true, collapse the zoom-driven opacity curve to a
 *           static value (the curve's mid-zoom peak).
 */

/**
 * Build the WorldCover landcover-tint layer.
 *
 * Source: `'worldcover'` (added by `composeSources` when
 * `features.worldcoverTint` is true and `TERRAIN.worldcover.url` is
 * set). The layer is silently skipped by `composeLayers` when the
 * source isn't present, so this factory always returns a single
 * layer spec without worrying about availability itself.
 *
 * @param {object} _t
 * @param {WorldcoverOpts} [opts]
 * @returns {Array<object>}
 */
export function composeWorldcoverLayer(_t, opts = {}) {
  const { hypsoActive = false, reduceMotion = false } = opts;
  // Shape the zoom curve so the overlay is a hint at the country
  // overview (z6-9), reads at full strength in the regional / hiking
  // zoom band (z11-15) and fades out at deep zooms where roads, POIs
  // and labels need the cleanest possible base.
  //
  // The peak is rescaled to `WORLDCOVER_OPACITY.hypsoActive` when the
  // elevation tint is on so the two never compete for the same hue
  // budget. Both curves preserve the same shape so the user perceives
  // a smooth dampening rather than a sudden drop.
  const peak = hypsoActive
    ? WORLDCOVER_OPACITY.hypsoActive
    : WORLDCOVER_OPACITY.default;
  // Linear scale relative to the default 0.32 peak so the high-zoom
  // fade-out behaves the same in both regimes.
  const scale = peak / WORLDCOVER_OPACITY.default;
  const opacityStops = [
    [6, 0.15 * scale],
    [9, 0.28 * scale],
    [12, 0.32 * scale],
    [15, 0.32 * scale],
    [18, 0.22 * scale],
  ];
  // Reduce-motion: pin to the mid-zoom peak. Static, no animation.
  const opacity = reduceMotion ? 0.32 * scale : linZoom(opacityStops);
  return [
    {
      id: 'worldcover-tint',
      type: 'raster',
      source: 'worldcover',
      minzoom: 6,
      maxzoom: 22,
      paint: {
        'raster-opacity': opacity,
        // Slightly desaturate so the ramp colours stay quiet under
        // multiply-style blending — the per-class tints in
        // worldcover-ramps.js are already low-saturation, this just
        // takes the last edge off.
        'raster-saturation': -0.15,
        // Small positive contrast to keep classes distinguishable
        // after the opacity curve clamps the wash to ~0.32.
        'raster-contrast': 0.05,
        'raster-hue-rotate': 0,
        'raster-resampling': 'linear',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ETH Global Canopy Height tint overlay (Lang et al. 2023).
//
// Multiply-blend raster painted ABOVE the WorldCover tree-cover wash
// so that the flat green tree-cover class gets modulated by per-pixel
// canopy top height. Молоді посадки (height ≤ ~5 m) read as a light
// grass-green; старі смерекові ліси Чорногори (height ≥ ~30 m) read
// as a deep emerald; букові праліси Угольки (height ≥ ~40 m) read as
// the darkest pixels. Pixels with height = 0 (non-forest) are fully
// transparent — the overlay must NEVER tint a meadow / village /
// road / water surface.
//
// The colour ramp + alpha schedule live in
// `src/style/canopy-height-ramps.js`. The offline build pipeline
// (`tools/build-canopy-height.sh` + `tools/dump-canopy-ramp.mjs`)
// reads the same dictionary, so the rendered tile pixels and the live
// tokens stay in lock-step at every theme.
//
// MapLibre doesn't expose a literal "multiply" blend mode for raster
// layers, so we approximate it with:
//
//   • Zoom-driven opacity ceiling (default ~0.45) — peaks at the
//     hiking zoom band (z10-15) where stand-age detail reads, fades
//     out at z18+ so it doesn't crowd POIs / trail-overlay symbols.
//   • `raster-saturation: -0.10` to take the edge off the ramp's
//     already low-saturation greens.
//   • `raster-contrast: +0.08` to keep stand ages distinguishable
//     after opacity dampening.
//   • `raster-resampling: 'linear'` so the 10 m source softens into
//     a smooth wash at low zooms instead of pixelating.
//   • Z-order placement above WorldCover and below texture-shading
//     (handled by `composeLayers` — see src/style/index.js).
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CanopyHeightOpts
 * @property {boolean} [hypsoActive=false]
 *           When true, scale the opacity ceiling DOWN to
 *           `CANOPY_OPACITY.hypsoActive` so the elevation tint stays
 *           the dominant colour signal.
 * @property {boolean} [worldcoverActive=false]
 *           When true, scale the opacity ceiling UP to
 *           `CANOPY_OPACITY.worldcoverActive` so the canopy detail
 *           reads through the WorldCover tree-cover wash.
 *           When BOTH `hypsoActive` and `worldcoverActive` are true
 *           we take the MIN multiplier (more conservative): hypso
 *           suppression wins so the elevation tint still dominates.
 * @property {boolean} [reduceMotion=false]
 *           When true, collapse the zoom-driven opacity curve to a
 *           static value (the curve's mid-zoom peak).
 */

/**
 * Build the canopy-height-tint layer.
 *
 * Source: `'canopy-height'` (added by `composeSources` when
 * `features.canopyHeightTint` is true and `TERRAIN.canopyHeight.url`
 * is set). The layer is silently skipped by `composeLayers` when the
 * source isn't present, so this factory always returns a single
 * layer spec without worrying about availability itself.
 *
 * @param {object} _t
 * @param {CanopyHeightOpts} [opts]
 * @returns {Array<object>}
 */
export function composeCanopyHeightLayer(_t, opts = {}) {
  const {
    hypsoActive = false,
    worldcoverActive = false,
    reduceMotion = false,
  } = opts;

  // Pick the opacity peak. When both hypso and WorldCover are on we
  // take the MIN multiplier: hypso suppression wins over WorldCover
  // reinforcement so the elevation tint stays the dominant signal.
  // The brief explicitly asks for "min (более консервативно)".
  const hypsoMul = CANOPY_OPACITY.hypsoActive / CANOPY_OPACITY.default;
  const worldcoverMul = CANOPY_OPACITY.worldcoverActive / CANOPY_OPACITY.default;
  let mul = 1;
  if (hypsoActive && worldcoverActive) {
    mul = Math.min(hypsoMul, worldcoverMul);
  } else if (hypsoActive) {
    mul = hypsoMul;
  } else if (worldcoverActive) {
    mul = worldcoverMul;
  }
  const peak = CANOPY_OPACITY.default * mul;

  // Zoom curve mirrors the brief's schedule:
  //   z8  → 0.20   (overview — hint of forest depth)
  //   z10 → 0.35   (regional — readable)
  //   z12 → peak   (hiking band — full strength)
  //   z15 → peak   (still full strength for trail planning)
  //   z18 → 0.30   (deep zoom — yield to spritemap + POI legibility)
  //
  // We scale every stop by the same `mul` so the high-zoom fade-out
  // behaves the same shape regardless of state combination.
  const scale = peak / CANOPY_OPACITY.default;
  const opacityStops = [
    [8,  0.20 * scale],
    [10, 0.35 * scale],
    [12, CANOPY_OPACITY.default * scale],
    [15, CANOPY_OPACITY.default * scale],
    [18, 0.30 * scale],
  ];
  // Reduce-motion: pin to mid-zoom peak. Static, no animation.
  const opacity = reduceMotion ? CANOPY_OPACITY.default * scale : linZoom(opacityStops);

  return [
    {
      id: 'canopy-height-tint',
      type: 'raster',
      source: 'canopy-height',
      minzoom: 8,
      maxzoom: 22,
      paint: {
        'raster-opacity': opacity,
        // Pull saturation down a touch — the ramp's greens are
        // already low-saturation, this just keeps the multiply-blend
        // honest under the WorldCover wash.
        'raster-saturation': -0.10,
        // Small positive contrast so stand ages stay distinguishable
        // after the opacity curve dampens the wash.
        'raster-contrast': 0.08,
        'raster-resampling': 'linear',
      },
    },
  ];
}
//
// Native `color-relief` layer driven by the `['slope']` expression
// (MapLibre 5.6+). Reads the carpathian high-resolution DEM when
// available, otherwise the primary DEM. Renders steep slopes
// (>= 35°) in a translucent red wash whose intensity grows with
// slope angle. Tokens for the three intensity stops live in
// `tokens.slopeWarning` so the overlay re-themes between light and
// dark without code changes.
//
// Graceful fallback: when the runtime doesn't support color-relief or
// the slope expression, the layer is dropped by hypso/detect.js — see
// `detectColorReliefCaps`.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SlopeWarningOpts
 * @property {boolean} [hasCarpathianSource=false]
 *           When true, prefer the high-resolution DEM source.
 * @property {string} [theme='light']
 */

/**
 * Build the slope-warning color-relief layer. Always returns a single
 * layer spec — the caller is responsible for skipping it when the
 * runtime can't render it.
 *
 * @param {object} t
 * @param {SlopeWarningOpts} [opts]
 * @returns {Array<object>}
 */
export function slopeWarningLayers(t, opts = {}) {
  const { hasCarpathianSource = false } = opts;
  const tokens = t?.slopeWarning ?? {};
  // Sensible fallbacks if the theme is missing the tokens (shouldn't
  // happen post-install but keeps the layer alive during a partial
  // tokens.js edit).
  const soft = tokens.soft ?? 'rgba(255, 80, 40, 0.25)';
  const mid = tokens.mid ?? 'rgba(255, 40, 20, 0.45)';
  const severe = tokens.severe ?? 'rgba(180, 0, 0, 0.6)';
  const transparent = 'rgba(0, 0, 0, 0)';
  const source = hasCarpathianSource ? SOURCE_CARPATHIAN : SOURCE_PRIMARY;
  return [
    {
      id: 'slope_warning',
      type: 'color-relief',
      source,
      minzoom: 11,
      maxzoom: 22,
      metadata: { 'cart:slopeWarning': true },
      paint: {
        // Slope values are in degrees, 0..90. We hold transparent up
        // to 30°, fade in soft at 35°, mid at 45°, severe at 60°+.
        'color-relief-color': [
          'interpolate',
          ['linear'],
          ['slope'],
          0,
          transparent,
          30,
          transparent,
          35,
          soft,
          45,
          mid,
          60,
          severe,
        ],
        'color-relief-opacity': 1,
        'color-relief-opacity-transition': { duration: 0, delay: 0 },
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
