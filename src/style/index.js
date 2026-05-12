/**
 * Style composer — assembles the full layer stack in the correct paint order.
 *
 * The order matters. MapLibre paints in declaration order, so layers
 * earlier in the array render below layers later in the array. This
 * module owns the canonical z-order for the entire project:
 *
 *    1. background                 — paper colour
 *    2. landcover                  — wood, grass, sand, ice, rock
 *    3. landuse                    — residential, industrial, cemetery, …
 *    4. parks                      — green polygons + outline
 *    5. water-fill                 — lake / ocean polygons (below relief)
 *    6. hypsometric tint           — raster elevation-tinted PNG
 *    7. color-relief (native)      — DEM-driven ramp (feature-flagged)
 *    8. hillshade stack            — 1× or 3× (Swiss-style) + Carpathian
 *    9. texture-shading            — Leland Brown fractional-Laplacian PNG
 *   10. contours (minor → major)   — topographic isolines
 *   11. contour labels             — line-placed elevation text
 *   12. ridges (dark → light)      — Imhof-style double-stroke
 *   13. waterways                  — rivers / canals / streams (above relief)
 *   14. aeroway                    — runways / taxiways
 *   15. roads                      — tunnel → ground → rail → bridge
 *   16. trail emphasis (Carpathian)— casing + dashed inline
 *   17. buildings                  — 2D + 3D extrusion
 *   18. boundaries                 — country / oblast / raion / city
 *   19. cableway / ski piste       — mountain auxiliaries
 *   20. labels                     — places, roads, water, parks, POIs
 *   21. Carpathian labels          — peaks / passes / saddles (top priority)
 *
 * Each relief-specific group is gated by BOTH the feature flag and the
 * availability of its source — the style composer never emits a layer
 * referencing a source that wasn't added to the sources dict.
 */

import {
  baseBackground,
  baseLandcover,
  baseLanduse,
  baseParks,
  baseWaterFill,
  baseWaterways,
  baseAeroway,
} from './base.js';
import { roadLayers } from './roads.js';
import { buildingLayers } from './buildings.js';
import { boundaryLayers } from './boundaries.js';
import { labelLayers } from './labels.js';
import {
  hillshadeLayers,
  textureShadingLayers,
  hypsometricTintLayers,
  colorReliefLayers,
} from './terrain.js';
import { contourLayers } from './contours.js';
import {
  ridgeLayers,
  trailLayers,
  carpathianLabels,
  cablewayLayers,
} from './carpathian.js';
import { getTokens } from './tokens.js';

/**
 * @typedef {object} ComposeOpts
 * @property {string}  [theme='light']          'light' | 'dark'
 *
 * Density bundle (from device profile, passed through to labels):
 * @property {boolean} [buildings3D=true]
 * @property {boolean} [pois=true]
 * @property {boolean} [labels=true]
 * @property {number}  [density=1.0]
 * @property {number}  [placeRankCutoff=12]
 * @property {number}  [poiRankCutoff=6]
 * @property {number}  [poiDotRankCutoff=8]
 * @property {number}  [textPaddingMul=1.0]
 * @property {number}  [poiSizeMul=1.0]
 * @property {boolean} [enableNeighbourhoods=true]
 * @property {boolean} [enableHamlets=true]
 * @property {boolean} [enableSuburbs=true]
 * @property {boolean} [enableRoadShieldsMinor=true]
 * @property {boolean} [roadsCarpathianDoubleCasing=true]
 *
 * Relief & terrain stack:
 * @property {boolean} [hillshade=false]        Emit hillshade layer(s).
 * @property {boolean} [multiDirHillshade=false] 3-layer Swiss-style stack.
 * @property {boolean} [hasPrimaryDem=false]    Primary DEM source exists.
 * @property {boolean} [hasCarpathianDem=false] Carpathian DEM source exists.
 * @property {boolean} [hypsometricTint=false]
 * @property {boolean} [hasHypsoSource=false]
 * @property {boolean} [textureShading=false]
 * @property {boolean} [hasTextureSource=false]
 * @property {boolean} [colorRelief=false]      Native color-relief layer.
 *
 * Contours:
 * @property {boolean} [contours=false]
 * @property {string}  [contoursSourceId='contours-dynamic']  id registered by createMap.
 * @property {boolean} [hasContoursSource=false]              Source exists at compose-time.
 * @property {boolean} [contourLabels=true]
 * @property {number}  [contoursMinzoom=9]
 *
 * Carpathian:
 * @property {boolean} [ridgeOverlay=false]
 * @property {boolean} [hasRidgesSource=false]
 * @property {boolean} [carpathian=false]
 * @property {boolean} [hasCarpathianOsmSource=false]
 *
 * Accessibility:
 * @property {boolean} [reduceMotion=false]     Static relief, no 3D.
 */

