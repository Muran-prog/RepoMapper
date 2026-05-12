/**
 * Style composer — assembles the full layer stack in the correct paint order.
 *
 * The order is significant. MapLibre paints layers in declaration order, so
 * everything below renders before everything above:
 *
 *   1. base (background, landcover, landuse, parks, water, aeroway)
 *   2. road network (tunnels → ground roads → railways → bridges)
 *   3. building footprints + 3D extrusion
 *   4. administrative boundaries (drawn over land but under labels)
 *   5. labels & POIs (above everything else)
 *
 * Each module exports a pure function that takes design tokens and returns
 * an array of layer specs. This file just glues them together.
 *
 * Adaptive density
 * ----------------
 * `composeLayers` accepts a bundle of density-related options that come
 * straight from src/device.js. Mobile devices get fewer labels, sparser
 * POI dots and larger text-padding without any of the per-layer logic
 * needing to know it's running on a phone.
 */

import { baseLayers } from './base.js';
import { roadLayers } from './roads.js';
import { buildingLayers } from './buildings.js';
import { boundaryLayers } from './boundaries.js';
import { labelLayers } from './labels.js';
import { getTokens } from './tokens.js';

/**
 * @typedef {object} ComposeOpts
 * @property {string}  [theme='light']    'light' | 'dark'
 * @property {boolean} [buildings3D=true] Enable extrusion layer
 * @property {boolean} [pois=true]        Render POI markers/labels
 * @property {boolean} [labels=true]      Render any text/labels at all
 *
 * @property {number}  [density=1.0]              Label density multiplier.
 * @property {number}  [placeRankCutoff=12]       Drop place features above this rank.
 * @property {number}  [poiRankCutoff=6]          Drop POI labels above this rank.
 * @property {number}  [poiDotRankCutoff=8]       Drop POI dots above this rank.
 * @property {number}  [textPaddingMul=1.0]       Multiplier on text-padding.
 * @property {number}  [poiSizeMul=1.0]           Multiplier on POI dot radii.
 * @property {boolean} [enableNeighbourhoods=true]
 * @property {boolean} [enableHamlets=true]
 * @property {boolean} [enableSuburbs=true]
 */

/**
 * @param {ComposeOpts} [opts]
 * @returns {Array<object>} ordered MapLibre layer specs
 */
export function composeLayers(opts = {}) {
  const {
    theme = 'light',
    buildings3D = true,
    pois = true,
    labels = true,
    // Density bundle — passed through to labels.js
    density = 1.0,
    placeRankCutoff = 12,
    poiRankCutoff = 6,
    poiDotRankCutoff = 8,
    textPaddingMul = 1.0,
    poiSizeMul = 1.0,
    enableNeighbourhoods = true,
    enableHamlets = true,
    enableSuburbs = true,
  } = opts;

  const t = getTokens(theme);

  const stack = [
    ...baseLayers(t),
    ...roadLayers(t),
    ...buildingLayers(t, { threeD: buildings3D }),
    ...boundaryLayers(t),
  ];

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
    });
    if (!pois) labelStack = labelStack.filter((l) => !l.id.startsWith('poi_'));
    stack.push(...labelStack);
  }

  return stack;
}

export { getTokens };
