/**
 * Satellite mode — minimal locally-composed MapLibre style.
 *
 * The Satellite map is intentionally light:
 *
 *   • One raster source — Esri World Imagery (key-less public tiles).
 *   • One raster layer covering the whole viewport.
 *   • A thin overlay of transportation_name + place labels from
 *     OpenMapTiles so the user can still read where they are without
 *     any "real" cartography painted on top of the imagery.
 *
 * Nothing else from our Cart composition leaks in: no landcover, no
 * landuse, no water-fill, no buildings, no hypso, no hillshade. Those
 * would all paint OVER the imagery and defeat the whole point of the
 * mode (showing the actual photo of the ground).
 *
 * Pure module — no DOM, no MapLibre globals, no fetches. Same shape as
 * the rest of `src/style/`: returns a fully-formed MapLibre style JSON
 * given an options bundle. That makes it usable from both
 * `src/map/createMap.js` (browser) and `validate.cjs` (Node).
 */

import { OPENFREEMAP, SATELLITE_TILES } from '../config.js';
import { labelLayers } from './labels.js';
import { getTokens } from './tokens.js';

/**
 * Source id of the OpenMapTiles vector source we use for the labels
 * overlay. It must match the value used by `labelLayers()` (which
 * hard-codes `openmaptiles` as the source). Kept as a constant so we
 * don't have two strings drifting independently.
 */
const VECTOR_SOURCE_ID = 'openmaptiles';

/** Source id for the imagery raster. */
const RASTER_SOURCE_ID = 'satellite-imagery';

/** Render-id for the imagery layer. Drawn as a single full-viewport pane. */
const RASTER_LAYER_ID = 'satellite_imagery';

/**
 * Subset of label layer ids we keep. The brief asks for transportation
 * and place names with a translucent halo so the imagery still shows
 * through. We drop everything else (water, parks, POIs) — the imagery
 * already conveys those features.
 *
 * Each id corresponds to the canonical id emitted by
 * `src/style/labels.js`. If the label module ever renames a layer,
 * update this list and the satellite overlay will track the rename.
 *
 * NB: we don't list `_glow` siblings. Those are filtered out by
 * `tuneSatelliteLabelLayer()` regardless — they'd just add visual
 * noise on top of imagery without buying readability.
 */
const SATELLITE_LABEL_IDS = Object.freeze([
  // Place labels — country, state, cities, towns, villages.
  'label_country',
  'label_state',
  'label_city_large',
  'label_town',
  'label_village',
  // Road labels — only the named roads, plus ref shields for major
  // routes so navigation cues survive.
  'label_road_motorway',
  'label_road_trunk_primary',
  'label_road_secondary_tertiary',
  'label_road_shield_major',
]);

/**
 * Tweak label paint properties so the overlay reads against satellite
 * imagery (which can be very dark, very bright, or anywhere in between).
 *
 * Strategy: drop all glow siblings, force a near-white text colour with
 * a dark translucent halo, bump halo width slightly. The vivid Cart-
 * specific text colours (textRoad ochre, textPark green) are abandoned
 * because they wouldn't be legible over orange desert or green canopy.
 */
function tuneSatelliteLabelLayer(layer) {
  // Skip glow siblings — the soft amber wash adds visual noise on top
  // of imagery without buying readability.
  if (/_glow$/.test(layer.id)) return null;

  const next = JSON.parse(JSON.stringify(layer));
  // The base label module uses `openmaptiles` as the source already, so
  // we don't need to rewrite `source`. But ensure it's stamped just in
  // case the module changes.
  next.source = VECTOR_SOURCE_ID;
  next.paint = next.paint ? { ...next.paint } : {};

  // Highway-shield-style labels keep their pill — readable and
  // recognizable. For anything else, push to white-on-translucent-black.
  const isShield = layer.id.startsWith('label_road_shield_');
  if (!isShield) {
    next.paint['text-color'] = '#ffffff';
    next.paint['text-halo-color'] = 'rgba(0, 0, 0, 0.55)';
    next.paint['text-halo-width'] = 1.6;
    next.paint['text-halo-blur'] = 0.6;
  }
  // Strip any existing -glow accents that snuck in.
  delete next.paint['text-color-transition'];
  return next;
}

/**
 * Build the labels overlay — labelLayers() produces our full label
 * stack, and we filter it down to the ids we want for satellite mode.
 *
 * We pick `density: 0.6` and `theme: 'light'` per the brief. The
 * resulting palette doesn't survive the satellite background unchanged,
 * so we run each surviving layer through `tuneSatelliteLabelLayer` to
 * force white-on-translucent-black readability.
 *
 * @returns {Array<object>}
 */
function buildSatelliteLabels() {
  const t = getTokens('light');
  const fullStack = labelLayers(t, {
    density: 0.6,
    placeRankCutoff: 9,
    poiRankCutoff: 0, // POIs off — satellite already conveys them
    poiDotRankCutoff: 0,
    textPaddingMul: 1.1,
    poiSizeMul: 1.0,
    enableNeighbourhoods: false,
    enableHamlets: false,
    enableSuburbs: false,
    enableRoadShieldsMinor: false,
  });
  const allowed = new Set(SATELLITE_LABEL_IDS);
  const out = [];
  for (const layer of fullStack) {
    if (!allowed.has(layer.id)) continue;
    const tuned = tuneSatelliteLabelLayer(layer);
    if (tuned) out.push(tuned);
  }
  return out;
}

/**
 * Compose the full Satellite-mode style JSON.
 *
 * @param {object} [opts]
 * @param {string} [opts.glyphs]   Override glyph URL template.
 * @param {string} [opts.sprite]   Override sprite URL.
 * @param {string} [opts.vectorTilejsonUrl]
 *     Override the OpenMapTiles vector TileJSON endpoint. Useful for
 *     the validator, which stubs sources to keep tests offline.
 * @returns {object} A spec-valid MapLibre style.
 */
export function composeSatelliteStyle(opts = {}) {
  const glyphs = opts.glyphs ?? OPENFREEMAP.glyphs;
  const sprite = opts.sprite ?? OPENFREEMAP.sprite;
  const vectorTilejsonUrl = opts.vectorTilejsonUrl ?? OPENFREEMAP.tilejson;

  const sources = {
    // Raster imagery — single source, single layer.
    [RASTER_SOURCE_ID]: {
      type: 'raster',
      tiles: [SATELLITE_TILES.url],
      tileSize: SATELLITE_TILES.tileSize,
      minzoom: SATELLITE_TILES.minzoom,
      maxzoom: SATELLITE_TILES.maxzoom,
      attribution: SATELLITE_TILES.attribution,
    },
    // Vector — labels overlay only. Same source-layer ids the rest of
    // the project consumes (place / transportation_name).
    [VECTOR_SOURCE_ID]: {
      type: 'vector',
      url: vectorTilejsonUrl,
      attribution: OPENFREEMAP.attribution,
    },
  };

  const layers = [
    {
      id: RASTER_LAYER_ID,
      type: 'raster',
      source: RASTER_SOURCE_ID,
      // Tiny contrast nudge keeps the imagery legible without colour
      // distortion. Keep this conservative — we deliberately don't
      // mutate the photographic content beyond MapLibre's own resampling.
      paint: {
        'raster-resampling': 'linear',
        'raster-fade-duration': 220,
      },
    },
    ...buildSatelliteLabels(),
  ];

  return {
    version: 8,
    name: 'Cart · Satellite',
    metadata: { mode: 'satellite', schema: 'openmaptiles' },
    sources,
    glyphs,
    sprite,
    layers,
  };
}
