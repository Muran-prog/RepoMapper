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
 *  Preferred path for many user-drawn contours:
 *
 *      npm run import-settlement-contours -- ../repomapper-export-123.json
 *      npm run import-settlement-contours -- ../repomapper-export-123.json --write
 *
 *  The importer reads full/scoped RepoMapper export JSON, keeps only
 *  settlement-contour polygons, rounds coordinates to 6 decimals, removes
 *  the closing duplicate vertex, skips hidden/malformed contours, and
 *  deduplicates against the hardcoded registry so existing entries such as
 *  Заросляк are not added twice.
 *
 *  Manual path for one-off edits:
 *
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
  {
    name: '13, Richna Street, Korosten',
    note:
      'Single building at 13 Richna Street in Korosten, Zhytomyr Oblast. ' +
      'OSM models it only as a building footprint with no place node. ' +
      'Ring is a synthetic 40 m radius circle around the building centre ' +
      '(50.944473, 28.639877), generated as 28 equiangular points.',
    ring: [
      [28.639877, 50.944832],
      [28.640004, 50.944823],
      [28.640124, 50.944797],
      [28.640233, 50.944754],
      [28.640323, 50.944697],
      [28.640391, 50.944629],
      [28.640433, 50.944553],
      [28.640447, 50.944473],
      [28.640433, 50.944393],
      [28.640391, 50.944317],
      [28.640323, 50.944249],
      [28.640233, 50.944192],
      [28.640124, 50.944149],
      [28.640004, 50.944123],
      [28.639877, 50.944114],
      [28.63975, 50.944123],
      [28.63963, 50.944149],
      [28.639521, 50.944192],
      [28.639431, 50.944249],
      [28.639363, 50.944317],
      [28.639321, 50.944393],
      [28.639307, 50.944473],
      [28.639321, 50.944553],
      [28.639363, 50.944629],
      [28.639431, 50.944697],
      [28.639521, 50.944754],
      [28.63963, 50.944797],
      [28.63975, 50.944823],
    ],
  },
  {
    name: 'Контур 1',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7s55fm-0 · created 2026-07-05T12:41:05.986Z.',
    ring: [
      [24.420965, 47.968518],
      [24.419977, 47.969036],
      [24.420879, 47.969640],
      [24.422641, 47.969899],
      [24.423672, 47.969842],
      [24.424402, 47.969036],
      [24.424231, 47.968231],
      [24.423242, 47.967885],
      [24.421996, 47.967885],
    ],
  },
  {
    name: 'Контур 2',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7s5qdq-1 · created 2026-07-05T12:41:33.134Z.',
    ring: [
      [24.416343, 47.976279],
      [24.418139, 47.974837],
      [24.421101, 47.974777],
      [24.420742, 47.976820],
      [24.417421, 47.979103],
      [24.415491, 47.979464],
      [24.414773, 47.978472],
      [24.414369, 47.977421],
    ],
  },
  {
    name: 'Контур 3',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7s6o3q-2 · created 2026-07-05T12:42:16.838Z.',
    ring: [
      [24.429328, 47.980348],
      [24.432678, 47.978224],
      [24.434591, 47.979497],
      [24.430551, 47.980809],
    ],
  },
  {
    name: 'Контур 4',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7s7w0y-3 · created 2026-07-05T12:43:13.762Z.',
    ring: [
      [24.267070, 47.908726],
      [24.269003, 47.907934],
      [24.271122, 47.909512],
      [24.268592, 47.910360],
    ],
  },
  {
    name: 'Контур 5',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7s9kyz-4 · created 2026-07-05T12:44:32.747Z.',
    ring: [
      [24.383436, 47.957440],
      [24.386232, 47.955174],
      [24.389501, 47.957113],
      [24.386877, 47.958697],
    ],
  },
  {
    name: 'Контур 6',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sb1pp-5 · created 2026-07-05T12:45:41.101Z.',
    ring: [
      [24.604172, 47.954453],
      [24.608803, 47.954017],
      [24.606874, 47.951109],
      [24.603015, 47.951481],
    ],
  },
  {
    name: 'Контур 7',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sbe8x-6 · created 2026-07-05T12:45:57.345Z.',
    ring: [
      [24.626071, 47.958943],
      [24.633596, 47.964337],
      [24.639553, 47.960138],
      [24.630943, 47.956617],
    ],
  },
  {
    name: 'Контур 8',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sblkp-7 · created 2026-07-05T12:46:06.841Z.',
    ring: [
      [24.633910, 47.950899],
      [24.637865, 47.948799],
      [24.639988, 47.950931],
      [24.638106, 47.952337],
    ],
  },
  {
    name: 'Контур 9',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sc2rd-8 · created 2026-07-05T12:46:29.113Z.',
    ring: [
      [24.675296, 47.895609],
      [24.682484, 47.898584],
      [24.686487, 47.894913],
      [24.678046, 47.892617],
    ],
  },
  {
    name: 'Контур 10',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sd4en-9 · created 2026-07-05T12:47:17.903Z.',
    ring: [
      [24.702292, 47.857920],
      [24.705755, 47.855830],
      [24.719986, 47.857861],
      [24.700982, 47.865672],
    ],
  },
  {
    name: 'Контур 11',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sdoza-a · created 2026-07-05T12:47:44.566Z.',
    ring: [
      [24.801360, 47.824878],
      [24.804463, 47.824629],
      [24.803804, 47.823265],
      [24.799946, 47.823569],
    ],
  },
  {
    name: 'Контур 12',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sfooo-b · created 2026-07-05T12:49:17.496Z.',
    ring: [
      [24.969147, 47.734247],
      [24.972940, 47.734979],
      [24.974590, 47.732783],
      [24.969709, 47.732168],
    ],
  },
  {
    name: 'Контур 13',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sg3y0-c · created 2026-07-05T12:49:37.272Z.',
    ring: [
      [24.984382, 47.740652],
      [24.997551, 47.729174],
      [25.015391, 47.736992],
      [24.999553, 47.744880],
      [24.984558, 47.744761],
    ],
  },
  {
    name: 'Контур 14',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sirib-d · created 2026-07-05T12:51:41.123Z.',
    ring: [
      [24.297110, 47.924102],
      [24.303356, 47.927812],
      [24.309118, 47.923109],
      [24.302776, 47.920046],
    ],
  },
  {
    name: 'Контур 15',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sk78p-e · created 2026-07-05T12:52:48.169Z.',
    ring: [
      [24.413700, 47.972476],
      [24.417321, 47.972043],
      [24.416954, 47.970932],
      [24.413233, 47.971378],
    ],
  },
  {
    name: 'Контур 16',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7sooa4-h · created 2026-07-05T12:56:16.876Z.',
    ring: [
      [24.548419, 47.968502],
      [24.551286, 47.968415],
      [24.551143, 47.966793],
      [24.547888, 47.966841],
    ],
  },
  {
    name: 'Контур 17',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y19z6-i · created 2026-07-05T15:26:02.946Z.',
    ring: [
      [24.571632, 48.016064],
      [24.582035, 48.015457],
      [24.580045, 48.010284],
      [24.570977, 48.010958],
    ],
  },
  {
    name: 'Контур 18',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y1uo6-j · created 2026-07-05T15:26:29.766Z.',
    ring: [
      [24.569266, 47.984822],
      [24.575466, 47.984627],
      [24.574777, 47.981217],
      [24.568660, 47.981483],
    ],
  },
  {
    name: 'Контур 19',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y3gmj-k · created 2026-07-05T15:27:44.875Z.',
    ring: [
      [24.513014, 48.022991],
      [24.530472, 48.025273],
      [24.536038, 48.013715],
      [24.517682, 48.012154],
    ],
  },
  {
    name: 'Контур 20',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y3nj9-l · created 2026-07-05T15:27:53.829Z.',
    ring: [
      [24.548245, 48.024312],
      [24.571672, 48.023832],
      [24.569428, 48.013835],
      [24.544610, 48.014166],
    ],
  },
  {
    name: 'Контур 21',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y42ii-m · created 2026-07-05T15:28:13.243Z.',
    ring: [
      [24.525925, 48.011266],
      [24.540754, 48.013174],
      [24.546614, 48.003704],
      [24.533495, 48.001726],
    ],
  },
  {
    name: 'Контур 22',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y4kq0-n · created 2026-07-05T15:28:36.840Z.',
    ring: [
      [24.498186, 48.049337],
      [24.504784, 48.054197],
      [24.516407, 48.037695],
      [24.508374, 48.037125],
    ],
  },
  {
    name: 'Контур 23',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y4ptv-o · created 2026-07-05T15:28:43.459Z.',
    ring: [
      [24.506175, 48.034424],
      [24.518203, 48.034904],
      [24.518248, 48.027041],
      [24.505950, 48.027011],
    ],
  },
  {
    name: 'Контур 24',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y5oau-p · created 2026-07-05T15:29:28.134Z.',
    ring: [
      [24.485741, 48.015286],
      [24.491394, 48.015610],
      [24.494407, 48.011032],
      [24.485480, 48.010957],
    ],
  },
  {
    name: 'Контур 25',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y6xev-q · created 2026-07-05T15:30:26.599Z.',
    ring: [
      [24.520666, 48.078978],
      [24.531207, 48.078752],
      [24.530991, 48.071770],
      [24.520727, 48.072759],
    ],
  },
  {
    name: 'Контур 26',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y7el9-r · created 2026-07-05T15:30:48.861Z.',
    ring: [
      [24.551538, 48.069830],
      [24.558688, 48.069794],
      [24.557247, 48.066478],
      [24.549804, 48.067049],
    ],
  },
  {
    name: 'Контур 27',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y8t25-s · created 2026-07-05T15:31:54.269Z.',
    ring: [
      [24.639362, 48.396210],
      [24.649133, 48.399075],
      [24.651907, 48.396926],
      [24.642907, 48.394286],
    ],
  },
  {
    name: 'Контур 28',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y979a-t · created 2026-07-05T15:32:12.670Z.',
    ring: [
      [24.620384, 48.395588],
      [24.625315, 48.394114],
      [24.627288, 48.396611],
      [24.621678, 48.397716],
    ],
  },
  {
    name: 'Контур 29',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y9bjx-u · created 2026-07-05T15:32:18.237Z.',
    ring: [
      [24.629630, 48.398575],
      [24.639987, 48.393582],
      [24.640326, 48.395178],
      [24.631387, 48.399435],
    ],
  },
  {
    name: 'Контур 30',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y9iux-v · created 2026-07-05T15:32:27.705Z.',
    ring: [
      [24.615822, 48.391740],
      [24.617610, 48.393214],
      [24.624267, 48.392907],
      [24.626456, 48.393868],
      [24.629199, 48.393889],
      [24.629754, 48.391003],
      [24.629507, 48.388342],
      [24.625808, 48.387298],
      [24.621956, 48.388956],
    ],
  },
  {
    name: 'Контур 31',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7y9sx1-w · created 2026-07-05T15:32:40.741Z.',
    ring: [
      [24.624575, 48.386459],
      [24.634747, 48.388158],
      [24.635425, 48.385681],
      [24.630771, 48.382181],
      [24.624853, 48.384126],
    ],
  },
  {
    name: 'Контур 32',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ya8si-x · created 2026-07-05T15:33:01.314Z.',
    ring: [
      [24.649264, 48.380625],
      [24.656446, 48.381137],
      [24.660792, 48.379417],
      [24.664059, 48.378844],
      [24.656446, 48.376572],
      [24.649110, 48.378414],
    ],
  },
  {
    name: 'Контур 33',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yaf5g-y · created 2026-07-05T15:33:09.556Z.',
    ring: [
      [24.658388, 48.373009],
      [24.665384, 48.376203],
      [24.666956, 48.374627],
      [24.659066, 48.370204],
      [24.658018, 48.371064],
    ],
  },
  {
    name: 'Контур 34',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yaokl-z · created 2026-07-05T15:33:21.765Z.',
    ring: [
      [24.641250, 48.380441],
      [24.646028, 48.380441],
      [24.645134, 48.377616],
      [24.641836, 48.378373],
    ],
  },
  {
    name: 'Контур 35',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yatf0-10 · created 2026-07-05T15:33:28.044Z.',
    ring: [
      [24.642946, 48.372600],
      [24.638507, 48.373828],
      [24.639124, 48.377063],
      [24.642298, 48.375875],
      [24.643839, 48.372948],
    ],
  },
  {
    name: 'Контур 36',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yb2be-11 · created 2026-07-05T15:33:39.578Z.',
    ring: [
      [24.622264, 48.375957],
      [24.621956, 48.372395],
      [24.629106, 48.372313],
      [24.632435, 48.374729],
      [24.630123, 48.378660],
      [24.623959, 48.379929],
    ],
  },
  {
    name: 'Контур 37',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ybdzg-12 · created 2026-07-05T15:33:54.700Z.',
    ring: [
      [24.685563, 48.392518],
      [24.686581, 48.393071],
      [24.687752, 48.392252],
      [24.686365, 48.391515],
    ],
  },
  {
    name: 'Контур 38',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ybfwz-13 · created 2026-07-05T15:33:57.203Z.',
    ring: [
      [24.678844, 48.388998],
      [24.680447, 48.389079],
      [24.680509, 48.388199],
      [24.678783, 48.388158],
    ],
  },
  {
    name: 'Контур 39',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ybmy7-14 · created 2026-07-05T15:34:06.319Z.',
    ring: [
      [24.679284, 48.381766],
      [24.681226, 48.382789],
      [24.682058, 48.381786],
      [24.680702, 48.381254],
    ],
  },
  {
    name: 'Контур 40',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ybpgu-15 · created 2026-07-05T15:34:09.582Z.',
    ring: [
      [24.688777, 48.382195],
      [24.689455, 48.381540],
      [24.690935, 48.381540],
      [24.690133, 48.382625],
    ],
  },
  {
    name: 'Контур 41',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ybxf5-16 · created 2026-07-05T15:34:19.889Z.',
    ring: [
      [24.696674, 48.382863],
      [24.697462, 48.382811],
      [24.697402, 48.382347],
      [24.696851, 48.382327],
    ],
  },
  {
    name: 'Контур 42',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yc640-17 · created 2026-07-05T15:34:31.152Z.',
    ring: [
      [24.668735, 48.372765],
      [24.672335, 48.374092],
      [24.673239, 48.372702],
      [24.668925, 48.371669],
    ],
  },
  {
    name: 'Контур 43',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yciok-18 · created 2026-07-05T15:34:47.444Z.',
    ring: [
      [24.681880, 48.359023],
      [24.688537, 48.360481],
      [24.706948, 48.346887],
      [24.694785, 48.345181],
    ],
  },
  {
    name: 'Контур 44',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ycnwa-19 · created 2026-07-05T15:34:54.202Z.',
    ring: [
      [24.709154, 48.346001],
      [24.712369, 48.346675],
      [24.712599, 48.345162],
      [24.709250, 48.344882],
    ],
  },
  {
    name: 'Контур 45',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yctvv-1a · created 2026-07-05T15:35:01.963Z.',
    ring: [
      [24.717161, 48.334729],
      [24.720472, 48.334755],
      [24.720031, 48.332923],
      [24.717505, 48.333215],
    ],
  },
  {
    name: 'Контур 46',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ydng0-1b · created 2026-07-05T15:35:40.272Z.',
    ring: [
      [24.542536, 48.373533],
      [24.551300, 48.371347],
      [24.549904, 48.370190],
      [24.541484, 48.372758],
    ],
  },
  {
    name: 'Контур 47',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yedgk-1c · created 2026-07-05T15:36:13.988Z.',
    ring: [
      [24.542766, 48.303532],
      [24.545598, 48.304856],
      [24.546669, 48.304270],
      [24.549578, 48.297931],
      [24.539225, 48.297969],
      [24.538345, 48.302437],
    ],
  },
  {
    name: 'Контур 48',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yezla-1d · created 2026-07-05T15:36:42.670Z.',
    ring: [
      [24.543263, 48.297683],
      [24.545011, 48.293700],
      [24.543040, 48.293106],
      [24.543412, 48.291695],
      [24.551817, 48.291337],
      [24.554179, 48.298079],
      [24.550776, 48.298624],
    ],
  },
  {
    name: 'Контур 49',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yfag2-1e · created 2026-07-05T15:36:56.738Z.',
    ring: [
      [24.542314, 48.287686],
      [24.548154, 48.289938],
      [24.553956, 48.289295],
      [24.554253, 48.287278],
      [24.549028, 48.286536],
    ],
  },
  {
    name: 'Контур 50',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yfhfu-1f · created 2026-07-05T15:37:05.802Z.',
    ring: [
      [24.544602, 48.272526],
      [24.546536, 48.272959],
      [24.547112, 48.272068],
      [24.544881, 48.271722],
    ],
  },
  {
    name: 'Контур 51',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yfu61-1g · created 2026-07-05T15:37:22.297Z.',
    ring: [
      [24.539134, 48.226746],
      [24.541552, 48.226671],
      [24.540808, 48.225011],
      [24.538893, 48.225284],
    ],
  },
  {
    name: 'Контур 52',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yg25d-1h · created 2026-07-05T15:37:32.641Z.',
    ring: [
      [24.546387, 48.212199],
      [24.548135, 48.213129],
      [24.549586, 48.211158],
      [24.547354, 48.210725],
    ],
  },
  {
    name: 'Контур 54',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yh7j8-1j · created 2026-07-05T15:38:26.276Z.',
    ring: [
      [24.544193, 48.042754],
      [24.546722, 48.042729],
      [24.546703, 48.040653],
      [24.543746, 48.040889],
    ],
  },
  {
    name: 'Контур 55',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yjr0z-1k · created 2026-07-05T15:40:24.851Z.',
    ring: [
      [24.534731, 48.446249],
      [24.538856, 48.446463],
      [24.539136, 48.444197],
    ],
  },
  {
    name: 'Контур 56',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ykdw1-1l · created 2026-07-05T15:40:54.481Z.',
    ring: [
      [24.526644, 48.434471],
      [24.528771, 48.434100],
      [24.529889, 48.437322],
      [24.533735, 48.437493],
      [24.538869, 48.436709],
      [24.539987, 48.439289],
      [24.538848, 48.439930],
      [24.532488, 48.438833],
      [24.527934, 48.437308],
    ],
  },
  {
    name: 'Контур 57',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ykplw-1m · created 2026-07-05T15:41:09.668Z.',
    ring: [
      [24.525699, 48.432347],
      [24.527590, 48.431292],
      [24.528406, 48.428583],
      [24.535496, 48.427813],
      [24.538569, 48.430151],
      [24.533283, 48.432775],
      [24.525484, 48.433673],
    ],
  },
  {
    name: 'Контур 58',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ylcbr-1n · created 2026-07-05T15:41:39.111Z.',
    ring: [
      [24.525463, 48.380088],
      [24.528191, 48.378561],
      [24.534938, 48.374951],
      [24.536807, 48.374922],
      [24.528428, 48.379632],
    ],
  },
  {
    name: 'Контур 59',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yloof-1o · created 2026-07-05T15:41:55.119Z.',
    ring: [
      [24.533412, 48.343587],
      [24.524560, 48.343387],
      [24.524818, 48.341873],
      [24.533606, 48.342173],
    ],
  },
  {
    name: 'Контур 60',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ym2wa-1p · created 2026-07-05T15:42:13.546Z.',
    ring: [
      [24.533197, 48.305130],
      [24.538225, 48.308159],
      [24.539557, 48.307302],
      [24.538783, 48.302843],
      [24.536506, 48.301800],
    ],
  },
  {
    name: 'Контур 61',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ymibk-1q · created 2026-07-05T15:42:33.536Z.',
    ring: [
      [24.525441, 48.229760],
      [24.527311, 48.228544],
      [24.528857, 48.230075],
      [24.525463, 48.232022],
    ],
  },
  {
    name: 'Контур 62',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ymndo-1r · created 2026-07-05T15:42:40.092Z.',
    ring: [
      [24.532467, 48.224107],
      [24.534486, 48.224150],
      [24.534379, 48.222919],
      [24.531908, 48.222847],
    ],
  },
  {
    name: 'Контур 63',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yms0k-1s · created 2026-07-05T15:42:46.100Z.',
    ring: [
      [24.535862, 48.219755],
      [24.538912, 48.219598],
      [24.538461, 48.217322],
      [24.536678, 48.217994],
    ],
  },
  {
    name: 'Контур 64',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yn7we-1t · created 2026-07-05T15:43:06.686Z.',
    ring: [
      [24.533047, 48.154609],
      [24.535346, 48.155957],
      [24.536893, 48.154581],
      [24.534121, 48.153405],
    ],
  },
  {
    name: 'Контур 65',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yny8u-1u · created 2026-07-05T15:43:40.830Z.',
    ring: [
      [24.531049, 48.032676],
      [24.533498, 48.033610],
      [24.534744, 48.032231],
      [24.531629, 48.031670],
    ],
  },
  {
    name: 'Контур 66',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yo92y-1v · created 2026-07-05T15:43:54.874Z.',
    ring: [
      [24.531070, 47.990621],
      [24.532531, 47.990678],
      [24.533004, 47.988838],
      [24.531715, 47.988723],
    ],
  },
  {
    name: 'Контур 67',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yoehw-1w · created 2026-07-05T15:44:01.892Z.',
    ring: [
      [24.530984, 47.992749],
      [24.532381, 47.992792],
      [24.532338, 47.991555],
      [24.531027, 47.991627],
    ],
  },
  {
    name: 'Контур 68',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yol76-1x · created 2026-07-05T15:44:10.578Z.',
    ring: [
      [24.536334, 47.978613],
      [24.538418, 47.978901],
      [24.538998, 47.977189],
      [24.537086, 47.977088],
    ],
  },
  {
    name: 'Контур 69',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yp0cs-1y · created 2026-07-05T15:44:30.220Z.',
    ring: [
      [24.534379, 47.947912],
      [24.536377, 47.948689],
      [24.537194, 47.947164],
      [24.535432, 47.946545],
    ],
  },
  {
    name: 'Контур 70',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7ypo4e-1z · created 2026-07-05T15:45:01.022Z.',
    ring: [
      [24.535820, 47.834182],
      [24.539194, 47.834679],
      [24.539626, 47.833381],
      [24.536602, 47.833243],
    ],
  },
  {
    name: 'Контур 71',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yq7nc-20 · created 2026-07-05T15:45:26.328Z.',
    ring: [
      [24.537136, 47.741776],
      [24.539235, 47.741886],
      [24.538906, 47.740116],
      [24.536705, 47.740586],
    ],
  },
  {
    name: 'Контур 72',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yts8e-24 · created 2026-07-05T15:48:12.974Z.',
    ring: [
      [24.530409, 47.596568],
      [24.532670, 47.594851],
      [24.534362, 47.595247],
      [24.532457, 47.597252],
    ],
  },
  {
    name: 'Контур 73',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yu74y-25 · created 2026-07-05T15:48:32.290Z.',
    ring: [
      [24.533507, 47.592978],
      [24.537602, 47.593434],
      [24.538457, 47.592521],
      [24.534006, 47.592137],
    ],
  },
  {
    name: 'Контур 74',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yyf0o-26 · created 2026-07-05T15:51:49.128Z.',
    ring: [
      [24.521557, 48.435546],
      [24.522266, 48.432167],
      [24.525768, 48.431882],
      [24.525553, 48.433236],
    ],
  },
  {
    name: 'Контур 75',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yyow6-27 · created 2026-07-05T15:52:01.926Z.',
    ring: [
      [24.514724, 48.401252],
      [24.516185, 48.400468],
      [24.517131, 48.401224],
      [24.515863, 48.401880],
    ],
  },
  {
    name: 'Контур 76',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yyswx-28 · created 2026-07-05T15:52:07.137Z.',
    ring: [
      [24.520418, 48.400924],
      [24.523190, 48.400254],
      [24.523383, 48.400952],
      [24.520397, 48.401466],
    ],
  },
  {
    name: 'Контур 77',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yz0f0-29 · created 2026-07-05T15:52:16.860Z.',
    ring: [
      [24.516851, 48.386843],
      [24.518936, 48.385502],
      [24.516250, 48.385188],
      [24.514488, 48.385944],
    ],
  },
  {
    name: 'Контур 78',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yz7fl-2a · created 2026-07-05T15:52:25.953Z.',
    ring: [
      [24.523533, 48.380094],
      [24.525016, 48.379566],
      [24.524822, 48.380508],
      [24.523619, 48.380779],
    ],
  },
  {
    name: 'Контур 79',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7yzhgb-2b · created 2026-07-05T15:52:38.939Z.',
    ring: [
      [24.513865, 48.345806],
      [24.525682, 48.343921],
      [24.524479, 48.341079],
      [24.514338, 48.343749],
    ],
  },
  {
    name: 'Контур 80',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z0678-2c · created 2026-07-05T15:53:11.012Z.',
    ring: [
      [24.520199, 48.271138],
      [24.520564, 48.270166],
      [24.521681, 48.270266],
      [24.521166, 48.271424],
    ],
  },
  {
    name: 'Контур 81',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z081o-2d · created 2026-07-05T15:53:13.404Z.',
    ring: [
      [24.522240, 48.267349],
      [24.522712, 48.266533],
      [24.523486, 48.266877],
      [24.522927, 48.267549],
    ],
  },
  {
    name: 'Контур 82',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z10tt-2e · created 2026-07-05T15:53:50.705Z.',
    ring: [
      [24.520070, 48.101195],
      [24.520671, 48.100133],
      [24.521187, 48.100750],
      [24.520886, 48.101424],
    ],
  },
  {
    name: 'Контур 83',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z1zkd-2f · created 2026-07-05T15:54:35.725Z.',
    ring: [
      [24.515089, 47.980388],
      [24.515798, 47.979550],
      [24.516863, 47.979983],
      [24.516258, 47.980668],
    ],
  },
  {
    name: 'Контур 84',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z28xf-2g · created 2026-07-05T15:54:47.859Z.',
    ring: [
      [24.514212, 47.940659],
      [24.512604, 47.941792],
      [24.513815, 47.942030],
      [24.514734, 47.941443],
    ],
  },
  {
    name: 'Контур 85',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z2axs-2h · created 2026-07-05T15:54:50.464Z.',
    ring: [
      [24.521957, 47.943093],
      [24.523668, 47.942324],
      [24.524169, 47.943107],
      [24.522833, 47.943428],
    ],
  },
  {
    name: 'Контур 86',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z5z6m-2i · created 2026-07-05T15:57:41.854Z.',
    ring: [
      [24.500262, 48.337125],
      [24.502036, 48.337236],
      [24.502412, 48.336264],
      [24.500575, 48.335682],
    ],
  },
  {
    name: 'Контур 87',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z6v67-2j · created 2026-07-05T15:58:23.311Z.',
    ring: [
      [24.497381, 48.260467],
      [24.499656, 48.260467],
      [24.498905, 48.258980],
    ],
  },
  {
    name: 'Контур 88',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z744o-2k · created 2026-07-05T15:58:34.920Z.',
    ring: [
      [24.500616, 48.237377],
      [24.503414, 48.237489],
      [24.502641, 48.235931],
      [24.500846, 48.236209],
    ],
  },
  {
    name: 'Контур 89',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z76lo-2l · created 2026-07-05T15:58:38.124Z.',
    ring: [
      [24.504875, 48.233679],
      [24.506128, 48.234360],
      [24.507171, 48.233415],
      [24.506169, 48.232552],
    ],
  },
  {
    name: 'Контур 90',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z7q0a-2m · created 2026-07-05T15:59:03.274Z.',
    ring: [
      [24.506128, 48.176748],
      [24.508862, 48.176762],
      [24.508090, 48.174632],
      [24.506232, 48.174855],
    ],
  },
  {
    name: 'Контур 91',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z85y4-2n · created 2026-07-05T15:59:23.932Z.',
    ring: [
      [24.501159, 48.116200],
      [24.503664, 48.116228],
      [24.503372, 48.114304],
      [24.501076, 48.114402],
    ],
  },
  {
    name: 'Контур 92',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7z8yhq-2o · created 2026-07-05T16:00:00.926Z.',
    ring: [
      [24.498675, 47.967096],
      [24.500930, 47.967599],
      [24.501305, 47.966592],
      [24.498967, 47.966201],
    ],
  },
  {
    name: 'Контур 93',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zavps-2p · created 2026-07-05T16:01:30.640Z.',
    ring: [
      [24.494980, 48.052048],
      [24.496128, 48.051364],
      [24.496943, 48.052118],
      [24.495774, 48.053039],
    ],
  },
  {
    name: 'Контур 94',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zbkm1-2q · created 2026-07-05T16:02:02.905Z.',
    ring: [
      [24.485169, 48.182036],
      [24.488175, 48.181521],
      [24.488822, 48.182801],
      [24.485816, 48.183107],
    ],
  },
  {
    name: 'Контур 95',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zbu3o-2r · created 2026-07-05T16:02:15.204Z.',
    ring: [
      [24.486463, 48.208197],
      [24.489052, 48.208976],
      [24.490429, 48.207167],
      [24.487611, 48.206819],
    ],
  },
  {
    name: 'Контур 96',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zc60z-2s · created 2026-07-05T16:02:30.659Z.',
    ring: [
      [24.483457, 48.249763],
      [24.483833, 48.247983],
      [24.485586, 48.248498],
      [24.485002, 48.250249],
    ],
  },
  {
    name: 'Контур 97',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zcrn5-2t · created 2026-07-05T16:02:58.673Z.',
    ring: [
      [24.477712, 48.318791],
      [24.480187, 48.319223],
      [24.489316, 48.317604],
      [24.497958, 48.313611],
      [24.494428, 48.311344],
      [24.489072, 48.312369],
    ],
  },
  {
    name: 'Контур 98',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zd26w-2u · created 2026-07-05T16:03:12.344Z.',
    ring: [
      [24.493243, 48.323761],
      [24.493431, 48.321984],
      [24.497606, 48.322928],
      [24.494328, 48.326315],
      [24.492846, 48.324663],
    ],
  },
  {
    name: 'Контур 99',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zdcx1-2v · created 2026-07-05T16:03:26.245Z.',
    ring: [
      [24.480137, 48.334879],
      [24.485754, 48.330584],
      [24.495649, 48.326153],
      [24.500655, 48.327662],
      [24.498152, 48.331222],
      [24.488082, 48.334995],
      [24.480254, 48.336620],
    ],
  },
  {
    name: 'Контур 100',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zdvjg-2w · created 2026-07-05T16:03:50.380Z.',
    ring: [
      [24.493201, 48.373638],
      [24.496436, 48.371984],
      [24.498633, 48.373259],
      [24.496903, 48.373891],
    ],
  },
  {
    name: 'Контур 101',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zemgg-2x · created 2026-07-05T16:04:25.264Z.',
    ring: [
      [24.488537, 48.448535],
      [24.490040, 48.448867],
      [24.490353, 48.448036],
      [24.488662, 48.447842],
    ],
  },
  {
    name: 'Контур 102',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zexds-2y · created 2026-07-05T16:04:39.424Z.',
    ring: [
      [24.480876, 48.452273],
      [24.481836, 48.451124],
      [24.484383, 48.451844],
      [24.483151, 48.452744],
    ],
  },
  {
    name: 'Контур 103',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zfgwk-2z · created 2026-07-05T16:05:04.724Z.',
    ring: [
      [24.481430, 48.424550],
      [24.482030, 48.423783],
      [24.482930, 48.424147],
      [24.482209, 48.424744],
    ],
  },
  {
    name: 'Контур 104',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zfqnf-30 · created 2026-07-05T16:05:17.355Z.',
    ring: [
      [24.476847, 48.404696],
      [24.477577, 48.403629],
      [24.480041, 48.404003],
      [24.479227, 48.405111],
    ],
  },
  {
    name: 'Контур 105',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zg966-31 · created 2026-07-05T16:05:41.358Z.',
    ring: [
      [24.480208, 48.348524],
      [24.485552, 48.349897],
      [24.485761, 48.348330],
      [24.481586, 48.347553],
    ],
  },
  {
    name: 'Контур 106',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zgias-32 · created 2026-07-05T16:05:53.188Z.',
    ring: [
      [24.470041, 48.319825],
      [24.472797, 48.320769],
      [24.473507, 48.319728],
      [24.471941, 48.318770],
    ],
  },
  {
    name: 'Контур 107',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zgrv8-33 · created 2026-07-05T16:06:05.588Z.',
    ring: [
      [24.478162, 48.312731],
      [24.481147, 48.313161],
      [24.481252, 48.311578],
      [24.478245, 48.311606],
    ],
  },
  {
    name: 'Контур 108',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zh6qg-34 · created 2026-07-05T16:06:24.856Z.',
    ring: [
      [24.470654, 48.297502],
      [24.474000, 48.297967],
      [24.482178, 48.297076],
      [24.485001, 48.293591],
      [24.483604, 48.293611],
      [24.469955, 48.296960],
    ],
  },
  {
    name: 'Контур 109',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zhc2u-35 · created 2026-07-05T16:06:31.782Z.',
    ring: [
      [24.472146, 48.287320],
      [24.473065, 48.286417],
      [24.474526, 48.286875],
      [24.473315, 48.287917],
    ],
  },
  {
    name: 'Контур 110',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zhe3w-36 · created 2026-07-05T16:06:34.412Z.',
    ring: [
      [24.476864, 48.289223],
      [24.478242, 48.289084],
      [24.478284, 48.289709],
      [24.476822, 48.289861],
    ],
  },
  {
    name: 'Контур 111',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zhg8y-37 · created 2026-07-05T16:06:37.186Z.',
    ring: [
      [24.480497, 48.286583],
      [24.480914, 48.285667],
      [24.482459, 48.286403],
      [24.481332, 48.286986],
    ],
  },
  {
    name: 'Контур 112',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zhlwf-38 · created 2026-07-05T16:06:44.511Z.',
    ring: [
      [24.479536, 48.273344],
      [24.481519, 48.273441],
      [24.481853, 48.272260],
      [24.479620, 48.272469],
    ],
  },
  {
    name: 'Контур 113',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zhvmg-39 · created 2026-07-05T16:06:57.112Z.',
    ring: [
      [24.477762, 48.222646],
      [24.480517, 48.222591],
      [24.480183, 48.221562],
      [24.477950, 48.221367],
    ],
  },
  {
    name: 'Контур 114',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zi3pk-3a · created 2026-07-05T16:07:07.592Z.',
    ring: [
      [24.473503, 48.215845],
      [24.476029, 48.209168],
      [24.482542, 48.208778],
      [24.481499, 48.210865],
    ],
  },
  {
    name: 'Контур 115',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zices-3b · created 2026-07-05T16:07:18.868Z.',
    ring: [
      [24.470998, 48.173667],
      [24.472293, 48.172261],
      [24.473963, 48.173722],
      [24.472501, 48.174405],
    ],
  },
  {
    name: 'Контур 116',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zikcz-3c · created 2026-07-05T16:07:29.171Z.',
    ring: [
      [24.482814, 48.145635],
      [24.484108, 48.144883],
      [24.485319, 48.145914],
      [24.483899, 48.146360],
    ],
  },
  {
    name: 'Контур 117',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zivpd-3d · created 2026-07-05T16:07:43.873Z.',
    ring: [
      [24.470038, 48.100263],
      [24.471207, 48.099635],
      [24.472585, 48.100723],
      [24.471249, 48.101211],
    ],
  },
  {
    name: 'Контур 118',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zj71c-3e · created 2026-07-05T16:07:58.560Z.',
    ring: [
      [24.473336, 48.057989],
      [24.476551, 48.057096],
      [24.477010, 48.058575],
      [24.474422, 48.059050],
    ],
  },
  {
    name: 'Контур 119',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zjo3e-3f · created 2026-07-05T16:08:20.666Z.',
    ring: [
      [24.472668, 47.969817],
      [24.475466, 47.969691],
      [24.475841, 47.972318],
      [24.472835, 47.972249],
    ],
  },
  {
    name: 'Контур 120',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zjvzi-3g · created 2026-07-05T16:08:30.894Z.',
    ring: [
      [24.470226, 47.954608],
      [24.471792, 47.953783],
      [24.473274, 47.955377],
      [24.471040, 47.955712],
    ],
  },
  {
    name: 'Контур 121',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zk1lk-3h · created 2026-07-05T16:08:38.168Z.',
    ring: [
      [24.477240, 47.953839],
      [24.479808, 47.952357],
      [24.477929, 47.949798],
      [24.480580, 47.949561],
      [24.481895, 47.953601],
      [24.479474, 47.955251],
    ],
  },
  {
    name: 'Контур 122',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zkbgz-3i · created 2026-07-05T16:08:50.963Z.',
    ring: [
      [24.483774, 47.929842],
      [24.484505, 47.928108],
      [24.486321, 47.928457],
      [24.485423, 47.930486],
    ],
  },
  {
    name: 'Контур 123',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zlw98-3j · created 2026-07-05T16:10:04.556Z.',
    ring: [
      [24.464026, 48.070113],
      [24.465007, 48.068634],
      [24.469453, 48.069081],
      [24.468264, 48.070755],
    ],
  },
  {
    name: 'Контур 124',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zmch6-3k · created 2026-07-05T16:10:25.578Z.',
    ring: [
      [24.466489, 48.129071],
      [24.467095, 48.127483],
      [24.469787, 48.127734],
      [24.468556, 48.129266],
    ],
  },
  {
    name: 'Контур 125',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zmpn5-3l · created 2026-07-05T16:10:42.641Z.',
    ring: [
      [24.466552, 48.160175],
      [24.467491, 48.158894],
      [24.470539, 48.160384],
      [24.469182, 48.161261],
    ],
  },
  {
    name: 'Контур 126',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zn439-3m · created 2026-07-05T16:11:01.365Z.',
    ring: [
      [24.465612, 48.223231],
      [24.466552, 48.221520],
      [24.469913, 48.222605],
      [24.467324, 48.223870],
    ],
  },
  {
    name: 'Контур 127',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zneqb-3n · created 2026-07-05T16:11:15.155Z.',
    ring: [
      [24.457847, 48.269509],
      [24.460268, 48.268231],
      [24.463525, 48.270621],
      [24.460393, 48.271538],
    ],
  },
  {
    name: 'Контур 128',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7znowx-3o · created 2026-07-05T16:11:28.353Z.',
    ring: [
      [24.467909, 48.290236],
      [24.471520, 48.291792],
      [24.470852, 48.287917],
      [24.472313, 48.288764],
    ],
  },
  {
    name: 'Контур 129',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zny12-3p · created 2026-07-05T16:11:40.166Z.',
    ring: [
      [24.458515, 48.293514],
      [24.465237, 48.290875],
      [24.468556, 48.293959],
      [24.467136, 48.297195],
      [24.458619, 48.297903],
    ],
  },
  {
    name: 'Контур 130',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zo7mc-3q · created 2026-07-05T16:11:52.596Z.',
    ring: [
      [24.461792, 48.305457],
      [24.464172, 48.311691],
      [24.468785, 48.312025],
      [24.469224, 48.311580],
      [24.467095, 48.309664],
      [24.464694, 48.304777],
      [24.464068, 48.304444],
    ],
  },
  {
    name: 'Контур 131',
    note:
      'Imported from repomapper-export-1783268027369.json · manual contour ' +
      'contour-mr7zodat-3r · created 2026-07-05T16:11:59.957Z.',
    ring: [
      [24.469620, 48.313885],
      [24.471478, 48.313885],
      [24.471457, 48.312774],
      [24.469641, 48.312719],
    ],
  },
  {
    name: 'Контур 132',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr9364f0-0 · created 2026-07-06T10:37:33.276Z.',
    ring: [
      [24.561591, 48.376350],
      [24.562370, 48.375558],
      [24.563513, 48.375910],
      [24.563629, 48.376603],
    ],
  },
  {
    name: 'Контур 134',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr937rva-2 · created 2026-07-06T10:38:50.326Z.',
    ring: [
      [24.563596, 48.277595],
      [24.563809, 48.270066],
      [24.568505, 48.271682],
      [24.568771, 48.276174],
    ],
  },
  {
    name: 'Контур 135',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr9385ko-3 · created 2026-07-06T10:39:08.088Z.',
    ring: [
      [24.559842, 48.262821],
      [24.561488, 48.263675],
      [24.562502, 48.262286],
      [24.560378, 48.261853],
    ],
  },
  {
    name: 'Контур 136',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93881r-4 · created 2026-07-06T10:39:11.295Z.',
    ring: [
      [24.561583, 48.259076],
      [24.563153, 48.259127],
      [24.562904, 48.258057],
      [24.561449, 48.258044],
    ],
  },
  {
    name: 'Контур 137',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr938em2-5 · created 2026-07-06T10:39:19.802Z.',
    ring: [
      [24.551996, 48.247570],
      [24.552379, 48.246385],
      [24.555345, 48.246704],
      [24.553986, 48.248118],
    ],
  },
  {
    name: 'Контур 138',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr938kcz-6 · created 2026-07-06T10:39:27.251Z.',
    ring: [
      [24.558311, 48.236763],
      [24.558426, 48.235514],
      [24.560761, 48.235756],
      [24.559995, 48.237222],
    ],
  },
  {
    name: 'Контур 139',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr938x03-7 · created 2026-07-06T10:39:43.635Z.',
    ring: [
      [24.559249, 48.190844],
      [24.559517, 48.190283],
      [24.560895, 48.190398],
      [24.560033, 48.191610],
    ],
  },
  {
    name: 'Контур 140',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr939lx5-8 · created 2026-07-06T10:40:15.929Z.',
    ring: [
      [24.561009, 48.082062],
      [24.561737, 48.081167],
      [24.563267, 48.081998],
      [24.561851, 48.082727],
    ],
  },
  {
    name: 'Контур 141',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93akzz-9 · created 2026-07-06T10:41:01.391Z.',
    ring: [
      [24.557565, 47.950522],
      [24.558254, 47.949625],
      [24.559708, 47.950125],
      [24.558751, 47.951048],
    ],
  },
  {
    name: 'Контур 142',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93daq8-a · created 2026-07-06T10:43:08.048Z.',
    ring: [
      [24.567114, 47.997142],
      [24.568894, 47.998141],
      [24.570195, 47.997078],
      [24.568568, 47.996323],
    ],
  },
  {
    name: 'Контур 143',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93eo6c-b · created 2026-07-06T10:44:12.132Z.',
    ring: [
      [24.575845, 48.018442],
      [24.578214, 48.018542],
      [24.577965, 48.017378],
      [24.575861, 48.017423],
    ],
  },
  {
    name: 'Контур 144',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93f3ha-c · created 2026-07-06T10:44:31.966Z.',
    ring: [
      [24.570031, 48.056828],
      [24.573625, 48.057891],
      [24.575961, 48.056308],
      [24.570280, 48.055599],
    ],
  },
  {
    name: 'Контур 145',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93g38j-d · created 2026-07-06T10:45:18.307Z.',
    ring: [
      [24.575199, 48.176665],
      [24.577170, 48.176433],
      [24.576458, 48.175417],
      [24.574702, 48.175638],
    ],
  },
  {
    name: 'Контур 146',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93gb9x-e · created 2026-07-06T10:45:28.725Z.',
    ring: [
      [24.569037, 48.183192],
      [24.570594, 48.184992],
      [24.572284, 48.184451],
      [24.570694, 48.182496],
    ],
  },
  {
    name: 'Контур 147',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93ge5h-f · created 2026-07-06T10:45:32.453Z.',
    ring: [
      [24.567894, 48.187101],
      [24.568408, 48.186063],
      [24.569932, 48.186549],
      [24.568954, 48.187543],
    ],
  },
  {
    name: 'Контур 148',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93hk2x-g · created 2026-07-06T10:46:26.793Z.',
    ring: [
      [24.564840, 48.279143],
      [24.565916, 48.278001],
      [24.571968, 48.278315],
      [24.571699, 48.276077],
      [24.573111, 48.275227],
      [24.574456, 48.275808],
      [24.588208, 48.270281],
      [24.588074, 48.275495],
      [24.574154, 48.282119],
    ],
  },
  {
    name: 'Контур 149',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93i1wi-h · created 2026-07-06T10:46:49.890Z.',
    ring: [
      [24.569177, 48.301109],
      [24.572049, 48.303652],
      [24.575734, 48.303111],
      [24.576374, 48.300672],
      [24.573104, 48.298934],
      [24.570890, 48.297553],
      [24.569852, 48.298002],
      [24.569419, 48.299901],
    ],
  },
  {
    name: 'Контур 150',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93i8jl-i · created 2026-07-06T10:46:58.497Z.',
    ring: [
      [24.575907, 48.309026],
      [24.577221, 48.307576],
      [24.579367, 48.308773],
      [24.578536, 48.309532],
    ],
  },
  {
    name: 'Контур 151',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93iuq8-j · created 2026-07-06T10:47:27.248Z.',
    ring: [
      [24.571270, 48.370996],
      [24.573865, 48.368537],
      [24.575976, 48.368767],
      [24.572498, 48.371548],
    ],
  },
  {
    name: 'Контур 152',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93j3eg-k · created 2026-07-06T10:47:38.488Z.',
    ring: [
      [24.572775, 48.395251],
      [24.573294, 48.394688],
      [24.574332, 48.395343],
      [24.573381, 48.395584],
    ],
  },
  {
    name: 'Контур 153',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93rxhs-l · created 2026-07-06T10:54:30.736Z.',
    ring: [
      [24.572947, 48.400847],
      [24.575725, 48.399998],
      [24.578523, 48.401803],
      [24.576165, 48.402519],
    ],
  },
  {
    name: 'Контур 154',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93sanz-m · created 2026-07-06T10:54:47.807Z.',
    ring: [
      [24.575125, 48.435960],
      [24.577084, 48.436597],
      [24.574526, 48.438944],
      [24.569969, 48.438453],
      [24.567271, 48.437034],
    ],
  },
  {
    name: 'Контур 155',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93slkp-n · created 2026-07-06T10:55:01.945Z.',
    ring: [
      [24.574766, 48.443518],
      [24.578903, 48.444658],
      [24.582001, 48.444565],
      [24.579063, 48.447747],
      [24.567750, 48.446011],
    ],
  },
  {
    name: 'Контур 156',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93t2l8-o · created 2026-07-06T10:55:23.996Z.',
    ring: [
      [24.575405, 48.518652],
      [24.576465, 48.516719],
      [24.578903, 48.517248],
      [24.578084, 48.518983],
    ],
  },
  {
    name: 'Контур 157',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr93ur7n-p · created 2026-07-06T10:56:42.563Z.',
    ring: [
      [24.586408, 48.450565],
      [24.587068, 48.450154],
      [24.584190, 48.446959],
      [24.582551, 48.448391],
      [24.583730, 48.449969],
    ],
  },
  {
    name: 'Контур 158',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94gyb7-r · created 2026-07-06T11:13:58.195Z.',
    ring: [
      [24.582139, 48.443493],
      [24.584797, 48.442592],
      [24.585457, 48.443241],
      [24.584218, 48.444024],
    ],
  },
  {
    name: 'Контур 159',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94h3z1-s · created 2026-07-06T11:14:05.533Z.',
    ring: [
      [24.585597, 48.440351],
      [24.589554, 48.439065],
      [24.589814, 48.439966],
      [24.586536, 48.440802],
    ],
  },
  {
    name: 'Контур 160',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94hm0b-t · created 2026-07-06T11:14:28.907Z.',
    ring: [
      [24.579341, 48.398845],
      [24.580080, 48.398142],
      [24.581379, 48.399111],
      [24.579980, 48.399628],
    ],
  },
  {
    name: 'Контур 161',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94hpa1-u · created 2026-07-06T11:14:33.145Z.',
    ring: [
      [24.590533, 48.399788],
      [24.591613, 48.398487],
      [24.593352, 48.398885],
      [24.593931, 48.400849],
    ],
  },
  {
    name: 'Контур 162',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94ibe3-v · created 2026-07-06T11:15:01.803Z.',
    ring: [
      [24.579658, 48.297772],
      [24.580623, 48.297890],
      [24.580830, 48.297287],
      [24.579806, 48.297130],
      [24.579530, 48.297811],
    ],
  },
  {
    name: 'Контур 163',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94il4f-w · created 2026-07-06T11:15:14.415Z.',
    ring: [
      [24.589276, 48.291720],
      [24.590615, 48.291873],
      [24.590788, 48.291020],
      [24.589410, 48.291020],
    ],
  },
  {
    name: 'Контур 164',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94isvr-x · created 2026-07-06T11:15:24.471Z.',
    ring: [
      [24.578827, 48.286207],
      [24.583726, 48.286793],
      [24.588606, 48.281177],
      [24.577756, 48.284882],
    ],
  },
  {
    name: 'Контур 165',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94izjn-y · created 2026-07-06T11:15:33.107Z.',
    ring: [
      [24.587764, 48.268937],
      [24.588587, 48.267944],
      [24.589926, 48.268377],
      [24.589046, 48.269383],
    ],
  },
  {
    name: 'Контур 166',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94jag9-z · created 2026-07-06T11:15:47.241Z.',
    ring: [
      [24.586290, 48.224029],
      [24.587668, 48.223978],
      [24.587381, 48.222754],
      [24.585869, 48.222895],
    ],
  },
  {
    name: 'Контур 167',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94jpcl-10 · created 2026-07-06T11:16:06.549Z.',
    ring: [
      [24.588702, 48.207720],
      [24.590330, 48.206262],
      [24.583847, 48.201603],
      [24.582646, 48.203524],
      [24.583953, 48.205817],
    ],
  },
  {
    name: 'Контур 168',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94k9ns-11 · created 2026-07-06T11:16:32.872Z.',
    ring: [
      [24.587730, 48.139555],
      [24.588866, 48.138650],
      [24.590790, 48.139518],
      [24.589361, 48.140447],
    ],
  },
  {
    name: 'Контур 169',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94lgg5-12 · created 2026-07-06T11:17:28.325Z.',
    ring: [
      [24.579169, 47.997169],
      [24.579528, 47.996112],
      [24.581127, 47.996714],
      [24.580448, 47.997663],
    ],
  },
  {
    name: 'Контур 170',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94lpq5-13 · created 2026-07-06T11:17:40.349Z.',
    ring: [
      [24.590022, 47.969716],
      [24.592760, 47.970814],
      [24.593499, 47.969663],
      [24.591261, 47.968914],
    ],
  },
  {
    name: 'Контур 171',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94m1bz-14 · created 2026-07-06T11:17:55.391Z.',
    ring: [
      [24.597089, 47.948569],
      [24.597371, 47.947958],
      [24.598365, 47.948269],
      [24.597653, 47.948901],
    ],
  },
  {
    name: 'Контур 172',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94n6gs-15 · created 2026-07-06T11:18:48.700Z.',
    ring: [
      [24.599571, 48.002006],
      [24.600465, 48.000898],
      [24.602254, 48.001829],
      [24.600896, 48.002671],
    ],
  },
  {
    name: 'Контур 173',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94nj35-16 · created 2026-07-06T11:19:05.057Z.',
    ring: [
      [24.604656, 48.028986],
      [24.606329, 48.029551],
      [24.608333, 48.028510],
      [24.606362, 48.028055],
    ],
  },
  {
    name: 'Контур 174',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94nu6m-17 · created 2026-07-06T11:19:19.438Z.',
    ring: [
      [24.596937, 48.040925],
      [24.597169, 48.040139],
      [24.598411, 48.040338],
      [24.597980, 48.041213],
    ],
  },
  {
    name: 'Контур 175',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94qhzd-18 · created 2026-07-06T11:21:23.593Z.',
    ring: [
      [24.598610, 48.433260],
      [24.599206, 48.432623],
      [24.600432, 48.433458],
      [24.599521, 48.434051],
    ],
  },
  {
    name: 'Контур 176',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94qxp1-19 · created 2026-07-06T11:21:43.957Z.',
    ring: [
      [24.601442, 48.441051],
      [24.603165, 48.439798],
      [24.602436, 48.443710],
      [24.601177, 48.446589],
      [24.599885, 48.444435],
    ],
  },
  {
    name: 'Контур 177',
    note:
      'Imported from repomapper-export-1783341016188 (2).json · manual contour ' +
      'contour-mr94r3ex-1a · created 2026-07-06T11:21:51.369Z.',
    ring: [
      [24.602038, 48.447424],
      [24.604142, 48.446215],
      [24.604705, 48.446589],
      [24.602171, 48.447885],
    ],
  },
  {
    name: 'Контур 178',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99nd29-0 · created 2026-07-06T13:38:55.329Z.',
    ring: [
      [24.612113, 48.445838],
      [24.614039, 48.446386],
      [24.614864, 48.445038],
      [24.612917, 48.444631],
    ],
  },
  {
    name: 'Контур 179',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99nfko-1 · created 2026-07-06T13:38:58.584Z.',
    ring: [
      [24.618823, 48.447818],
      [24.619415, 48.446835],
      [24.621236, 48.447439],
      [24.620283, 48.448352],
    ],
  },
  {
    name: 'Контур 180',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99npzq-2 · created 2026-07-06T13:39:12.086Z.',
    ring: [
      [24.614118, 48.435926],
      [24.614690, 48.437134],
      [24.619304, 48.440631],
      [24.617928, 48.435421],
      [24.615811, 48.434676],
    ],
  },
  {
    name: 'Контур 181',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99nyvs-3 · created 2026-07-06T13:39:23.608Z.',
    ring: [
      [24.610543, 48.433970],
      [24.610679, 48.432751],
      [24.613488, 48.432982],
      [24.612653, 48.434473],
    ],
  },
  {
    name: 'Контур 182',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99o8hl-4 · created 2026-07-06T13:39:36.057Z.',
    ring: [
      [24.611545, 48.421184],
      [24.613579, 48.422413],
      [24.614855, 48.421768],
    ],
  },
  {
    name: 'Контур 183',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99or53-5 · created 2026-07-06T13:40:00.231Z.',
    ring: [
      [24.608258, 48.351722],
      [24.609358, 48.349921],
      [24.610353, 48.350596],
      [24.608596, 48.352425],
    ],
  },
  {
    name: 'Контур 184',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99p1fq-6 · created 2026-07-06T13:40:13.574Z.',
    ring: [
      [24.619985, 48.342915],
      [24.620387, 48.341508],
      [24.622271, 48.342127],
      [24.621085, 48.343337],
    ],
  },
  {
    name: 'Контур 185',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99p3oo-7 · created 2026-07-06T13:40:16.488Z.',
    ring: [
      [24.625700, 48.340213],
      [24.627774, 48.338328],
      [24.628918, 48.339411],
      [24.626250, 48.340804],
    ],
  },
  {
    name: 'Контур 186',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ramz-a · created 2026-07-06T13:41:58.811Z.',
    ring: [
      [24.611581, 48.128792],
      [24.618988, 48.134091],
      [24.627133, 48.135016],
      [24.626424, 48.137852],
      [24.630143, 48.137734],
      [24.630349, 48.135391],
      [24.633094, 48.133697],
      [24.633064, 48.131373],
      [24.627192, 48.130486],
      [24.621408, 48.129265],
    ],
  },
  {
    name: 'Контур 187',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99rz8n-b · created 2026-07-06T13:42:30.695Z.',
    ring: [
      [24.610752, 48.007978],
      [24.612741, 48.010074],
      [24.614011, 48.009324],
      [24.611344, 48.006789],
    ],
  },
  {
    name: 'Контур 188',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99tbl5-c · created 2026-07-06T13:43:33.353Z.',
    ring: [
      [24.625969, 47.993476],
      [24.629801, 47.993972],
      [24.630351, 47.992924],
      [24.625885, 47.992272],
    ],
  },
  {
    name: 'Контур 189',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99tqbq-d · created 2026-07-06T13:43:52.454Z.',
    ring: [
      [24.626012, 48.047746],
      [24.629420, 48.047703],
      [24.628890, 48.045878],
      [24.625715, 48.046048],
    ],
  },
  {
    name: 'Контур 190',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99u9go-e · created 2026-07-06T13:44:17.256Z.',
    ring: [
      [24.622625, 48.141905],
      [24.626985, 48.140337],
      [24.627578, 48.141510],
      [24.622921, 48.142654],
    ],
  },
  {
    name: 'Контур 191',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ubol-f · created 2026-07-06T13:44:20.133Z.',
    ring: [
      [24.627747, 48.144292],
      [24.629356, 48.144900],
      [24.630139, 48.144024],
      [24.628298, 48.143586],
    ],
  },
  {
    name: 'Контур 192',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ue1l-g · created 2026-07-06T13:44:23.193Z.',
    ring: [
      [24.631092, 48.142301],
      [24.632785, 48.141298],
      [24.633695, 48.141933],
      [24.632108, 48.142965],
    ],
  },
  {
    name: 'Контур 193',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99urvp-h · created 2026-07-06T13:44:41.125Z.',
    ring: [
      [24.635025, 48.141664],
      [24.638773, 48.143949],
      [24.640426, 48.142334],
      [24.636147, 48.140975],
    ],
  },
  {
    name: 'Контур 194',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99uul7-i · created 2026-07-06T13:44:44.635Z.',
    ring: [
      [24.636383, 48.139065],
      [24.635320, 48.136485],
      [24.638950, 48.136406],
    ],
  },
  {
    name: 'Контур 195',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99vbrn-j · created 2026-07-06T13:45:06.899Z.',
    ring: [
      [24.635792, 48.128764],
      [24.637770, 48.126401],
      [24.643819, 48.123938],
      [24.647803, 48.123623],
      [24.650253, 48.126578],
      [24.655328, 48.126026],
      [24.655181, 48.126775],
      [24.650046, 48.129001],
      [24.651345, 48.132172],
      [24.647184, 48.133137],
      [24.642019, 48.129237],
      [24.638065, 48.131936],
    ],
  },
  {
    name: 'Контур 196',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99vor0-k · created 2026-07-06T13:45:23.724Z.',
    ring: [
      [24.632199, 48.149120],
      [24.634358, 48.149247],
      [24.634506, 48.147580],
      [24.632834, 48.147651],
    ],
  },
  {
    name: 'Контур 197',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99vwhp-l · created 2026-07-06T13:45:33.757Z.',
    ring: [
      [24.630484, 48.153173],
      [24.630886, 48.151944],
      [24.632220, 48.152523],
      [24.631415, 48.153540],
    ],
  },
  {
    name: 'Контур 198',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99wlts-m · created 2026-07-06T13:46:06.592Z.',
    ring: [
      [24.615412, 48.186194],
      [24.617974, 48.191471],
      [24.618672, 48.190540],
      [24.616915, 48.185417],
    ],
  },
  {
    name: 'Контур 199',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99x0dd-n · created 2026-07-06T13:46:25.441Z.',
    ring: [
      [24.627647, 48.236228],
      [24.623816, 48.235057],
      [24.624874, 48.233464],
      [24.628282, 48.234479],
    ],
  },
  {
    name: 'Контур 200',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99y0vn-o · created 2026-07-06T13:47:12.755Z.',
    ring: [
      [24.619413, 48.432617],
      [24.622525, 48.433867],
      [24.623223, 48.432575],
      [24.620090, 48.431128],
    ],
  },
  {
    name: 'Контур 201',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ybd1-p · created 2026-07-06T13:47:26.341Z.',
    ring: [
      [24.624007, 48.465022],
      [24.625848, 48.465050],
      [24.625531, 48.463759],
      [24.623837, 48.463787],
    ],
  },
  {
    name: 'Контур 202',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ydox-q · created 2026-07-06T13:47:29.361Z.',
    ring: [
      [24.617444, 48.468419],
      [24.619392, 48.467436],
      [24.620577, 48.468405],
      [24.618545, 48.468896],
    ],
  },
  {
    name: 'Контур 203',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99zkdg-r · created 2026-07-06T13:48:24.676Z.',
    ring: [
      [24.637385, 48.458088],
      [24.638507, 48.456403],
      [24.640391, 48.457807],
      [24.638951, 48.458818],
    ],
  },
  {
    name: 'Контур 204',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99ztxm-s · created 2026-07-06T13:48:37.066Z.',
    ring: [
      [24.638422, 48.427982],
      [24.641216, 48.427139],
      [24.641893, 48.427925],
      [24.638464, 48.428586],
    ],
  },
  {
    name: 'Контур 205',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr99zxtl-t · created 2026-07-06T13:48:42.105Z.',
    ring: [
      [24.640306, 48.421295],
      [24.641639, 48.421464],
      [24.641957, 48.420705],
      [24.640348, 48.420593],
    ],
  },
  {
    name: 'Контур 206',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr9a0672-u · created 2026-07-06T13:48:52.958Z.',
    ring: [
      [24.643291, 48.392446],
      [24.644772, 48.392545],
      [24.644963, 48.391659],
      [24.643502, 48.391603],
    ],
  },
  {
    name: 'Контур 207',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr9a0viz-v · created 2026-07-06T13:49:25.787Z.',
    ring: [
      [24.644751, 48.244263],
      [24.647228, 48.244348],
      [24.647016, 48.242995],
      [24.644857, 48.243319],
    ],
  },
  {
    name: 'Контур 208',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr9a27aq-w · created 2026-07-06T13:50:27.698Z.',
    ring: [
      [24.634209, 47.965729],
      [24.634718, 47.964851],
      [24.636178, 47.965191],
      [24.635649, 47.966154],
    ],
  },
  {
    name: 'Контур 209',
    note:
      'Imported from repomapper-export-1783345897700 (2).json · manual contour ' +
      'contour-mr9a2fra-x · created 2026-07-06T13:50:38.662Z.',
    ring: [
      [24.636855, 47.925546],
      [24.639184, 47.925915],
      [24.639311, 47.924737],
      [24.636665, 47.924482],
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
