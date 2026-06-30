/**
 * Supplemental settlement polygons — hand-supplied boundaries for places
 * the OSM / OpenMapTiles data does NOT model as a settlement at all.
 *
 * Why this file exists
 * --------------------
 * The standard settlement outline (settlements.js) traces the *perimeter*
 * of `landuse=residential`-class polygons coming from the vector tiles —
 * the right behaviour for ordinary villages and towns. A handful of
 * places have no such polygon — most notably mountain tourist bases like
 * **Заросляк** at the foot of Hoverla, which OSM/OMT model only as a POI
 * point plus a few unnamed building footprints. There is no residential
 * polygon and no `place` node, so neither the polygon-outline nor the
 * place-point logic in settlements.js can ever match them.
 *
 * Rather than fall back to a synthetic circle, this module supplies real
 * polygons so each place is outlined *by perimeter, identically to every
 * other settlement* (the four-line glow→casing→inline stack in
 * settlements.js, via `settlementPerimeterLayers`).
 *
 * NOTE: this is the *manual* / curated path. For places discovered at
 * runtime, the interactive "Контури" feature (src/draw/settlement-contours.js)
 * lets users trace contours without a code change. Use THIS file for
 * outlines that should ship with the app for everyone.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  HOW TO ADD A NEW SETTLEMENT
 * ─────────────────────────────────────────────────────────────────────
 *  Append one entry to `SUPPLEMENTAL_SETTLEMENTS` below:
 *
 *      {
 *        name: 'Назва',                 // settlement name
 *        note: 'optional provenance',   // optional — where the ring came from
 *        ring: [                        // outline as [lng, lat] pairs, WGS84
 *          [24.5353, 48.1645],
 *          [24.5358, 48.1649],
 *          ...                          // ≥ 3 points; DON'T repeat the
 *        ],                             //   first point — it auto-closes
 *      }
 *
 *  Everything else (id, closure, the GeoJSON Feature, properties, the
 *  source) is derived automatically. Keep rings tight and faithful to the
 *  real built footprint so the frame reads like a settlement, not a blob.
 * ─────────────────────────────────────────────────────────────────────
 */

/** MapLibre source id for the supplemental settlement polygons. */
export const SETTLEMENTS_SUPPLEMENT_SOURCE = 'settlements_supplement';

/**
 * The single source of truth — a flat list of curated settlement
 * outlines. Add new places here; see "HOW TO ADD A NEW SETTLEMENT" above.
 *
 * @typedef {object} SupplementalSettlement
 * @property {string} name            Display name of the settlement.
 * @property {Array<[number, number]>} ring  Outline as [lng, lat] pairs
 *   (WGS84). At least 3 points. The closing point is added automatically,
 *   so don't repeat the first vertex.
 * @property {string} [note]          Optional provenance / how the ring
 *   was reconstructed. Informational only.
 *
 * @type {SupplementalSettlement[]}
 */
export const SUPPLEMENTAL_SETTLEMENTS = [
  {
    name: 'Заросляк',
    note:
      'Mountain tourist base at the foot of Hoverla. No residential polygon ' +
      'or place node in OSM/OMT (only a sports-centre POI + unnamed buildings). ' +
      'Ring reconstructed from the building cluster + sports/retail land-use ' +
      'patches in the live OpenFreeMap tiles (~180×160 m core), then buffered, ' +
      'merged and simplified into a single ring.',
    ring: [
      [24.535315, 48.164559],
      [24.535325, 48.164761],
      [24.535581, 48.164929],
      [24.535782, 48.164908],
      [24.536062, 48.164677],
      [24.536496, 48.164636],
      [24.536712, 48.164718],
      [24.536847, 48.164938],
      [24.537146, 48.165020],
      [24.537331, 48.164914],
      [24.537730, 48.164291],
      [24.537471, 48.164124],
      [24.537166, 48.164064],
      [24.536722, 48.163644],
      [24.536478, 48.163572],
      [24.535679, 48.163941],
    ],
  },
  {
    name: 'Новобіличі',
    note:
      'Village (село Новобіличі) absorbed into the Sviatoshynskyi district of ' +
      'Kyiv. OSM models it only as a place=neighbourhood node with no ' +
      'administrative boundary relation, so the standard settlement outline ' +
      'cannot match it. Ring reconstructed from the building-footprint cluster ' +
      '(695 buildings) plus the rural residential land-use polygons around the ' +
      'place node, then buffered, merged and simplified into a single ring ' +
      '(~900×900 m, ~57 ha). Verified to contain the place node and exclude ' +
      'neighbouring places (село Біличі, Академмістечко, Сахалін).',
    ring: [
      [30.350747, 50.480863],
      [30.355523, 50.478637],
      [30.35577, 50.478321],
      [30.356496, 50.478261],
      [30.356669, 50.47789],
      [30.357124, 50.477738],
      [30.357609, 50.477235],
      [30.357366, 50.475666],
      [30.356198, 50.474275],
      [30.354282, 50.473274],
      [30.35191, 50.472816],
      [30.349444, 50.472971],
      [30.347258, 50.473714],
      [30.346109, 50.474505],
      [30.346093, 50.474862],
      [30.345686, 50.474934],
      [30.345015, 50.476231],
      [30.345414, 50.476259],
      [30.345523, 50.47651],
      [30.345379, 50.476854],
      [30.344939, 50.476886],
      [30.345209, 50.478013],
      [30.346377, 50.479404],
      [30.348293, 50.480404],
    ],
  },
];

// ---------------------------------------------------------------------------
// Derivation — build the GeoJSON FeatureCollection from the registry.
// ---------------------------------------------------------------------------

/** True if two [lng, lat] pairs are identical. */
function samePoint(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

/**
 * Close a ring if it isn't already (last point duplicates the first), so
 * authors never have to repeat the opening vertex by hand.
 */
function closeRing(ring) {
  if (ring.length && !samePoint(ring[0], ring[ring.length - 1])) {
    return [...ring, ring[0].slice()];
  }
  return ring.slice();
}

/**
 * Turn one curated definition into a settlement Feature. Returns `null`
 * for malformed entries (fewer than 3 vertices) so a single typo can't
 * break the whole style build — the bad entry is simply skipped.
 *
 * @param {SupplementalSettlement} def
 * @param {number} index
 * @returns {object|null}
 */
export function buildSupplementFeature(def, index) {
  const ring = Array.isArray(def?.ring) ? def.ring : null;
  if (!ring || ring.length < 3) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[settlements-supplement] skipping "${def?.name ?? 'unnamed'}": ` +
          'a settlement outline needs at least 3 points.',
      );
    }
    return null;
  }
  return {
    type: 'Feature',
    id: `settlement-supplement-${index}`,
    properties: {
      name: def.name ?? `Supplement ${index + 1}`,
      class: 'residential',
      source: 'supplement',
      ...(def.note ? { note: def.note } : {}),
    },
    geometry: {
      type: 'Polygon',
      coordinates: [closeRing(ring)],
    },
  };
}

/**
 * Inline GeoJSON (no network) so the same data feeds both the browser
 * pipeline and the offline style-spec validator. Derived from the
 * registry above — never edit this object directly; edit
 * `SUPPLEMENTAL_SETTLEMENTS`.
 *
 * @type {{type: 'FeatureCollection', features: Array<object>}}
 */
export const SETTLEMENTS_SUPPLEMENT = {
  type: 'FeatureCollection',
  features: SUPPLEMENTAL_SETTLEMENTS.map(buildSupplementFeature).filter(Boolean),
};