/**
 * @param {ComposeOpts} [opts]
 * @returns {Array<object>} Ordered MapLibre layer specs.
 */
export function composeLayers(opts = {}) {
  const {
    theme = 'light',
    buildings3D = true,
    pois = true,
    labels = true,

    density = 1.0,
    placeRankCutoff = 12,
    poiRankCutoff = 6,
    poiDotRankCutoff = 8,
    textPaddingMul = 1.0,
    poiSizeMul = 1.0,
    enableNeighbourhoods = true,
    enableHamlets = true,
    enableSuburbs = true,
    enableRoadShieldsMinor = true,
    roadsCarpathianDoubleCasing = true,

    hillshade = false,
    multiDirHillshade = false,
    hasPrimaryDem = false,
    hasCarpathianDem = false,
    hypsometricTint = false,
    hasHypsoSource = false,
    textureShading = false,
    hasTextureSource = false,
    colorRelief = false,

    contours = false,
    contoursSourceId = 'contours-dynamic',
    hasContoursSource = false,
    contourLabels = true,
    contoursMinzoom = 9,

    ridgeOverlay = false,
    hasRidgesSource = false,
    carpathian = false,
    hasCarpathianOsmSource = false,

    reduceMotion = false,
  } = opts;

  const t = getTokens(theme);
  const stack = [];

  // 1–4: Base surfaces.
  stack.push(...baseBackground(t));
  stack.push(...baseLandcover(t));
  stack.push(...baseLanduse(t));
  stack.push(...baseParks(t));

  // 5: Lakes and sea polygons — BELOW the relief stack so the sky
  // colour of the water doesn't clash with the hypsometric tint.
  stack.push(...baseWaterFill(t));

  // 6: Hypsometric tint (raster PMTiles).
  if (hypsometricTint && hasHypsoSource) {
    stack.push(...hypsometricTintLayers(t));
  }

  // 7: Native color-relief (feature-flagged; MapLibre JS support landing).
  if (colorRelief && hasPrimaryDem) {
    stack.push(...colorReliefLayers(t));
  }

  // 8: Hillshade stack — 1 layer (low-profile default) or 3 (Swiss).
  //    Plus an optional Carpathian high-res DEM hillshade that takes over
  //    at higher zooms inside the bbox.
  if (hillshade && hasPrimaryDem) {
    stack.push(
      ...hillshadeLayers(t, {
        multiDir: multiDirHillshade,
        carpathian,
        hasCarpathianSource: hasCarpathianDem,
        reduceMotion,
      }),
    );
  }

  // 9: Texture shading overlay (pre-rendered PNG).
  if (textureShading && hasTextureSource) {
    stack.push(...textureShadingLayers(t, { reduceMotion }));
  }

  // 10–11: Contours + their labels.
  if (contours && hasContoursSource) {
    stack.push(
      ...contourLayers(t, {
        sourceId: contoursSourceId,
        labels: contourLabels,
        minzoom: contoursMinzoom,
      }),
    );
  }

  // 12: Ridge enhancement (Imhof double-stroke).
  if (ridgeOverlay && hasRidgesSource) {
    stack.push(...ridgeLayers(t));
  }

  // 13: Linear waterways — above relief so rivers stay legible.
  stack.push(...baseWaterways(t));

  // 14: Aeroway.
  stack.push(...baseAeroway(t));

  // 15: Roads.
  stack.push(
    ...roadLayers(t, {
      shieldsMinor: enableRoadShieldsMinor,
      carpathianDoubleCasing: roadsCarpathianDoubleCasing,
    }),
  );

  // 16: Carpathian trail emphasis — above roads so trails read over them.
  if (carpathian && hasCarpathianOsmSource) {
    stack.push(...trailLayers(t));
  }

  // 17: Buildings.
  stack.push(...buildingLayers(t, { threeD: buildings3D }));

  // 18: Admin boundaries.
  stack.push(...boundaryLayers(t));

  // 19: Cableway + ski piste (deep-zoom auxiliaries).
  if (carpathian && hasCarpathianOsmSource) {
    stack.push(...cablewayLayers(t));
  }

  // 20: Labels.
  if (labels) {
    let labelStack = labelLayers(t, {
      density,
      placeRankCutoff,
      poiRankCutoff,
      poiDotRankCutoff,
      textPaddingMul,
      poiSizeMul,
      enableNeighbourhoods,
      enableHamlets,
      enableSuburbs,
      enableRoadShieldsMinor,
    });
    if (!pois) labelStack = labelStack.filter((l) => !l.id.startsWith('poi_'));
    stack.push(...labelStack);
  }

  // 21: Carpathian-specific labels — peaks, passes, saddles. Emitted
  //     after generic labels so collisions favour mountain features.
  if (labels && carpathian && hasCarpathianOsmSource) {
    stack.push(...carpathianLabels(t));
  }

  return stack;
}

export { getTokens };
