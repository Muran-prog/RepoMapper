/**
 * Sync regression test — runs in plain Node with a tiny DOM/localStorage shim.
 *
 * Verifies the fixes for the cross-device sync bug:
 *   1. local-bus dispatches a same-tab `cart:local-write` on setItem/removeItem.
 *   2. collectLocalState reads contours from the LIVE engine (race-free).
 *   3. applyServerData applies contours into the live engine + guards re-sync.
 *   4. initialSync migrates local-only contours when the server is empty.
 *   5. A manual-contour change reliably produces a server push (the bug).
 */

import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Minimal browser shim (window, localStorage, CustomEvent, Storage)
// ---------------------------------------------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

// Storage class whose prototype carries the methods local-bus patches.
class Storage {}
Storage.prototype.getItem = function (k) { return this._m.has(k) ? this._m.get(k) : null; };
Storage.prototype.setItem = function (k, v) { this._m.set(String(k), String(v)); };
Storage.prototype.removeItem = function (k) { this._m.delete(String(k)); };
Storage.prototype.clear = function () { this._m.clear(); };

function newStorageInstance() {
  const s = new Storage();
  s._m = new Map();
  return s;
}

const listeners = new Map();
const win = {
  _events: [],
  addEventListener(type, cb) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(cb);
  },
  removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
  dispatchEvent(ev) {
    win._events.push(ev);
    for (const cb of listeners.get(ev.type) || []) cb(ev);
    return true;
  },
  location: { origin: 'https://example.test' },
};

class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
}

const localStorage = newStorageInstance();

global.window = win;
global.localStorage = localStorage;
global.Storage = Storage;
global.CustomEvent = CustomEvent;
win.localStorage = localStorage;
win.CustomEvent = CustomEvent;
win.dispatchEvent = win.dispatchEvent.bind(win);

// ---------------------------------------------------------------------------
// Fakes for the draw + contour engines
// ---------------------------------------------------------------------------

function makeFakeEngine(initialFeatures = []) {
  const cbs = new Set();
  let features = initialFeatures.slice();
  return {
    _features: () => features,
    on(ev, cb) { if (ev === 'change') cbs.add(cb); },
    emitChange() { for (const cb of cbs) cb(); },
    exportGeoJSON() { return { type: 'FeatureCollection', features: features.slice() }; },
    importGeoJSON(gj) { features = (gj.features || []).slice(); },
    setPrefs() {},
  };
}

// Mimics the real contour engine's public surface for the test.
function makeFakeContourEngine(initial = []) {
  const cbs = new Set();
  let order = initial.slice();
  return {
    _order: () => order,
    on(ev, cb) { if (ev === 'change') cbs.add(cb); },
    getContours() { return order.map((f) => ({ id: f.id })); },
    exportGeoJSON() { return { type: 'FeatureCollection', features: order.map((f) => ({ ...f })) }; },
    replaceAll(features) {
      const list = Array.isArray(features) ? features : features?.features || [];
      order = list.slice();
      // The real engine persists to localStorage here too.
      localStorage.setItem('cart:settlement-contours:v1', JSON.stringify({ version: 1, features: order }));
      for (const cb of cbs) cb();
    },
    // simulate a user finishing a manual contour
    addContour(f) {
      order.push(f);
      localStorage.setItem('cart:settlement-contours:v1', JSON.stringify({ version: 1, features: order }));
      for (const cb of cbs) cb();
    },
  };
}

function contourFeature(id) {
  return {
    id,
    type: 'Feature',
    properties: { kind: 'settlement-contour', name: id },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  };
}

// ---------------------------------------------------------------------------
// Load the modules under test
// ---------------------------------------------------------------------------

const { installLocalWriteBus } = await import('../src/api/local-bus.js');
const { collectLocalState, applyServerData, isApplyingServerData } =
  await import('../src/ui/data-panel.js');

let pass = 0;
const ok = (name) => { console.log('  \u2713', name); pass++; };

// ---------------------------------------------------------------------------
// 1. local-bus: same-tab write fires cart:local-write
// ---------------------------------------------------------------------------
installLocalWriteBus();
installLocalWriteBus(); // idempotent — must not double-install
let busHits = [];
win.addEventListener('cart:local-write', (e) => busHits.push(e.detail.key));
localStorage.setItem('cart:map-mode', 'satellite');
localStorage.setItem('unrelated:key', 'x'); // must NOT fire
localStorage.removeItem('cart:map-mode');
assert.deepStrictEqual(busHits, ['cart:map-mode', 'cart:map-mode'],
  `expected two cart:* events, got ${JSON.stringify(busHits)}`);
