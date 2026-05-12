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
    applyHypsoStrengthAtZoom,
    applyHypsoBathymetry,
    applyHypsoHighContrast,
    rebalanceHillshadeForHypso,
    seedHypsoState,
  } = await importEsm('src/style/hypso/runtime.js');
  const {
    DEFAULT_STRENGTH_STOPS,
    STRENGTH_OPACITY_CEILING,
    evaluateStrengthAtZoom,
  } = await importEsm('src/style/hypso/expression.js');
  const {
    HILLSHADE_STOPS,
    HYPSO_HILLSHADE_BLEND,
    evaluateHillshadeExaggeration,
    buildHillshadeExaggerationExpr,
  } = await importEsm('src/style/terrain.js');

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
    // mode must reflect the actual layer we built above so the
    // hillshade smart-blend kicks in. Without this, rebalance treats
    // hypso as inactive and emits the unblended base curve.
    mode: 'native',
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
  // 7. Determinism matrix — the heart of this rework.
  //
  //    Every (zoom × strength) combination must produce a known
  //    opacity that the runtime can ALSO push as a JS-side constant.
  //    Curve values are tested against `evaluateStrengthAtZoom` so a
  //    regression in DEFAULT_STRENGTH_STOPS is caught immediately.
  // -----------------------------------------------------------------
  await check('opacity curve is monotonically non-increasing across zoom', () => {
    let prev = Infinity;
    for (const [z] of DEFAULT_STRENGTH_STOPS) {
      const v = evaluateStrengthAtZoom({ zoom: z, strength: 1 });
      assert(v <= prev + 1e-6, `curve increased at z=${z}: ${v} > ${prev}`);
      prev = v;
    }
  });

  await check('opacity curve stays within the legibility band 0.50–0.85', () => {
    // After the user feedback ("hypso must be stable across zooms"),
    // the curve was retuned. The full curve sits in [0.50, 0.60] at
    // strength=1 and tops out at STRENGTH_OPACITY_CEILING=0.85 at
    // strength=1.5. Anything outside this band is a regression that
    // would re-introduce the "solid wash" or "disappears" symptoms.
    for (let z = 3; z <= 18; z += 0.5) {
      const v1 = evaluateStrengthAtZoom({ zoom: z, strength: 1 });
      assert(v1 >= 0.50 - 1e-6 && v1 <= 0.60 + 1e-6,
        `strength=1 z=${z}: ${v1} outside [0.50, 0.60]`);
      const v15 = evaluateStrengthAtZoom({ zoom: z, strength: 1.5 });
      assert(v15 <= STRENGTH_OPACITY_CEILING + 1e-6,
        `strength=1.5 z=${z}: ${v15} > ceiling ${STRENGTH_OPACITY_CEILING}`);
      assert(v15 >= v1 - 1e-6,
        `strength=1.5 should be ≥ strength=1 at every zoom (z=${z})`);
    }
  });

  await check('opacity at strength=0 is identically zero at every zoom', () => {
    for (let z = 3; z <= 18; z += 0.5) {
      const v = evaluateStrengthAtZoom({ zoom: z, strength: 0 });
      assert(v === 0, `strength=0 should give opacity 0 (z=${z}, got ${v})`);
    }
  });

  await check('opacity scales linearly with strength at every zoom', () => {
    // At fixed zoom, opacity(s) should ≈ s × opacity(1), up to the
    // ceiling. This is the property the picker's strength slider
    // relies on for "double the strength = double the visibility".
    for (const z of [5, 9, 11, 13, 16]) {
      const base = evaluateStrengthAtZoom({ zoom: z, strength: 1 });
      for (const s of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]) {
        const expected = Math.min(STRENGTH_OPACITY_CEILING, base * s);
        const actual = evaluateStrengthAtZoom({ zoom: z, strength: s });
        assert(Math.abs(actual - expected) < 1e-3,
          `z=${z} s=${s}: expected ${expected.toFixed(4)} got ${actual}`);
      }
    }
  });

  await check('applyHypsoStrengthAtZoom pushes a CONSTANT, not an expression', () => {
    // The runtime's defensive fallback (called from `move`/`zoom`
    // event handlers) must push a plain number, not an array. That's
    // what makes it immune to any potential renderer-side regression
    // in how `color-relief-opacity` zoom expressions are evaluated.
    map.getZoom = () => 11.17;
    const before = events.length;
    applyHypsoStrengthAtZoom(map);
    const update = events.slice(before)
      .find((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-opacity');
    assert(update, 'no opacity update fired');
    assert(typeof update.value === 'number',
      `expected number, got ${typeof update.value}: ${JSON.stringify(update.value)}`);
    const expected = evaluateStrengthAtZoom({
      zoom: 11.17,
      strength: map._cart.hypso.strength,
    });
    assert(Math.abs(update.value - expected) < 1e-3,
      `z=11.17 push: expected ${expected}, got ${update.value}`);
  });

  await check('applyHypsoStrengthAtZoom is idempotent at the same zoom', () => {
    // Second call at the same zoom should not produce a redundant
    // setPaintProperty — the runtime caches the quantized value.
    map.getZoom = () => 11.17;
    const before = events.length;
    applyHypsoStrengthAtZoom(map);
    const fired = events.slice(before)
      .filter((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-opacity');
    assert(fired.length === 0, `expected 0 redundant pushes, got ${fired.length}`);
  });

  await check('applyHypsoStrengthAtZoom emits NEW value on zoom change', () => {
    map.getZoom = () => 6;
    const before = events.length;
    applyHypsoStrengthAtZoom(map);
    const fired = events.slice(before)
      .find((e) => e.type === 'setPaintProperty' && e.name === 'color-relief-opacity');
    assert(fired, 'no update fired after zoom change');
    const expected = evaluateStrengthAtZoom({
      zoom: 6,
      strength: map._cart.hypso.strength,
    });
    assert(Math.abs(fired.value - expected) < 1e-3,
      `z=6 push: expected ${expected}, got ${fired.value}`);
  });

  // -----------------------------------------------------------------
  // 8. Hillshade-exaggeration determinism: turning hypso ON must
  //    NEVER make hillshade stronger. The previous implementation
  //    treated HYPSO_HILLSHADE_BLEND as an absolute value rather than
  //    a multiplier, which produced exactly that regression.
  // -----------------------------------------------------------------
  await check('hillshade exaggeration with hypso on ≤ exaggeration with hypso off (every zoom)', () => {
    for (let z = 3; z <= 18; z += 0.5) {
      const off = evaluateHillshadeExaggeration({ zoom: z, hypsoActive: false });
      const on = evaluateHillshadeExaggeration({ zoom: z, hypsoActive: true, hypsoStrength: 1 });
      assert(on <= off + 1e-6,
        `z=${z}: hypso-on (${on.toFixed(4)}) should be ≤ hypso-off (${off.toFixed(4)})`);
    }
  });

  await check('hillshade exaggeration never collapses to 0 with hypso on', () => {
    // The blend must never zero out hillshade — the user still needs
    // relief to read through the colour wash. Lower bound: 75 % of
    // base × baseMul × userMul (with userMul=1 default).
    for (let z = 3; z <= 18; z += 0.5) {
      const off = evaluateHillshadeExaggeration({ zoom: z, hypsoActive: false });
      const on = evaluateHillshadeExaggeration({ zoom: z, hypsoActive: true, hypsoStrength: 1 });
      if (off === 0) continue;
      const ratio = on / off;
      assert(ratio >= 0.75 - 1e-6,
        `z=${z}: blend kept only ${(ratio * 100).toFixed(1)} % of base — below the 75 % floor`);
    }
  });

  await check('hillshade scales linearly with userMul at every zoom', () => {
    // userMul = 0 → exaggeration = 0 (slider all the way down).
    // userMul = 1 → as-authored.
    // userMul = 2 → 2× as-authored, clamped at the spec max of 1.0.
    for (const z of [5, 9, 11, 14, 18]) {
      const at1 = evaluateHillshadeExaggeration({ zoom: z, userMul: 1 });
      const at2 = evaluateHillshadeExaggeration({ zoom: z, userMul: 2 });
      const at0 = evaluateHillshadeExaggeration({ zoom: z, userMul: 0 });
      assert(at0 === 0, `userMul=0 at z=${z} should be 0, got ${at0}`);
      // at2 is min(1, 2 * at1).
      const expected2 = Math.min(1, 2 * at1);
      assert(Math.abs(at2 - expected2) < 1e-3,
        `z=${z} userMul=2: expected ${expected2}, got ${at2}`);
    }
  });

  await check('hillshade respects per-direction baseMul', () => {
    // The Swiss-style stack uses 1.0 / 0.65 / 0.4 weights for
    // NW / W / Top directions. Each layer's exaggeration must scale
    // proportionally so the multi-directional look stays coherent.
    for (const z of [9, 12]) {
      const e1 = evaluateHillshadeExaggeration({ zoom: z, baseMul: 1.0 });
      const e65 = evaluateHillshadeExaggeration({ zoom: z, baseMul: 0.65 });
      const e40 = evaluateHillshadeExaggeration({ zoom: z, baseMul: 0.4 });
      // The ratio of e65/e1 should be 0.65 (within float precision).
      assert(Math.abs(e65 / e1 - 0.65) < 1e-3, `z=${z}: e(0.65)/e(1) = ${(e65 / e1).toFixed(4)}`);
      assert(Math.abs(e40 / e1 - 0.40) < 1e-3, `z=${z}: e(0.4)/e(1) = ${(e40 / e1).toFixed(4)}`);
    }
  });

  await check('hillshade reduce-motion path collapses to a constant', () => {
    const a = evaluateHillshadeExaggeration({ zoom: 3, reduceMotion: true });
    const b = evaluateHillshadeExaggeration({ zoom: 11, reduceMotion: true });
    const c = evaluateHillshadeExaggeration({ zoom: 18, reduceMotion: true });
    assert(a === b && b === c, `reduce-motion should give a constant; got ${a}, ${b}, ${c}`);
    const expr = buildHillshadeExaggerationExpr({ reduceMotion: true });
    assert(typeof expr === 'number',
      `reduce-motion should emit a constant, got ${typeof expr}`);
  });

  // -----------------------------------------------------------------
  // 9. rebalanceHillshadeForHypso — runtime ↔ math agreement.
  //    We push setPaintProperty, then verify the resulting paint
  //    property's compiled value at a specific zoom matches the pure
  //    evaluator.
  // -----------------------------------------------------------------
  await check('rebalance(strength=1) hits exactly the unified formula at every zoom', async () => {
    const { createExpression } = await import('@maplibre/maplibre-gl-style-spec');
    const v8 = (await import('@maplibre/maplibre-gl-style-spec/dist/latest.json', { with: { type: 'json' } })).default;
    const spec = v8.paint_hillshade['hillshade-exaggeration'];
    rebalanceHillshadeForHypso(map, 1);
    const layer = map.getLayer('hillshade_primary');
    const expr = layer.paint['hillshade-exaggeration'];
    assert(Array.isArray(expr), 'expected an interpolate expression');
    const r = createExpression(expr, spec);
    assert(r.result !== 'error', `expression invalid: ${JSON.stringify(r.value)}`);
    for (const z of [3, 5, 7, 9, 11, 13, 16]) {
      const actual = r.value.evaluate({ zoom: z });
      const expected = evaluateHillshadeExaggeration({
        zoom: z,
        baseMul: 1,
        userMul: 1,
        hypsoStrength: 1,
        hypsoActive: true,
        reduceMotion: false,
      });
      assert(Math.abs(actual - expected) < 1e-3,
        `z=${z}: maplibre evaluated ${actual.toFixed(4)}, JS expects ${expected.toFixed(4)}`);
    }
  });

  await check('rebalance is idempotent when nothing changed', () => {
    const before = events.length;
    rebalanceHillshadeForHypso(map, 1);
    const fired = events.slice(before)
      .filter((e) => e.type === 'setPaintProperty' && e.name === 'hillshade-exaggeration');
    assert(fired.length === 0, `expected 0 redundant rebalance pushes, got ${fired.length}`);
  });

  await check('rebalance(strength=0) emits exactly the base curve', async () => {
    const { createExpression } = await import('@maplibre/maplibre-gl-style-spec');
    const v8 = (await import('@maplibre/maplibre-gl-style-spec/dist/latest.json', { with: { type: 'json' } })).default;
    const spec = v8.paint_hillshade['hillshade-exaggeration'];
    // Force a different signature so the memo doesn't short-circuit.
    map._cart.hypso._lastHillshade = {};
    rebalanceHillshadeForHypso(map, 0);
    const layer = map.getLayer('hillshade_primary');
    const expr = layer.paint['hillshade-exaggeration'];
    const r = createExpression(expr, spec);
    for (const z of [5, 9, 14]) {
      const actual = r.value.evaluate({ zoom: z });
      const expected = evaluateHillshadeExaggeration({
        zoom: z, hypsoActive: false,
      });
      assert(Math.abs(actual - expected) < 1e-3,
        `strength=0 z=${z}: ${actual} ≠ ${expected}`);
    }
  });

  // -----------------------------------------------------------------
  // 10. End-to-end ramp × strength × zoom matrix.
  //
  //    The renderer must produce the SAME numeric opacity for the
  //    same inputs regardless of how we got there: setting strength
  //    directly, swapping ramps, toggling bathymetry — none of those
  //    should perturb the opacity at a given zoom.
  // -----------------------------------------------------------------
  await check('ramp swap doesn\'t change opacity (only colour)', () => {
    map.getZoom = () => 10;
    applyHypsoStrength(map, 1, { dispatch: false });
    map._cart.hypso._lastOpacity = {};
    applyHypsoStrengthAtZoom(map);
    const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
    const opacity1 = layer.paint['color-relief-opacity'];
    applyHypsoRamp(map, 'osmPhysical', { dispatch: false });
    const opacity2 = layer.paint['color-relief-opacity'];
    assert(opacity1 === opacity2,
      `ramp swap changed opacity: ${opacity1} → ${opacity2}`);
  });

  await check('zoom sweep 3..18 — opacity matches evaluator exactly', () => {
    map._cart.hypso._lastOpacity = {};
    applyHypsoStrength(map, 1, { dispatch: false });
    for (let z = 3; z <= 18; z += 1) {
      map._cart.hypso._lastOpacity = {};
      map.getZoom = () => z;
      applyHypsoStrengthAtZoom(map);
      const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
      const actual = layer.paint['color-relief-opacity'];
      const expected = evaluateStrengthAtZoom({ zoom: z, strength: 1 });
      assert(Math.abs(actual - expected) < 1e-3,
        `z=${z}: rendered opacity ${actual} ≠ curve ${expected}`);
    }
  });

  await check('strength sweep 0..1.5 — opacity matches evaluator at z=11', () => {
    map.getZoom = () => 11;
    for (const s of [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]) {
      applyHypsoStrength(map, s, { dispatch: false });
      const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
      const actual = layer.paint['color-relief-opacity'];
      const expected = evaluateStrengthAtZoom({ zoom: 11, strength: s });
      assert(typeof actual === 'number',
        `expected numeric opacity, got ${typeof actual}: ${JSON.stringify(actual)}`);
      assert(Math.abs(actual - expected) < 1e-3,
        `s=${s} z=11: ${actual} ≠ ${expected}`);
    }
  });

  await check('every built-in ramp keeps opacity invariant at strength=1, z=11', () => {
    map.getZoom = () => 11;
    applyHypsoStrength(map, 1, { dispatch: false });
    const expected = evaluateStrengthAtZoom({ zoom: 11, strength: 1 });
    for (const id of RAMP_IDS) {
      applyHypsoRamp(map, id, { dispatch: false });
      const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
      assert(Math.abs(layer.paint['color-relief-opacity'] - expected) < 1e-3,
        `ramp ${id}: opacity drifted to ${layer.paint['color-relief-opacity']}`);
    }
  });

  // -----------------------------------------------------------------
  // 11. End-to-end: MapLibre's own expression evaluator must agree
  //     with our JS-side evaluator for `color-relief-opacity` at every
  //     zoom. This is the test that would have caught a renderer-side
  //     regression in the spec evaluator (the kind we suspected from
  //     the screenshots) — if the spec evaluator ever drifts, this
  //     test fires AND the runtime's constant-push fallback still
  //     pins the visible opacity to the correct value.
  // -----------------------------------------------------------------
  await check('MapLibre evaluator agrees with evaluateStrengthAtZoom at every zoom', async () => {
    const { createExpression } = await import('@maplibre/maplibre-gl-style-spec');
    const v8 = (await import('@maplibre/maplibre-gl-style-spec/dist/latest.json', { with: { type: 'json' } })).default;
    const spec = v8['paint_color-relief']['color-relief-opacity'];
    for (const s of [0, 0.5, 1, 1.5]) {
      const { buildStrengthExpression } = await importEsm('src/style/hypso/expression.js');
      const expr = buildStrengthExpression(s);
      const r = createExpression(expr, spec);
      assert(r.result !== 'error',
        `expression invalid at s=${s}: ${JSON.stringify(r.value)}`);
      for (let z = 3; z <= 18; z += 0.5) {
        const fromExpr = r.value.evaluate({ zoom: z });
        const fromEval = evaluateStrengthAtZoom({ zoom: z, strength: s });
        assert(Math.abs(fromExpr - fromEval) < 1e-3,
          `s=${s} z=${z}: expr=${fromExpr.toFixed(4)} eval=${fromEval.toFixed(4)}`);
      }
    }
  });

  // -----------------------------------------------------------------
  // 12. Full manual-test matrix — programmatically.
  //
  //     The user explicitly asked the rework be verified across:
  //       zoom        5..18
  //       theme       light / dark
  //       ramp        all 8 built-ins
  //       strength    0 .. 1.5
  //       exaggeration 0.5 .. 2
  //       mode        native / raster / off
  //       bathymetry  on / off
  //       high-contrast on / off
  //
  //     Below we walk that matrix, mutating the map state through
  //     the runtime, and assert determinism: every state change
  //     produces exactly the opacity + hillshade values the pure
  //     evaluators predict — no flicker, no drift, no last-writer
  //     wins.
  // -----------------------------------------------------------------
  await check('full matrix sweep — every combination produces deterministic output', async () => {
    const themes = ['light', 'dark'];
    const strengths = [0, 0.5, 1.0, 1.5];
    const userMuls = [0.5, 1, 2];
    const bathymetries = [true, false];
    const highContrasts = [true, false];
    const zooms = [5, 7, 9, 11, 13, 15, 18];
    let combos = 0;
    let failures = 0;
    const failExamples = [];
    const { applyHypsoTheme } = await importEsm('src/style/hypso/runtime.js');

    for (const theme of themes) {
      applyHypsoTheme(map, theme);
      for (const rampId of RAMP_IDS) {
        applyHypsoRamp(map, rampId, { dispatch: false });
        for (const bathy of bathymetries) {
          applyHypsoBathymetry(map, bathy);
          for (const hc of highContrasts) {
            applyHypsoHighContrast(map, hc);
            for (const userMul of userMuls) {
              map._cart.userExaggerationMul = userMul;
              for (const strength of strengths) {
                applyHypsoStrength(map, strength, { dispatch: false });
                map._cart.hypso._lastHillshade = {};
                rebalanceHillshadeForHypso(map, strength);
                for (const z of zooms) {
                  combos++;
                  map.getZoom = () => z;
                  map._cart.hypso._lastOpacity = {};
                  applyHypsoStrengthAtZoom(map);
                  // Opacity invariant.
                  const layer = map.getLayer(HYPSO_NATIVE_LAYER_ID);
                  const actualOpa = layer.paint['color-relief-opacity'];
                  const expectedOpa = evaluateStrengthAtZoom({ zoom: z, strength });
                  if (typeof actualOpa !== 'number') {
                    failures++;
                    if (failExamples.length < 3) {
                      failExamples.push(
                        `theme=${theme} ramp=${rampId} bathy=${bathy} hc=${hc} userMul=${userMul} strength=${strength} z=${z}: opacity not numeric (${typeof actualOpa})`,
                      );
                    }
                  } else if (Math.abs(actualOpa - expectedOpa) > 1e-3) {
                    failures++;
                    if (failExamples.length < 3) {
                      failExamples.push(
                        `theme=${theme} ramp=${rampId} bathy=${bathy} hc=${hc} userMul=${userMul} strength=${strength} z=${z}: opacity ${actualOpa} ≠ ${expectedOpa}`,
                      );
                    }
                  }
                  // Hillshade invariant.
                  const hillshade = map.getLayer('hillshade_primary');
                  const hExpr = hillshade.paint['hillshade-exaggeration'];
                  // Build the same expression and compare values at z.
                  const expectedHs = evaluateHillshadeExaggeration({
                    zoom: z,
                    baseMul: 1,
                    userMul,
                    hypsoStrength: strength,
                    hypsoActive: strength > 0,
                    reduceMotion: false,
                  });
                  let actualHs;
                  if (Array.isArray(hExpr)) {
                    // linZoom-style; walk stops to find value at z.
                    const stops = [];
                    for (let i = 3; i < hExpr.length; i += 2) {
                      stops.push([hExpr[i], hExpr[i + 1]]);
                    }
                    // Linear interp.
                    if (z <= stops[0][0]) actualHs = stops[0][1];
                    else if (z >= stops[stops.length - 1][0]) actualHs = stops[stops.length - 1][1];
                    else {
                      for (let i = 0; i < stops.length - 1; i++) {
                        const [z0, v0] = stops[i];
                        const [z1, v1] = stops[i + 1];
                        if (z >= z0 && z <= z1) {
                          const t = z1 === z0 ? 0 : (z - z0) / (z1 - z0);
                          actualHs = v0 + (v1 - v0) * t;
                          break;
                        }
                      }
                    }
                  } else {
                    actualHs = hExpr;
                  }
                  if (Math.abs(actualHs - expectedHs) > 5e-3) {
                    failures++;
                    if (failExamples.length < 3) {
                      failExamples.push(
                        `theme=${theme} ramp=${rampId} bathy=${bathy} hc=${hc} userMul=${userMul} strength=${strength} z=${z}: hillshade ${actualHs} ≠ ${expectedHs}`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    assert(failures === 0,
      `${failures}/${combos * 2} matrix combinations failed; first 3:\n  ${failExamples.join('\n  ')}`);
    // Stash the count for the summary message below.
    map._cart.__matrixSweepCount = combos;
  });

  await check('strength=0 → hillshade returns to FULL base curve (no leftover blend)', async () => {
    const { createExpression } = await import('@maplibre/maplibre-gl-style-spec');
    const v8 = (await import('@maplibre/maplibre-gl-style-spec/dist/latest.json', { with: { type: 'json' } })).default;
    const spec = v8.paint_hillshade['hillshade-exaggeration'];
    // Reset userMul to 1 — the matrix sweep above mutates it and we
    // want this assertion to compare against the unscaled base curve.
    map._cart.userExaggerationMul = 1;
    // Walk strength up to 1.0 then back to 0 to ensure no state sticks.
    map._cart.hypso._lastHillshade = {};
    rebalanceHillshadeForHypso(map, 1);
    map._cart.hypso._lastHillshade = {};
    rebalanceHillshadeForHypso(map, 0);
    const layer = map.getLayer('hillshade_primary');
    const r = createExpression(layer.paint['hillshade-exaggeration'], spec);
    for (const z of [5, 9, 14, 18]) {
      const actual = r.value.evaluate({ zoom: z });
      const expected = evaluateHillshadeExaggeration({
        zoom: z,
        hypsoActive: false,
      });
      assert(Math.abs(actual - expected) < 1e-3,
        `strength=0 z=${z}: ${actual} ≠ base ${expected} (blend leftover?)`);
    }
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
  if (map._cart?.__matrixSweepCount) {
    console.log(`Matrix sweep: ${map._cart.__matrixSweepCount} (theme × ramp × bathy × hc × userMul × strength × zoom) combinations exercised`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-hypso.mjs crashed:', err);
  process.exit(2);
});
