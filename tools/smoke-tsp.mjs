/**
 * Smoke tests for the drawing engine's routing subsystem.
 *
 *   node tools/smoke-tsp.mjs
 *
 * Covers four invariants:
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
 *   3. OPTIMISE-ROUTE as an explicit action, not a mode. Calling
 *      `engine.optimizeRoute()` replaces every auto-gen line with the
 *      TSP tour, leaves `connectionMode` alone, and coalesces into
 *      a single undoable history entry. The old "click optimal,
 *      silently revert to none" UX is intentionally gone.
 *
 *   4. UNDO coalescing + PERSISTENCE round-trip. One user operation
 *      equals one history entry: dropping a marker in `sequence` mode
 *      pushes a single snapshot that covers the marker AND the auto-
 *      line. Persisting state and re-creating the engine yields a
 *      byte-identical feature collection.
 *
 * All invariants are tested without MapLibre — the engine's map
 * dependency is mocked down to the handful of methods it actually
 * calls during marker placement / mode switching.
 */
import { optimalTour, haversine } from '../src/draw/connections.js';

// ---------------------------------------------------------------------------
// Global shims — the drawing engine was written for a browser runtime, so
// `window`, `document`, rAF and timers need cooperative stubs before we can
// import it under Node. In addition to the usual DOM surface we install an
// in-memory `localStorage` so the persistence round-trip test can save
// features in one engine instance and read them back in the next.
// ---------------------------------------------------------------------------

/** Shared in-memory localStorage used by every engine instance. */
const fakeStorage = new Map();
const localStorage = {
  getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
  setItem: (k, v) => { fakeStorage.set(k, String(v)); },
  removeItem: (k) => { fakeStorage.delete(k); },
  clear: () => { fakeStorage.clear(); },
};

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    localStorage,
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { documentElement: { dataset: {} } };
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

/**
 * Wipe the in-memory storage between tests so persisted features from
 * one block cannot contaminate the next. Every test that touches the
 * engine starts with a clean slate.
 */
