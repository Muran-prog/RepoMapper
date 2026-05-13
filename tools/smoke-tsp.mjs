/**
 * Smoke tests for the drawing engine's routing subsystem.
 *
 *   node tools/smoke-tsp.mjs
 *
 * Covers two invariants:
 *
 *   1. OPEN-TSP solver: every converged tour has NO self-intersecting
 *      segments over Euclidean-in-lng/lat layouts. A converged 2-opt
 *      cannot leave a crossing — if one is found the solver hasn't
 *      converged. Runs a matrix of random seeds + one pathological
 *      layout the old `i === 0, j == n-1` bound would have tangled.
 *
 *   2. MODE-SWITCH INVARIANCE (architectural fix): the auto-generated
 *      lines created by one connection mode are permanent features —
 *      switching to a different mode MUST NOT mutate them. This is
 *      what makes the drawing tab predictable: the user's route stays
 *      exactly as drawn, regardless of what the mode picker shows.
 *
 * Both invariants are tested without MapLibre — the engine's map
 * dependency is mocked down to the handful of methods it actually
 * calls during marker placement / mode switching.
 */
import { optimalTour, haversine } from '../src/draw/connections.js';

// ---------------------------------------------------------------------------
// Global shims — the drawing engine was written for a browser runtime, so
// `window`, `document`, rAF and timers need cooperative stubs before we can
// import it under Node. Store.js already guards against a missing
// localStorage, so we just provide enough surface for the keydown listener
// and the pencil recorder's rAF coalescing (the latter never fires for the
// select tool, but it's cheap to stub).
// ---------------------------------------------------------------------------
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { documentElement: { dataset: {} } };
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

const { createDrawEngine } = await import('../src/draw/engine.js');

/** Mulberry32 PRNG — seed-stable random generator for reproducibility. */
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Standard 2D segment-segment intersection. Treats shared endpoints
 *  (common in a tour — tour[i+1] == tour[i+1]) as non-crossing. */
function segmentsCross(p1, p2, p3, p4) {
  const sharesEnd =
    (p1[0] === p3[0] && p1[1] === p3[1]) ||
    (p1[0] === p4[0] && p1[1] === p4[1]) ||
    (p2[0] === p3[0] && p2[1] === p3[1]) ||
    (p2[0] === p4[0] && p2[1] === p4[1]);
  if (sharesEnd) return false;

  const d = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function countCrossings(tour, points) {
  let count = 0;
  const segs = [];
  for (let i = 0; i < tour.length - 1; i++) {
    segs.push([points[tour[i]], points[tour[i + 1]]]);
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      if (segmentsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) {
        count++;
      }
    }
  }
  return count;
}

