/**
 * Forest-cover overlay — a dedicated, toggleable "лесной покров" layer that
 * highlights every wooded polygon in a vivid green, in the spirit of Google
 * Earth's forest-cover view but rendered from crisp vector data instead of a
 * blocky raster.
 *
 * Presentation: deliberately FLAT (like the reference).
 * -----------------------------------------------------
 * Enabling forest-cover also forces the flat preset (see
 * `resolveFeatures` in `src/map/createMap.js`): hillshade, 3D terrain,
 * hypsometric tint, contours and the raster landcover tints are all
 * suppressed while the overlay is on. With no relief left to read
 * through, the fill is painted NEAR-OPAQUE so the forest mass becomes the
 * dominant two-tone surface — dark green forest against the pale land —
 * exactly like the reference, just with crisper vector boundaries.
 *
 * Why a separate layer (and not the existing forest treatments)?
 * --------------------------------------------------------------
 *   • `base.js::landcover_wood` paints the SAME `landcover` class=wood
 *     polygons, but in a pale sage `t.forest` wash whose job is to be a
 *     quiet background surface — it is deliberately understated.
 *   • `worldcoverTint` / `canopyHeightTint` are raster overlays gated on a
 *     hosted PMTiles archive that only covers the Carpathians.
 *   • `forestLeafType` (carpathian.js) needs the custom carpathian-osm
 *     archive and is biome-coloured, not a single "this is forest" wash.
 *
 * This overlay instead reads the GLOBAL OpenMapTiles `landcover` source-layer
 * that the base map already consumes, so it works across the whole country
 * with zero new data dependencies — toggle it on and every forest from
 * Полісся to Закарпаття lights up.
 *
 * Cartographic treatment (two crisp layers, no faux-3D):
 *
 *   1. `forestcover_fill`  — saturated near-opaque forest green body. A
 *      single flat opacity (no zoom graduation) keeps the two-tone read
 *      clean at every zoom.
 *   2. `forestcover_edge`  — darker casing line that crisps every stand
 *      boundary; fades in from z8 so the country-overview read stays a
 *      clean mass, then sharpens at hiking zooms.
 *
 * Source-availability: the `openmaptiles` vector source is always present
 * (it is the base map), so — unlike the raster forest overlays — this layer
 * needs no `has*Source` gate; `composeLayers` emits it on the feature flag
 * alone.
 */

import { linZoom, inFilter } from '../utils/interp.js';

// OpenMapTiles `landcover` classes that represent tree cover. `wood` is the
// canonical forest class the base map already filters on; `forest` is kept
// for robustness against upstream schema variants that emit it.
const FOREST_CLASSES = ['wood', 'forest'];

/**
 * Build the forest-cover overlay layer stack (fill → edge).
 *
 * @param {object} t Theme tokens (`getTokens(theme)`). Reads `t.forestCover`.
 * @returns {Array<object>} Ordered MapLibre layer specs.
 */
export function forestCoverLayers(t) {
  const filter = inFilter('class', FOREST_CLASSES);

  return [
    // 1. Body fill — saturated forest green, near-opaque so the forest is
    //    the dominant surface. Antialias keeps the vector boundary crisp.
    {
      id: 'forestcover_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter,
      paint: {
        'fill-color': t.forestCover.fill,
        'fill-antialias': true,
        'fill-opacity': 0.95,
      },
    },
    // 2. Casing edge — darker green outline that crisps stand boundaries.
    //    Fades in at z8 so the low-zoom mass stays clean, then sharpens at
    //    hiking zooms — this is the cue that makes the overlay read sharper
    //    than the soft raster reference.
    {
      id: 'forestcover_edge',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': t.forestCover.edge,
        'line-opacity': linZoom([
          [7, 0],
          [9, 0.5],
          [13, 0.7],
        ]),
        'line-width': linZoom([
          [8, 0.3],
          [13, 1.1],
          [16, 1.8],
        ]),
      },
    },
  ];
}
