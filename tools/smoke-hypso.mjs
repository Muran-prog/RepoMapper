#!/usr/bin/env node
/**
 * Headless smoke test for the hypsometric runtime.
 *
 * Verifies the core invariant from the brief:
 *
 *   "Смена ramp'а / strength — через setPaintProperty, без style rebuild
 *    (instant)."
 *
 * The test mocks just enough of the MapLibre surface to exercise
 * `runtime.js::applyHypsoRamp` / `applyHypsoStrength` end-to-end, then
 * asserts that:
 *
 *   1. Switching ramps fires `setPaintProperty(layerId, 'color-relief-color', expr)`
 *      and never `setStyle(...)`.
 *   2. The new expression is structurally different from the old one
 *      (i.e. the ramp colours actually changed).
 *   3. Toggling strength fires `setPaintProperty(layerId, 'color-relief-opacity', expr)`.
 *   4. Toggling bathymetry causes the ramp expression to drop or
 *      include negative-elevation stops accordingly.
 *   5. High-contrast toggle re-emits the ramp expression with a
 *      visibly different (LAB-pumped) set of colour values.
 *
 * No npm packages, no browser, no jsdom — pure Node + ESM imports.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  at least one assertion failed
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

async function importEsm(rel) {
  const abs = path.resolve(REPO, rel);
  return import(pathToFileURL(abs).href);
}

// ---------------------------------------------------------------------------
// Fake MapLibre map — covers the runtime's surface area exactly.
// Tracks every paint mutation so assertions can introspect them.
// ---------------------------------------------------------------------------

function createFakeMap(initialLayers) {
  const layersById = new Map(initialLayers.map((l) => [l.id, l]));
  const sources = {
    'terrain-dem': { type: 'raster-dem', tiles: ['x://{z}/{x}/{y}'] },
  };
  const events = [];

  const map = {
    _cart: {
      theme: 'light',
      caps: { prefersReducedMotion: false },
      userExaggerationMul: 1,
    },
    getStyle() {
      return {
        version: 8,
        sources: { ...sources },
        layers: [...layersById.values()],
      };
    },
    getLayer(id) {
      return layersById.get(id) ?? null;
    },
    getSource(id) {
      return sources[id] ?? null;
    },
    addSource(id, spec) {
      sources[id] = spec;
      events.push({ type: 'addSource', id, spec });
    },
    addLayer(layer, beforeId) {
      layersById.set(layer.id, layer);
      events.push({ type: 'addLayer', id: layer.id, layer, beforeId });
    },
    removeLayer(id) {
      layersById.delete(id);
      events.push({ type: 'removeLayer', id });
    },
    setPaintProperty(layerId, name, value) {
      const layer = layersById.get(layerId);
      if (!layer) throw new Error(`setPaintProperty on missing layer ${layerId}`);
      layer.paint = { ...layer.paint, [name]: value };
      events.push({ type: 'setPaintProperty', layerId, name, value });
    },
    setStyle() {
      events.push({ type: 'setStyle' });
      throw new Error(
        'FAIL — runtime invoked setStyle, breaking the "no style rebuild" guarantee',
      );
    },
    getContainer() {
      return { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
    },
    fire() {},
  };

  return { map, events };
}

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  // Set up `window` shim so runtime.js's CustomEvent dispatch doesn't crash.
  globalThis.window = globalThis.window ?? {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: function CE(type, init) {
      this.type = type;
      this.detail = init?.detail;
    },
  };
  if (!globalThis.CustomEvent) globalThis.CustomEvent = globalThis.window.CustomEvent;

  const {
    HYPSO_NATIVE_LAYER_ID,
    HYPSO_LAYER_META,
    composeHypsoLayers,
  } = await importEsm('src/style/hypso/layers.js');
  const { getRampStops, RAMP_IDS } = await importEsm('src/style/hypso/ramps.js');
  const {
    applyHypsoRamp,
    applyHypsoStrength,
    applyHypsoBathymetry,
    applyHypsoHighContrast,
    seedHypsoState,
  } = await importEsm('src/style/hypso/runtime.js');

  // Build a baseline native hypso layer like compose-time would.
  const initialStops = getRampStops('patterson', 'light');
  const initialLayer = composeHypsoLayers({
    mode: 'native',
    rampId: 'patterson',
    stops: initialStops,
    strength: 1,
    bathymetry: true,
  })[0];

  // Plus a hillshade layer so smart blending has something to mutate.
  const hillshadeLayer = {
    id: 'hillshade_primary',
    type: 'hillshade',
    source: 'terrain-dem',
    metadata: { 'cart:hillshadeBaseMul': 1 },
    paint: {
      'hillshade-shadow-color': '#000',
      'hillshade-highlight-color': '#fff',
      'hillshade-exaggeration': 0.3,
    },
  };

  const { map, events } = createFakeMap([initialLayer, hillshadeLayer]);
  seedHypsoState(map, {
    rampId: 'patterson',
    strength: 1,
    bathymetry: true,
    highContrast: false,
    theme: 'light',
    rasterUrls: {},
  });

  // -----------------------------------------------------------------
  // 1. Ramp switch → setPaintProperty('color-relief-color', …)
  // -----------------------------------------------------------------
  await check('ramp switch fires setPaintProperty on color-relief-color', () => {
    const before = events.length;
    const ok = applyHypsoRamp(map, 'swissAlpine', { dispatch: false });
    assert(ok, 'applyHypsoRamp returned false');
    const newEvents = events.slice(before);
    const setPaint = newEvents.filter(
      (e) => e.type === 'setPaintProperty' && e.name === 'color-relief-color',
    );
    assert(setPaint.length === 1, `expected 1 setPaintProperty, got ${setPaint.length}`);
    assert(setPaint[0].layerId === HYPSO_NATIVE_LAYER_ID, `wrong layer id: ${setPaint[0].layerId}`);
    assert(Array.isArray(setPaint[0].value) && setPaint[0].value[0] === 'interpolate',
      'expression is not an interpolate AST');
  });

  await check('no setStyle was invoked during ramp swap', () => {
    assert(!events.some((e) => e.type === 'setStyle'), 'setStyle was invoked');
  });

  await check('ramp swap actually changed the expression colours', () => {
    const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
    const expr = layer.paint['color-relief-color'];
    const oldExpr = ['interpolate', ['linear'], ['elevation'], ...initialStops.flat()];
    assert(!deepEq(expr, oldExpr), 'expression unchanged after ramp swap');
  });

  // -----------------------------------------------------------------
  // 2. Strength → setPaintProperty('color-relief-opacity', …)
  // -----------------------------------------------------------------
  await check('strength change fires setPaintProperty on color-relief-opacity', async () => {
    const { DEFAULT_STRENGTH_STOPS } = await importEsm('src/style/hypso/expression.js');
    const before = events.length;
    applyHypsoStrength(map, 0.5, { dispatch: false });
    const newEvents = events.slice(before);
    const setPaint = newEvents.filter(
      (e) => e.type === 'setPaintProperty' && e.name === 'color-relief-opacity',
    );
    assert(setPaint.length >= 1, 'no opacity setPaintProperty fired');
    const v = setPaint[0].value;
    assert(Array.isArray(v) && v[0] === 'interpolate', 'opacity value is not an interpolate expr');
    // Strength = 0.5 should produce stops at exactly 0.5× of every
    // DEFAULT_STRENGTH_STOPS value. We compare each emitted stop to its
    // baseline equivalent so the assertion doesn't drift when the
    // curve is re-tuned in expression.js.
    const stops = v.slice(3);
    const eps = 1e-3;
    for (let i = 0; i < DEFAULT_STRENGTH_STOPS.length; i++) {
      const [, baseV] = DEFAULT_STRENGTH_STOPS[i];
      const emitted = stops[i * 2 + 1];
      assert(
        Math.abs(emitted - baseV * 0.5) <= eps,
        `stop ${i}: expected ${baseV * 0.5}, got ${emitted}`,
      );
    }
  });

  await check('strength change rebalances hillshade exaggeration', () => {
    const before = events.length;
    applyHypsoStrength(map, 1.0, { dispatch: false });
    const newEvents = events.slice(before);
    const hsPaint = newEvents.find(
      (e) => e.type === 'setPaintProperty' && e.layerId === 'hillshade_primary' && e.name === 'hillshade-exaggeration',
    );
    assert(hsPaint, 'hillshade-exaggeration was not re-set during strength change');
  });

  // -----------------------------------------------------------------
  // 3. Bathymetry toggle removes / adds negative stops.
  // -----------------------------------------------------------------
  await check('bathymetry off drops negative-elevation stops', () => {
    const before = events.length;
    applyHypsoBathymetry(map, false);
    const newEvents = events.slice(before);
    const setPaint = newEvents.find(
      (e) => e.type === 'setPaintProperty' && e.name === 'color-relief-color',
    );
    assert(setPaint, 'no setPaintProperty fired for bathymetry toggle');
    const expr = setPaint.value;
    // expr = ['interpolate', ['linear'], ['elevation'], elev0, color0, elev1, color1, ...]
    for (let i = 3; i < expr.length; i += 2) {
      assert(expr[i] >= 0, `expr still contains negative elevation ${expr[i]}`);
    }
  });

  await check('bathymetry on re-includes negative-elevation stops', () => {
    const before = events.length;
    applyHypsoBathymetry(map, true);
    const setPaint = events
      .slice(before)
      .find((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-color');
    assert(setPaint, 'no setPaintProperty fired');
    const expr = setPaint.value;
    let hasNeg = false;
    for (let i = 3; i < expr.length; i += 2) {
      if (expr[i] < 0) { hasNeg = true; break; }
    }
    assert(hasNeg, 'no negative stops after re-enabling bathymetry');
  });

  // -----------------------------------------------------------------
  // 4. High-contrast → expression colours visibly shifted.
  // -----------------------------------------------------------------
  await check('high-contrast pumps lightness in the ramp expression', () => {
    const before = events.length;
    applyHypsoHighContrast(map, true);
    const setPaint = events
      .slice(before)
      .find((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-color');
    assert(setPaint, 'no setPaintProperty fired');

    // Compare the new expression's colour values to a baseline
    // expression we compute fresh from the ramp without contrast.
    const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
    const newExpr = layer.paint['color-relief-color'];

    // The expression carries (elev, hex) pairs after the head triple.
    // Pull every hex and confirm at least one differs from the
    // pre-boost baseline.
    const newColors = [];
    for (let i = 4; i < newExpr.length; i += 2) newColors.push(newExpr[i]);

    // Build a baseline expression with high-contrast OFF.
    applyHypsoHighContrast(map, false);
    const baseExpr = map.getLayer(HYPSO_NATIVE_LAYER_ID).paint['color-relief-color'];
    const baseColors = [];
    for (let i = 4; i < baseExpr.length; i += 2) baseColors.push(baseExpr[i]);

    let differing = 0;
    for (let i = 0; i < Math.min(newColors.length, baseColors.length); i++) {
      if (newColors[i] !== baseColors[i]) differing++;
    }
    assert(differing > 0, 'high-contrast did not change any colours');
  });

  // -----------------------------------------------------------------
  // 5. Sweep — every ramp id can be applied without throw.
  // -----------------------------------------------------------------
  await check(`every built-in ramp applies cleanly (${RAMP_IDS.length} ids)`, () => {
    for (const id of RAMP_IDS) {
      const ok = applyHypsoRamp(map, id, { dispatch: false });
      assert(ok, `applyHypsoRamp('${id}') returned false`);
    }
  });

  // -----------------------------------------------------------------
  // 6. Theme swap — re-emits the ramp expression in dark variant.
  // -----------------------------------------------------------------
  await check('theme swap routes through setPaintProperty (no setStyle)', async () => {
    const { applyHypsoTheme } = await importEsm('src/style/hypso/runtime.js');
    const before = events.length;
    applyHypsoTheme(map, 'dark');
    const set = events
      .slice(before)
      .find((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-color');
    assert(set, 'theme swap did not invoke setPaintProperty');
  });

  // -----------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  const w = Math.max(...results.map((r) => r.name.length), 4);
  console.log(pad('test', w), 'result');
  console.log('-'.repeat(w + 8));
  for (const r of results) {
    console.log(pad(r.name, w), r.ok ? 'OK' : `FAIL — ${r.err}`);
  }
  console.log();
  console.log(`Total: ${results.length}   Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-hypso.mjs crashed:', err);
  process.exit(2);
});