function tourLengthMeters(tour, points) {
  let total = 0;
  for (let i = 0; i < tour.length - 1; i++) {
    total += haversine(points[tour[i]], points[tour[i + 1]]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Random layout test — Carpathian-sized bbox. N markers, many seeds.
// ---------------------------------------------------------------------------
const BBOX = { minLng: 24.1, maxLng: 25.0, minLat: 48.0, maxLat: 48.3 };

let failed = 0;
let passed = 0;
const sizes = [6, 8, 10, 12, 15, 20];

for (const n of sizes) {
  for (let seed = 1; seed <= 20; seed++) {
    const rand = rng(seed * 1000 + n);
    const points = Array.from({ length: n }, () => [
      BBOX.minLng + rand() * (BBOX.maxLng - BBOX.minLng),
      BBOX.minLat + rand() * (BBOX.maxLat - BBOX.minLat),
    ]);

    const tour = optimalTour(points);
    const crossings = countCrossings(tour, points);
    const len = tourLengthMeters(tour, points);

    if (crossings > 0) {
      failed++;
      console.log(`  FAIL n=${n} seed=${seed}: ${crossings} crossing(s), len=${(len / 1000).toFixed(1)} km`);
    } else {
      passed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Pathological case — a layout where the old `i === 0, j == n-1` bound
// would leave a crossing: the nearest-neighbour seed visits the far
// endpoint first. 2-opt must reverse the whole suffix to fix it.
// ---------------------------------------------------------------------------
const pathological = [
  [24.0, 48.0], // 0 — start
  [24.1, 48.1], // 1
  [24.2, 48.0], // 2
  [24.3, 48.1], // 3
  [24.4, 48.0], // 4 — end
];
const patTour = optimalTour(pathological);
const patCrossings = countCrossings(patTour, pathological);
if (patCrossings > 0) {
  failed++;
  console.log(`  FAIL pathological layout: ${patCrossings} crossing(s)`);
} else {
  passed++;
}

console.log(`TSP solver: ${passed} passed, ${failed} failed out of ${passed + failed}`);

// ===========================================================================
// Mode-switch invariance — architectural regression test.
//
// Reproduces the exact bug the user hit: draw a sequence route, switch the
// connection mode, and verify the existing lines do NOT change. Also covers
// the converse (hub / mesh / optimal one-shot) plus the "optimal is a single
// action" contract: selecting optimal commits the tour and reverts the
// persisted mode to `none` so future markers don't re-trigger TSP.
// ===========================================================================

/**
 * Minimal MapLibre stand-in. Only surfaces the method set the engine
 * touches during `createDrawEngine`, marker placement and mode changes.
 * No rendering, no events fired back — the engine mutates its own
 * `state.features` synchronously and we read it via `exportGeoJSON`.
 */
function makeMockMap() {
  const sources = new Map();
  const layers = new Map();
  const container = {
    dataset: {},
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const canvas = { style: {} };
  const map = {
    getContainer: () => container,
    getCanvas: () => canvas,
    getStyle: () => ({ layers: [] }),
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      sources.set(id, { ...spec, setData() {} });
    },
    getLayer: (id) => layers.get(id),
    addLayer: (spec) => layers.set(spec.id, spec),
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id),
    setFeatureState() {},
    queryRenderedFeatures: () => [],
    setPaintProperty() {},
    project: (ll) => ({ x: ll[0] * 1000, y: ll[1] * 1000 }),
    unproject: ([x, y]) => ({ lng: x / 1000, lat: y / 1000 }),
    on() {}, off() {},
    once(evt, fn) { if (evt === 'load') fn(); },
    dragPan:         { enable() {}, disable() {} },
    scrollZoom:      { enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {} },
    touchPitch:      { enable() {}, disable() {} },
    touchZoomRotate: { enable() {}, disable() {} },
  };
  return map;
}

/** Key each line feature by its endpoint coords so we can detect mutation. */
function lineKey(feature) {
  const c = feature.geometry?.coordinates ?? [];
  const first = c[0] ?? [];
  const last = c[c.length - 1] ?? [];
  return `${first[0]},${first[1]}→${last[0]},${last[1]}  len=${c.length}`;
}

function onlyLines(engine) {
  return engine.exportGeoJSON().features.filter((f) => f.properties?.kind === 'line');
}

function onlyMarkers(engine) {
  return engine.exportGeoJSON().features.filter((f) => f.properties?.kind === 'marker');
}

/** Place a marker via the engine's internal hook — same code path the UI uses. */
function placeMarker(engine, lngLat) {
  engine._addFeature({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: lngLat },
    properties: { kind: 'marker' },
  });
}

let invFail = 0;
let invPass = 0;
const invariantCheck = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    invPass++;
  } else {
    invFail++;
    console.log(`  FAIL ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
};

const PTS = [
  [24.0, 48.0],
  [24.2, 48.2],
  [24.4, 48.0],
  [24.6, 48.2],
];

// ---------------------------------------------------------------------------
// Test 1: sequence → hub switch must not touch existing lines.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);

  const before = onlyLines(engine).map(lineKey).sort();
  invariantCheck(
    'sequence produced N-1 lines',
    before.length,
    PTS.length - 1,
  );

  engine.setConnectionMode('hub');
  const after = onlyLines(engine).map(lineKey).sort();
  invariantCheck('sequence→hub preserves lines', after, before);

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 2: new marker in hub mode adds exactly one hub line; prior sequence
// lines remain unchanged.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);
  const seqKeys = onlyLines(engine).map(lineKey).sort();

  // Capture the first marker + grab the id BEFORE the hub placement so
  // we can assert the hub leg's endpoints by id — geodesic slerp
  // introduces tiny floating-point drift on the interpolated coords
  // that would make a raw coord comparison flaky.
  const firstMarkerId = onlyMarkers(engine)[0].id;

  engine.setConnectionMode('hub');
  placeMarker(engine, [24.8, 48.3]);
  const newMarkerId = onlyMarkers(engine).at(-1).id;

  const all = onlyLines(engine);
  const seqAfter = all.filter((l) => l.properties.autoMode === 'sequence').map(lineKey).sort();
  const hubAfter = all.filter((l) => l.properties.autoMode === 'hub');

  invariantCheck('old sequence lines unchanged after hub placement', seqAfter, seqKeys);
  invariantCheck('hub mode adds exactly 1 line per marker', hubAfter.length, 1);
  invariantCheck(
    'hub line connects first marker to the new marker',
    [hubAfter[0].properties.fromId, hubAfter[0].properties.toId],
    [firstMarkerId, newMarkerId],
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 3: mesh mode adds N lines when the Nth marker arrives (one to each
// prior marker), and switching back to sequence leaves them all alone.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('mesh');
  placeMarker(engine, PTS[0]);
  invariantCheck('mesh: first marker yields 0 lines', onlyLines(engine).length, 0);
  placeMarker(engine, PTS[1]);
  invariantCheck('mesh: second marker yields 1 line', onlyLines(engine).length, 1);
  placeMarker(engine, PTS[2]);
  invariantCheck('mesh: third marker yields 3 lines total', onlyLines(engine).length, 3);
  placeMarker(engine, PTS[3]);
  invariantCheck('mesh: fourth marker yields 6 lines total', onlyLines(engine).length, 6);

  const meshBefore = onlyLines(engine).map(lineKey).sort();
  engine.setConnectionMode('sequence');
  const meshAfter = onlyLines(engine).map(lineKey).sort();
  invariantCheck('mesh→sequence preserves mesh lines', meshAfter, meshBefore);

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 4: optimal is a one-shot — selecting it runs TSP, commits lines, and
// reverts the persisted mode to 'none'. Subsequent marker placements must
// NOT trigger further auto-connections.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('none');
  for (const p of PTS) placeMarker(engine, p);
  invariantCheck('none mode: zero auto lines', onlyLines(engine).length, 0);

  engine.setConnectionMode('optimal');

  const linesAfter = onlyLines(engine);
  invariantCheck('optimal commits N-1 tour legs', linesAfter.length, PTS.length - 1);
  invariantCheck(
    'every committed leg is autoMode=optimal',
    linesAfter.every((l) => l.properties.autoMode === 'optimal'),
    true,
  );
  invariantCheck(
    'optimal reverts persisted mode to none',
    engine.getPrefs().connectionMode,
    'none',
  );

  const afterOptimal = linesAfter.map(lineKey).sort();
  placeMarker(engine, [25.0, 48.3]);
  const afterPlacement = onlyLines(engine).map(lineKey).sort();
  invariantCheck(
    'placing a marker after optimal does not add auto-connections',
    afterPlacement,
    afterOptimal,
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 4b (regression): optimal REPLACES existing auto-gen lines, it does
// not stack on top of them. The screenshot bug was "sequence route visible,
// click optimal, now I see BOTH sets of lines at once". After the fix the
// prior sequence lines must be gone and only optimal legs remain. User-
// drawn lines (non-autoGen) stay untouched.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);
  invariantCheck('pre-optimal has sequence lines', onlyLines(engine).length, PTS.length - 1);

  // Inject a hand-drawn (NON auto-gen) line so we can verify optimal
  // doesn't nuke user content.
  engine._addFeature({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[23.0, 47.0], [23.5, 47.5]] },
    properties: { kind: 'line', color: '#c66809', weight: 3, opacity: 0.95 },
  });
  const userLinesBefore = engine.exportGeoJSON().features
    .filter((f) => f.properties?.kind === 'line' && !f.properties?.autoGen);

  engine.setConnectionMode('optimal');

  const after = engine.exportGeoJSON().features;
  const autoAfter = after.filter((f) => f.properties?.autoGen);
  const userAfter = after.filter((f) => f.properties?.kind === 'line' && !f.properties?.autoGen);

  invariantCheck('optimal produces exactly N-1 tour legs', autoAfter.length, PTS.length - 1);
  invariantCheck(
    'every remaining auto-gen line is autoMode=optimal (no stale sequence legs)',
    autoAfter.every((l) => l.properties.autoMode === 'optimal'),
    true,
  );
  invariantCheck(
    'hand-drawn lines survive the optimal recompute',
    userAfter.map((l) => l.geometry.coordinates),
    userLinesBefore.map((l) => l.geometry.coordinates),
  );

  // And one undo must restore the previous state exactly — the replace
  // + commit is a SINGLE history entry, not two.
  engine.undo();
  const restored = engine.exportGeoJSON().features.filter((f) => f.properties?.autoGen);
  invariantCheck(
    'undo after optimal restores prior sequence lines',
    restored.every((l) => l.properties.autoMode === 'sequence'),
    true,
  );
  invariantCheck('undo after optimal restores N-1 sequence lines', restored.length, PTS.length - 1);

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 5: changing connection mode never affects marker features.
// ---------------------------------------------------------------------------
{
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);
  const markersBefore = onlyMarkers(engine).map((m) => m.geometry.coordinates);

  for (const mode of ['hub', 'mesh', 'none', 'sequence']) {
    engine.setConnectionMode(mode);
  }

  const markersAfter = onlyMarkers(engine).map((m) => m.geometry.coordinates);
  invariantCheck('marker coords unchanged across mode flips', markersAfter, markersBefore);

  engine.dispose();
}

console.log(`Mode-switch invariance: ${invPass} passed, ${invFail} failed out of ${invPass + invFail}`);

const totalFailed = failed + invFail;
console.log(`\nOverall: ${passed + invPass} passed, ${totalFailed} failed`);
if (totalFailed > 0) {
  process.exit(1);
}