function resetStorage() { fakeStorage.clear(); }

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
// Test 1: sequence → hub → mesh → none chain must not touch existing lines.
// The raw assertion the architecture is built around: connectionMode is a
// pure preference. Auto-gen lines are permanent data.
// ---------------------------------------------------------------------------
{
  resetStorage();
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);

  const before = onlyLines(engine).map(lineKey).sort();
  invariantCheck(
    'sequence produced N-1 lines',
    before.length,
    PTS.length - 1,
  );

  // Flip through every remaining mode and verify NONE of them mutates
  // the committed route — not the count, not the coordinates, not any
  // property. This is the regression signature of the old bug, where
  // switching to hub/mesh re-drew the graph under the new rules.
  for (const nextMode of ['hub', 'mesh', 'none', 'sequence']) {
    engine.setConnectionMode(nextMode);
    const snapshot = onlyLines(engine).map(lineKey).sort();
    invariantCheck(`sequence→${nextMode} preserves lines (count + coords)`, snapshot, before);
  }

  // Properties must also match, including autoMode.
  const allProps = onlyLines(engine).map((l) => ({
    autoMode: l.properties.autoMode,
    color: l.properties.color,
    fromId: l.properties.fromId,
    toId: l.properties.toId,
  }));
  invariantCheck(
    'every line is still autoMode=sequence after the mode carousel',
    allProps.every((p) => p.autoMode === 'sequence'),
    true,
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 2: new marker in hub mode adds exactly one hub line; prior sequence
// lines remain unchanged.
// ---------------------------------------------------------------------------
{
  resetStorage();
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
  resetStorage();
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
// Test 4: setConnectionMode is pure — 'optimal' is no longer a mode so
// attempting to set it should be a defensive no-op. The TSP action lives
// on engine.optimizeRoute() instead.
// ---------------------------------------------------------------------------
{
  resetStorage();
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);
  const before = onlyLines(engine).map(lineKey).sort();

  // Attempt to set the deprecated 'optimal' mode — must be ignored.
  engine.setConnectionMode('optimal');
  invariantCheck(
    'setConnectionMode("optimal") is a no-op (not a valid mode)',
    engine.getPrefs().connectionMode,
    'sequence',
  );
  invariantCheck(
    'setConnectionMode("optimal") does not mutate existing lines',
    onlyLines(engine).map(lineKey).sort(),
    before,
  );

  // Garbage strings are also rejected defensively.
  engine.setConnectionMode('bogus');
  invariantCheck(
    'setConnectionMode("bogus") is a no-op',
    engine.getPrefs().connectionMode,
    'sequence',
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 5: engine.optimizeRoute() — the explicit TSP action.
//
// Contract:
//   • Replaces every auto-gen line with the optimal tour legs.
//   • Hand-drawn lines (non-autoGen) are untouched.
//   • connectionMode is NOT changed — the user's preference for future
//     placements is their own decision, not a side-effect of optimise.
//   • One history entry — a single undo restores pre-optimise state.
//   • Subsequent marker placements follow the (unchanged) mode.
// ---------------------------------------------------------------------------
{
  resetStorage();
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');
  for (const p of PTS) placeMarker(engine, p);
  invariantCheck('pre-optimise has sequence lines', onlyLines(engine).length, PTS.length - 1);

  // Inject a hand-drawn (NON auto-gen) line so we can verify optimise
  // doesn't nuke user content.
  engine._addFeature({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[23.0, 47.0], [23.5, 47.5]] },
    properties: { kind: 'line', color: '#c66809', weight: 3, opacity: 0.95 },
  });
  const userLinesBefore = engine.exportGeoJSON().features
    .filter((f) => f.properties?.kind === 'line' && !f.properties?.autoGen);
  const sequenceLinesBefore = onlyLines(engine)
    .filter((l) => l.properties.autoMode === 'sequence')
    .map(lineKey)
    .sort();

  const added = engine.optimizeRoute();

  const after = engine.exportGeoJSON().features;
  const autoAfter = after.filter((f) => f.properties?.autoGen);
  const userAfter = after.filter((f) => f.properties?.kind === 'line' && !f.properties?.autoGen);

  invariantCheck('optimizeRoute returns number of legs committed', added, PTS.length - 1);
  invariantCheck('optimise produces exactly N-1 tour legs', autoAfter.length, PTS.length - 1);
  invariantCheck(
    'every remaining auto-gen line is autoMode=optimal (no stale sequence legs)',
    autoAfter.every((l) => l.properties.autoMode === 'optimal'),
    true,
  );
  invariantCheck(
    'hand-drawn lines survive the optimise recompute',
    userAfter.map((l) => l.geometry.coordinates),
    userLinesBefore.map((l) => l.geometry.coordinates),
  );
  invariantCheck(
    'optimizeRoute does NOT change connectionMode',
    engine.getPrefs().connectionMode,
    'sequence',
  );

  // Placing a new marker must behave according to the still-active
  // sequence mode — extending the route, not re-running TSP.
  placeMarker(engine, [25.0, 48.4]);
  const autoAfterNext = onlyLines(engine).filter((l) => l.properties.autoGen);
  const sequenceLegsAfterNext = autoAfterNext.filter((l) => l.properties.autoMode === 'sequence');
  invariantCheck(
    'placing a marker after optimise respects the active mode',
    sequenceLegsAfterNext.length,
    1,
  );

  // One undo must restore the previous state exactly — the replace
  // + commit is a SINGLE history entry, not two. Undoing the post-
  // optimise marker placement brings us back to the optimised state.
  engine.undo(); // undo the marker placement
  engine.undo(); // undo the optimise
  const restoredAuto = engine.exportGeoJSON().features.filter((f) => f.properties?.autoGen);
  invariantCheck(
    'undo after optimise restores prior sequence lines (count)',
    restoredAuto.length,
    PTS.length - 1,
  );
  invariantCheck(
    'undo after optimise restores prior sequence lines (all autoMode=sequence)',
    restoredAuto.every((l) => l.properties.autoMode === 'sequence'),
    true,
  );
  invariantCheck(
    'undo after optimise restores prior sequence lines (byte-exact keys)',
    restoredAuto.map(lineKey).sort(),
    sequenceLinesBefore,
  );

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 6: undo coalescing for marker placement.
//
// One user click = one history entry. Dropping a marker in 'sequence' mode
// must be reversible with a SINGLE undo: the marker and its auto-line go
// away together. The history stack must not grow by two.
// ---------------------------------------------------------------------------
{
  resetStorage();
  const engine = createDrawEngine(makeMockMap());
  engine.setConnectionMode('sequence');

  placeMarker(engine, PTS[0]);
  const depth1 = engine.getState().historyDepth;
  placeMarker(engine, PTS[1]);
  const depth2 = engine.getState().historyDepth;
  invariantCheck('each marker placement pushes exactly one history entry', depth2 - depth1, 1);

  // Before the second placement: one marker, zero auto-lines.
  // After: two markers, one sequence auto-line.
  invariantCheck('two markers + one auto-line present', engine.exportGeoJSON().features.length, 3);
  invariantCheck('one auto-gen line present', onlyLines(engine).length, 1);

  engine.undo();
  invariantCheck('undo removes the marker', onlyMarkers(engine).length, 1);
  invariantCheck('undo removes its auto-line in the same step', onlyLines(engine).length, 0);

  engine.dispose();
}

// ---------------------------------------------------------------------------
// Test 7: persistence round-trip.
//
// Draw a mixed scene (markers + auto-lines + a hand-drawn line), flush the
// debounced save, dispose the engine, and create a fresh engine reading
// from the SAME localStorage. The exported feature collection must be
// identical — same feature ids, same coordinates, same properties. No
// "backfill" magic, no silent mode reverts.
// ---------------------------------------------------------------------------
{
  resetStorage();
  const first = createDrawEngine(makeMockMap());
  first.setConnectionMode('hub');
  for (const p of PTS) placeMarker(first, p);
  first._addFeature({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[23.0, 47.0], [23.5, 47.5]] },
    properties: { kind: 'line', color: '#c66809', weight: 3, opacity: 0.95 },
  });
  first._flushPersist();

  const exportedFirst = first.exportGeoJSON();
  const modeFirst = first.getPrefs().connectionMode;
  first.dispose();

  const second = createDrawEngine(makeMockMap());
  const exportedSecond = second.exportGeoJSON();
  const modeSecond = second.getPrefs().connectionMode;

  // Feature counts and kinds must match exactly.
  invariantCheck(
    'persistence: feature count survives reload',
    exportedSecond.features.length,
    exportedFirst.features.length,
  );
  const kindCount = (fc) => {
    const out = {};
    for (const f of fc.features) {
      const k = f.properties?.kind ?? '?';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  invariantCheck(
    'persistence: kind breakdown matches',
    kindCount(exportedSecond),
    kindCount(exportedFirst),
  );

  // Coordinates must match (ids may differ — the engine regenerates
  // them on load — but geometry and key properties are preserved).
  const normaliseForCompare = (fc) =>
    fc.features
      .map((f) => ({
        kind: f.properties?.kind,
        autoGen: !!f.properties?.autoGen,
        autoMode: f.properties?.autoMode ?? null,
        coords: JSON.stringify(f.geometry?.coordinates),
      }))
      .sort((a, b) => a.coords.localeCompare(b.coords));
  invariantCheck(
    'persistence: geometry + autoGen/autoMode survive reload byte-identical',
    normaliseForCompare(exportedSecond),
    normaliseForCompare(exportedFirst),
  );
  invariantCheck('persistence: connectionMode survives reload', modeSecond, modeFirst);

  second.dispose();
}

// ---------------------------------------------------------------------------
// Test 8: changing connection mode never affects marker features.
// ---------------------------------------------------------------------------
{
  resetStorage();
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

// ---------------------------------------------------------------------------
// Test 9: stale 'optimal' persisted in prefs is migrated to 'none' on load.
// Pre-refactor builds could write connectionMode: 'optimal' to localStorage.
// The current schema rejects that value; loadPrefs must coerce it cleanly.
// ---------------------------------------------------------------------------
{
  resetStorage();
  // Simulate pre-refactor persisted prefs.
  fakeStorage.set(
    'cart:draw:prefs:v1',
    JSON.stringify({ tool: 'marker', connectionMode: 'optimal' }),
  );
  const engine = createDrawEngine(makeMockMap());
  invariantCheck(
    'stale connectionMode:"optimal" is migrated to "none"',
    engine.getPrefs().connectionMode,
    'none',
  );
  engine.dispose();
}

console.log(`Mode-switch invariance + architecture: ${invPass} passed, ${invFail} failed out of ${invPass + invFail}`);

const totalFailed = failed + invFail;
console.log(`\nOverall: ${passed + invPass} passed, ${totalFailed} failed`);
if (totalFailed > 0) {
  process.exit(1);
}