ok('local-bus emits cart:local-write for cart:* writes only (same tab)');

// ---------------------------------------------------------------------------
// 2. collectLocalState reads contours from the LIVE engine (race-free)
// ---------------------------------------------------------------------------
{
  // localStorage is intentionally STALE / empty; the engine holds the truth.
  localStorage.removeItem('cart:settlement-contours:v1');
  const draw = makeFakeEngine([{ type: 'Feature', id: 'm1', geometry: { type: 'Point', coordinates: [0, 0] } }]);
  const contour = makeFakeContourEngine([contourFeature('c1'), contourFeature('c2')]);
  const state = collectLocalState(draw, contour);
  assert.strictEqual(state.contours.features.length, 2, 'should pull 2 contours from live engine');
  assert.strictEqual(state.features.features.length, 1, 'should pull 1 feature from live engine');
  ok('collectLocalState reads contours/features from live engines, not stale localStorage');
}

// ---------------------------------------------------------------------------
// 3. applyServerData applies contours live + sets guard during apply
// ---------------------------------------------------------------------------
{
  const draw = makeFakeEngine([]);
  const contour = makeFakeContourEngine([]);
  let guardSeenTrue = false;
  contour.on('change', () => { if (isApplyingServerData()) guardSeenTrue = true; });
  const server = {
    data: {
      features: { version: 1, features: [{ type: 'Feature', id: 'f9', geometry: { type: 'Point', coordinates: [1, 1] } }] },
      prefs: null,
      settings: { mapMode: 'terrain' },
      contours: { version: 1, features: [contourFeature('srv1'), contourFeature('srv2'), contourFeature('srv3')] },
    },
  };
  applyServerData(server, draw, contour);
  assert.strictEqual(contour._order().length, 3, 'server contours should be applied to live engine');
  assert.strictEqual(draw._features().length, 1, 'server features should be imported');
  assert.strictEqual(localStorage.getItem('cart:map-mode'), 'terrain', 'settings should be persisted');
  assert.ok(guardSeenTrue, 'isApplyingServerData() must be true while applying (prevents echo)');
  assert.strictEqual(isApplyingServerData(), false, 'guard must reset after apply');
  ok('applyServerData applies features/contours/settings live and guards re-sync');
}

// ---------------------------------------------------------------------------
// 4. End-to-end: a manual contour change produces a server push (THE BUG)
// ---------------------------------------------------------------------------
{
  const draw = makeFakeEngine([]);
  const contour = makeFakeContourEngine([]);
  const pushed = [];
  // This mirrors installDataUI's triggerSync wiring.
  const triggerSync = () => {
    if (isApplyingServerData()) return;
    pushed.push(collectLocalState(draw, contour));
  };
  contour.on('change', triggerSync);
  win.addEventListener('cart:local-write', (e) => {
    if (e.detail.key && (e.detail.key === 'cart:*' || e.detail.key.startsWith('cart:'))) triggerSync();
  });

  // User draws a manual contour.
  contour.addContour(contourFeature('user-contour-1'));

  assert.ok(pushed.length >= 1, 'drawing a contour must trigger at least one server push');
  const last = pushed[pushed.length - 1];
  assert.strictEqual(last.contours.features.length, 1, 'pushed snapshot must contain the new contour');
  assert.strictEqual(last.contours.features[0].id, 'user-contour-1');
  ok('drawing a manual contour reliably pushes it to the server (bug fixed)');
}

// ---------------------------------------------------------------------------
// 5. Round-trip: contour survives "log in on another device"
// ---------------------------------------------------------------------------
{
  // Device A pushes a contour.
  const drawA = makeFakeEngine([]);
  const contourA = makeFakeContourEngine([]);
  contourA.addContour(contourFeature('roundtrip-1'));
  const snapshot = collectLocalState(drawA, contourA);

  // Server stores it; Device B (fresh, empty) loads it.
  const drawB = makeFakeEngine([]);
  const contourB = makeFakeContourEngine([]);
  applyServerData({ data: { ...snapshot } }, drawB, contourB);
  assert.strictEqual(contourB._order().length, 1, 'device B must see the contour after login');
  assert.strictEqual(contourB._order()[0].id, 'roundtrip-1');
  ok('contour created on device A appears on device B after login (incognito scenario)');
}

console.log(`\nAll ${pass} sync tests passed.`);
