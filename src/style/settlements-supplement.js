/**
 * Supplemental settlement polygons — hand-supplied boundaries for places
 * that the OSM / OpenMapTiles data does NOT model as a settlement at all.
 *
 * Why this file exists
 * --------------------
 * The standard settlement outline (settlements.js) traces the *perimeter*
 * of `landuse=residential`-class polygons coming from the vector tiles.
 * That is the right behaviour for ordinary villages and towns, which OSM
 * maps with a residential land-use polygon.
 *
 * A handful of places have no such polygon — most notably mountain tourist
 * bases like **Заросляк** at the foot of Hoverla. In OSM/OMT Заросляк is
 * only a `poi` point (`leisure=sports_centre`, "НСБ Заросляк") plus a few
 * scattered, unnamed building footprints. There is no residential polygon
 * and no `place` node, so the polygon-outline and place-point logic in
 * settlements.js can never match it — which is exactly why it was never
 * outlined, and why the earlier `place=locality` attempt had no effect
 * (that tag does not exist in the data).
 *
 * Rather than fall back to a synthetic circle, this file supplies a real
 * polygon so the place is outlined *by perimeter, identically to every
 * other settlement*. The boundary below was reconstructed from Заросляк's
 * actual building cluster + sports/retail land-use patches in the live
 * OpenFreeMap tiles (a ~180×160 m core around the base), then buffered,
 * merged and simplified into a single ring.
 *
 * How to extend
 * -------------
 * Add another Feature to the collection. The geometry must be a GeoJSON
 * Polygon (lon/lat, WGS84). `properties.class` is informational only —
 * these features get their own source, so no class filter is applied; the
 * polygon's outline is drawn as-is. Keep boundaries tight and faithful to
 * the real built footprint so the frame reads like a settlement, not a
 * blob.
 */

/** MapLibre source id for the supplemental settlement polygons. */
export const SETTLEMENTS_SUPPLEMENT_SOURCE = 'settlements_supplement';

/**
 * Inline GeoJSON (no network) so the same data is consumed by both the
 * browser pipeline and the offline style-spec validator.
 *
 * @type {{type: 'FeatureCollection', features: Array<object>}}
 */
export const SETTLEMENTS_SUPPLEMENT = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Заросляк', class: 'residential', source: 'supplement' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
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
          [24.535315, 48.164559],
        ]],
      },
    },
  ],
};
