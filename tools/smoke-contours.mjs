/**
 * Headless smoke test for the manual settlement-contour engine.
 *
 *   bun tools/smoke-contours.mjs
 *
 * The engine has no hard dependency on maplibre-gl (it only imports the
 * project's pure style/edit helpers), so we can drive it with a minimal
 * fake `map` + DOM globals and assert on the geometry / state it
 * produces. This exercises the real authoring state machine, ring
 * closure, node editing and localStorage persistence without a browser.
 */

// ---- Minimal DOM / storage globals ----------------------------------
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener() {},
  removeEventListener() {},
  confirm: () => true,
  alert() {},
};
globalThis.document = { documentElement: { dataset: { theme: 'dark' } } };

// ---- Fake map -------------------------------------------------------
function makeMap() {
  const sources = new Map();
  const layers = new Map();
  const handlers = new Map(); // "event" or "event::layer" -> Set
  const key = (ev, layer) => (layer ? `${ev}::${layer}` : ev);
  const canvas = { style: {} };
  return {
    _sources: sources,
    _layers: layers,
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, def) => sources.set(id, { ...def, setData(d) { this.data = d; } }),
    getLayer: (id) => layers.get(id),
    addLayer: (spec) => layers.set(spec.id, { ...spec }),
    setPaintProperty() {},
    getStyle: () => ({ layers: [{ id: 'place-label', type: 'symbol' }] }),
    getCanvas: () => canvas,
    project: ([lng, lat]) => ({ x: lng * 100, y: lat * 100 }),
    queryRenderedFeatures: () => [],
    doubleClickZoom: { isEnabled: () => true, enable() {}, disable() {} },
    dragPan: { enable() {}, disable() {} },
    fitBounds() {},
    on(ev, a, b) {
      const layer = typeof a === 'string' ? a : undefined;
      const cb = layer ? b : a;
      const k = key(ev, layer);
      if (!handlers.has(k)) handlers.set(k, new Set());
      handlers.get(k).add(cb);
    },
    off(ev, a, b) {
      const layer = typeof a === 'string' ? a : undefined;
      const cb = layer ? b : a;
      handlers.get(key(ev, layer))?.delete(cb);
    },
    once(ev, cb) { /* load/idle — not needed for the test */ },
    fire(ev, payload, layer) {
      const set = handlers.get(key(ev, layer));
      if (set) for (const cb of [...set]) cb(payload);
    },
  };
}

const ll = (lng, lat) => ({ lng, lat });
const pt = (x, y) => ({ x, y });
const evClick = (lng, lat) => ({ lngLat: ll(lng, lat), point: pt(lng * 100, lat * 100), originalEvent: {}, preventDefault() {} });

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const { kv } = await import('../src/state/account-store.js');
const { createSettlementContourEngine } = await import('../src/draw/settlement-contours.js');

// =====================================================================
// 1. Init + layer install
// =====================================================================
console.log('Init & layers:');
const map = makeMap();
const engine = createSettlementContourEngine(map);
check('persistent source installed', !!map.getSource('cart-settlement-contours'));
check('overlay source installed', !!map.getSource('cart-settlement-contours-overlay'));
check('4 outline layers installed', ['glow_outer', 'glow_inner', 'casing', 'inline'].every((s) => map.getLayer(`cart-contour-outline_${s}`)));
check('outline filter excludes hidden', JSON.stringify(map.getLayer('cart-contour-outline_inline').filter) === JSON.stringify(['!=', ['get', 'hidden'], true]));
check('handle layers installed', !!map.getLayer('cart-contour-vertex') && !!map.getLayer('cart-contour-vertex-mid'));
check('idempotent factory', createSettlementContourEngine(map) === engine);

// =====================================================================
// 2. Authoring a contour (mirror polyline: click, click, click, dblclick)
// =====================================================================
console.log('Authoring:');
let created = null;
engine.on('created', (e) => (created = e.id));
engine.startDrawing();
check('mode = draw', engine.getState().mode === 'draw');
// Click A, move, click B, move, click C, move, then finish (Enter)
map.fire('click', evClick(1, 1));        // start draft [A,A]
map.fire('mousemove', evClick(2, 1));    // rubber-band
map.fire('click', evClick(2, 1));        // promote B
map.fire('mousemove', evClick(2, 2));
map.fire('click', evClick(2, 2));        // promote C
map.fire('mousemove', evClick(1.5, 2.5));
check('draft point count = 3', engine.getState().draftPoints === 3);
map.fire('dblclick', evClick(1.5, 2.5)); // finish
check('contour created', !!created);
check('mode back to idle', engine.getState().mode === 'idle');
let list = engine.getContours();
check('one contour', list.length === 1);
const c0 = list[0];
check('3 distinct points', c0.pointCount === 3);
const ring = map.getSource('cart-settlement-contours').data.features[0].geometry.coordinates[0];
check('ring is closed (first == last)', ring.length === 4 && ring[0][0] === ring[3][0] && ring[0][1] === ring[3][1]);
check('polygon geometry type', map.getSource('cart-settlement-contours').data.features[0].geometry.type === 'Polygon');

// =====================================================================
// 3. Persistence round-trip
// =====================================================================
console.log('Persistence:');
await new Promise((r) => setTimeout(r, 400)); // let the debounced save flush
const raw = kv.getItem('cart:settlement-contours:v1');
check('persisted blob written', !!raw && JSON.parse(raw).features.length === 1);
const map2 = makeMap();
const engine2 = createSettlementContourEngine(map2);
check('restored on fresh engine', engine2.getContours().length === 1);
check('restored ring closed', map2.getSource('cart-settlement-contours').data.features[0].geometry.coordinates[0].length === 4);

// =====================================================================
// 4. Visibility toggle
// =====================================================================
console.log('Visibility:');
const id0 = c0.id;
engine.setVisibility(id0, false);
check('hidden flag set', engine.getContours()[0].hidden === true);
check('feature carries hidden=true', map.getSource('cart-settlement-contours').data.features[0].properties.hidden === true);
engine.setVisibility(id0, true);
check('shown again', engine.getContours()[0].hidden === false);

// =====================================================================
// 5. Editing — overlay handles, insert, move, delete floor
// =====================================================================
console.log('Editing:');
engine.startEditing(id0);
check('mode = edit', engine.getState().mode === 'edit');
const overlay = map.getSource('cart-settlement-contours-overlay').data.features;
const verts = overlay.filter((f) => f.properties.kind === 'contour-vertex');
const mids = overlay.filter((f) => f.properties.kind === 'contour-vertex-mid');
check('3 vertex handles', verts.length === 3);
check('3 midpoint handles', mids.length === 3);
check('handles use numeric ri/pi', verts.every((f) => typeof f.properties.ri === 'number' && typeof f.properties.pi === 'number'));

// Insert a vertex via a midpoint click. Patch queryRenderedFeatures to
// return the first midpoint handle for the vertex/mid layers.
const firstMid = mids[0];
map.queryRenderedFeatures = (point, opts) => {
  if (opts?.layers?.includes('cart-contour-vertex-mid')) return [firstMid];
  return [];
};
map.fire('click', { lngLat: ll(9, 9), point: pt(900, 900), preventDefault() {} });
check('insert added a 4th point', engine.getContours()[0].pointCount === 4);

// Move a vertex via drag. Return the first vertex handle on hit-test.
const vAfter = map.getSource('cart-settlement-contours-overlay').data.features.filter((f) => f.properties.kind === 'contour-vertex');
const dragHandle = vAfter[0];
map.queryRenderedFeatures = (point, opts) => {
  if (opts?.layers?.includes('cart-contour-vertex')) return [dragHandle];
  return [];
};
map.fire('mousedown', { point: pt(100, 100), originalEvent: { button: 0, altKey: false }, preventDefault() {} });
map.fire('mousemove', { lngLat: ll(5, 5), point: pt(500, 500) });
map.fire('mouseup', {});
const moved = engine.getContours()[0].coordinates;
check('a vertex moved to (5,5)', moved.some(([lng, lat]) => lng === 5 && lat === 5));

// Delete down to the triangle floor.
let floorHit = false;
engine.on('vertexFloor', () => (floorHit = true));
const delHandle = () => map.getSource('cart-settlement-contours-overlay').data.features.find((f) => f.properties.kind === 'contour-vertex');
const rightClickDelete = () => {
  const h = delHandle();
  map.queryRenderedFeatures = (point, opts) => (opts?.layers?.includes('cart-contour-vertex') ? [h] : []);
  map.fire('contextmenu', { point: pt(0, 0), preventDefault() {} });
};
rightClickDelete(); // 4 -> 3
check('deleted to 3 points', engine.getContours()[0].pointCount === 3);
rightClickDelete(); // 3 -> refuse
check('delete refused at floor of 3', engine.getContours()[0].pointCount === 3 && floorHit);

engine.stopEditing();
check('edit stopped', engine.getState().mode === 'idle');

// =====================================================================
// 6. Rename + delete + style-rebuild resilience
// =====================================================================
console.log('Misc:');
engine.renameContour(id0, 'Заросляк');
check('rename applied', engine.getContours()[0].name === 'Заросляк');

// Simulate a style rebuild: drop all runtime sources/layers, fire styledata.
map._sources.clear();
map._layers.clear();
map.fire('styledata', {});
check('layers reinstalled after style rebuild', !!map.getSource('cart-settlement-contours') && !!map.getLayer('cart-contour-outline_inline'));
check('contour data re-pushed', map.getSource('cart-settlement-contours').data.features.length === 1);

engine.deleteContour(id0);
check('contour deleted', engine.getContours().length === 0);
check('source emptied', map.getSource('cart-settlement-contours').data.features.length === 0);

console.log(`\nTotal failures: ${failures}`);
process.exit(failures ? 1 : 0);
