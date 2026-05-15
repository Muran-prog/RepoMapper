/**
 * Drawing engine — core state + MapLibre source/layer ownership.
 *
 * Architecture summary
 * --------------------
 * The engine maintains an authoritative `Map<id, Feature>` of user
 * drawings plus a small chunk of UI state (active tool, selection,
 * draft feature). On every state mutation it:
 *
 *   1. Recomputes connections (LineStrings between markers).
 *   2. Materialises edit handles when exactly one feature is selected.
 *   3. Composes a single FeatureCollection and pushes it through
 *      `setData` on the GeoJSON source — one DOM call per state change.
 *   4. Debounces a `saveFeatures` to localStorage.
 *
 * Auto-connection model — one source of truth
 * -------------------------------------------
 * Auto-generated connection LineStrings (sequence / hub / mesh /
 * optimal) are treated as PERMANENT DATA, not derived views. Once a
 * marker is placed, the lines produced by that gesture are committed
 * to `state.features` with `properties.autoGen: true` and live along-
 * side hand-drawn geometry: they persist, they undo, they export.
 * Changing `connectionMode` is a pure preference patch — it affects
 * only FUTURE marker placements and never mutates existing features.
 *
 * Optimal mode, scope isolation
 * -----------------------------
 * `optimal` is a connection mode with a strictly local effect: the
 * TSP tour is computed **only over markers placed since the mode was
 * most recently activated**, never over pre-existing markers. The
 * moment the user switches to `optimal` a fresh "optimizer epoch" is
 * minted, and every marker placed while the mode is live is stamped
 * with that epoch. Placing a new marker triggers a scope-bounded
 * TSP re-solve that replaces only lines carrying the **same** epoch
 * stamp — markers and lines from earlier epochs (or from any other
 * mode) are untouched forever. The programmatic `optimizeRoute()`
 * helper sidesteps the epoch scoping entirely and optimises all
 * markers in one shot; it's kept for tests and future power features.
 *
 * Style-rebuild resilience
 * ------------------------
 * The hypso / theme subsystems can rebuild the entire MapLibre style
 * via `applyStyle`. Our source + layers vanish with the old style. We
 * listen to `styledata` and re-install them when missing, then call
 * `rerender()` so the drawings re-appear seamlessly.
 *
 * Event routing
 * -------------
 * The engine registers map-level event listeners once. Each handler
 * dispatches to a per-tool callback (see `tools.js`) keyed by
 * `state.tool`. Tools are pure functions over `{ engine, event }` so
 * they can be unit-tested without a MapLibre instance.
 */

import {
  LAYERS,
  HIT_LAYERS,
  SOURCE_ID,
  MEASURE_SOURCE_ID,
  makeSource,
  makeLayers,
  makeMeasureSource,
  makeMeasureLayers,
  findInsertBeforeLayer,
} from './layers.js';
import {
  connectionCoords,
  haversine,
  optimalTour,
  formatDistance,
} from './connections.js';
import { listVertices, listMidpoints } from './edit.js';
import {
  loadFeatures,
  saveFeatures,
  loadPrefs,
  savePrefs,
} from './store.js';
import { runTool } from './tools.js';
import { createFreeDrawRecorder } from './freedraw.js';
import { createEraserRecorder, eraseFeatureInRadius } from './eraser.js';
import { buildMeasureFeatures, distanceForMarker } from './measure.js';

const HISTORY_LIMIT = 60;
const SAVE_DEBOUNCE_MS = 320;

/**
 * Valid connection modes recognised by `setConnectionMode`. Anything
 * outside this set is a silent no-op so stale persisted prefs cannot
 * crash the engine. `optimal` is here, but it's a scope-isolated mode
 * (see the "Optimal mode, scope isolation" section above) — very
 * different from the other three, which are memoryless per-placement
 * rules.
 */
const VALID_CONNECTION_MODES = new Set(['none', 'sequence', 'mesh', 'hub', 'optimal']);

/** Stable monotonically-increasing id generator. */
let __idCounter = 0;
function nextId(prefix = 'f') {
  __idCounter += 1;
  return `draw-${prefix}-${Date.now().toString(36)}-${__idCounter.toString(36)}`;
}

/**
 * @typedef {object} DrawEngineHandle
 * @property {function(string):void} setTool
 * @property {function(string):void} setConnectionMode  Valid modes: none|sequence|mesh|hub.
 * @property {function(string):void} setShape
 * @property {function(Partial<import('./store.js').DrawPrefs>):void} setPrefs
 * @property {function():import('./store.js').DrawPrefs} getPrefs
 * @property {function():object} getState   Snapshot for the UI.
 * @property {function():void} undo
 * @property {function():void} redo
 * @property {function():void} clearAll
 * @property {function():void} deleteSelected
 * @property {function():number} optimizeRoute  Explicit TSP action, see below.
 * @property {function():object} exportGeoJSON
 * @property {function(object):number} importGeoJSON
 * @property {function(string, Function):function():void} on   Subscribe to engine events.
 * @property {function():void} dispose
 */

/**
 * Instantiate the drawing engine on a MapLibre map. Idempotent — calling
 * twice returns the same handle. Caller owns disposal via `.dispose()`.
 *
 * @param {maplibregl.Map} map
 * @returns {DrawEngineHandle}
 */
export function createDrawEngine(map) {
  if (map.__cartDraw) return map.__cartDraw;

  const state = {
    /** @type {Map<string, GeoJSON.Feature>} */
    features: new Map(),
    /** Ordered list of marker ids — drives sequence/optimal connections. */
    markerOrder: [],
    /** Currently selected feature id, or null. */
    selectedId: null,
    /** In-progress feature (line vertex chain, shape preview, …) or null. */
    draft: null,
    /** Active tool slug. */
    tool: 'select',
    /** Hovered feature id (kept up to date by the map listener). */
    hoverId: null,
    /** Active drag operation, if any. */
    drag: null,
    /**
     * Drawing mode is always live — the *tool* state decides whether
     * map events do anything. `select` is the safe default that never
     * blocks pan/zoom, every other tool actively draws. We keep the
     * `enabled` flag for forward-compat (callers can pause the engine
     * imperatively) but it defaults to true so the panel doesn't have
     * to flip it on user interaction.
     */
    enabled: true,
  };

  const prefs = loadPrefs();
  state.tool = prefs.tool;

  /**
   * Monotonic stamp identifying the current "optimal mode session".
   * Every `setConnectionMode('optimal')` transition bumps it, and
   * every marker / line produced while the mode is live is tagged
   * with the current value. TSP re-solves only touch features whose
   * epoch matches `optimizerEpoch` — markers and lines from previous
   * sessions (this tab OR a reloaded page) are immutable.
   *
   * Seeded with `Date.now()` rather than zero so that stamps persisted
   * across reloads cannot collide with fresh ones: a new session's
   * `optimizerEpoch` starts strictly greater than any plausible stamp
   * from the previous session, even if the user incremented the
   * counter millions of times.
   */
  let optimizerEpoch = Date.now();

  // -------------------------------------------------------------------
  // Event bus — minimal pub/sub for the UI to follow state changes.
  // -------------------------------------------------------------------
  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };
  const emit = (event, payload) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch { /* listener errors mustn't break the engine */ }
    }
  };

  // -------------------------------------------------------------------
  // History — coarse undo/redo. Each entry snapshots `features` and
  // `markerOrder` so any mutation is reversible. Edits performed during
  // a drag coalesce into a single history entry on pointerup.
  // -------------------------------------------------------------------
  const history = { undo: [], redo: [] };

  const snapshot = () => ({
    features: new Map(Array.from(state.features.entries()).map(([k, v]) => [k, deepClone(v)])),
    markerOrder: state.markerOrder.slice(),
    selectedId: state.selectedId,
  });

  const restoreSnapshot = (snap) => {
    state.features = new Map(Array.from(snap.features.entries()).map(([k, v]) => [k, deepClone(v)]));
    state.markerOrder = snap.markerOrder.slice();
    state.selectedId = snap.selectedId;
  };

  const pushHistory = () => {
    history.undo.push(snapshot());
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo.length = 0;
    emit('history', { canUndo: history.undo.length > 0, canRedo: false });
  };

  const undo = () => {
    if (history.undo.length === 0) return;
    history.redo.push(snapshot());
    restoreSnapshot(history.undo.pop());
    rerender();
    schedulePersist();
    emit('change');
    emit('history', { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 });
  };

  const redo = () => {
    if (history.redo.length === 0) return;
    history.undo.push(snapshot());
    restoreSnapshot(history.redo.pop());
    rerender();
    schedulePersist();
    emit('change');
    emit('history', { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 });
  };

  // -------------------------------------------------------------------
  // Persistence — debounced so a fast drag doesn't hammer localStorage.
  // -------------------------------------------------------------------
  let saveTimer = null;
  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveFeatures(Array.from(state.features.values()));
    }, SAVE_DEBOUNCE_MS);
  };

  // -------------------------------------------------------------------
  // MapLibre source + layers — re-installed automatically when the
  // theme/quality picker rebuilds the underlying style.
  // -------------------------------------------------------------------

  /**
   * Install the engine's source + layers if the style is far enough
   * along to accept them. Returns `true` once the source AND every
   * expected layer are present in the live style; `false` while we're
   * still waiting for the style to settle.
   *
   * Re-entrant by design: it gets called from install time, the
   * `load` callback, the `styledata` listener that fires on every
   * theme/quality/mode rebuild, AND the `idle` fallback that catches
   * the slower `setStyle` cases where `styledata` only fires while
   * `isStyleLoaded()` is still false.
   */
  const ensureLayers = () => {
    if (!map.getStyle) return false;
    // MapLibre throws on addSource/addLayer until the style has fully
    // parsed. The `isStyleLoaded` probe is the canonical guard; older
    // builds may not expose it, in which case we fall back to a
    // try/catch on addSource alone.
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return false;
    if (!map.getSource(SOURCE_ID)) {
      try {
        map.addSource(SOURCE_ID, makeSource());
      } catch {
        // Style still settling — let the next styledata / idle try again.
        return false;
      }
    }
    if (!map.getSource(MEASURE_SOURCE_ID)) {
      try {
        map.addSource(MEASURE_SOURCE_ID, makeMeasureSource());
      } catch {
        return false;
      }
    }
    const before = findInsertBeforeLayer(map);
    let allLayersPresent = true;
    for (const spec of makeLayers({
      color: prefs.color,
      fill: prefs.fill,
      weight: prefs.weight,
    })) {
      if (!map.getLayer(spec.id)) {
        try { map.addLayer(spec, before); }
        catch {
          try { map.addLayer(spec); }
          catch {
            // Style still settling — retry on next styledata / idle.
            allLayersPresent = false;
          }
        }
      }
    }
    // Measure overlay layers — added AFTER the editing stack so the
    // ruler line + badge always sit on top of the drawings (a
    // measurement should never be obscured by a freshly-drawn
    // polygon). Same install-before anchor so they still stay below
    // basemap labels / MapLibre overlays.
    for (const spec of makeMeasureLayers()) {
      if (!map.getLayer(spec.id)) {
        try { map.addLayer(spec, before); }
        catch {
          try { map.addLayer(spec); }
          catch {
            allLayersPresent = false;
          }
        }
      }
    }
    return allLayersPresent
      && !!map.getSource(SOURCE_ID)
      && !!map.getSource(MEASURE_SOURCE_ID);
  };

  const setLayerCursor = () => {
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (!state.enabled) {
      canvas.style.cursor = '';
      return;
    }
    // In select mode with no hover we explicitly clear the cursor so
    // MapLibre's own grab/grabbing cursor stays in charge — anything
    // else here would visually disable the pan affordance even though
    // pan still works.
    const map2cursor = {
      select: state.hoverId ? 'pointer' : '',
      marker: 'crosshair',
      line: 'crosshair',
      segment: 'crosshair',
      pencil: 'crosshair',
      shape: 'crosshair',
      polygon: 'crosshair',
      // Eraser uses a DOM overlay (`.cart-eraser-cursor`) for its
      // size-aware preview, so the native cursor must get out of the
      // way — `none` hides the OS arrow without disabling clicks.
      eraser: 'none',
    };
    canvas.style.cursor = map2cursor[state.tool] ?? '';
  };

  /**
   * Clear the on-canvas hover state. Called when the active tool
   * changes so a stale "hovered feature" doesn't keep its highlight
   * after the user switches into drawing mode and back.
   */
  const clearHover = () => {
    if (!state.hoverId) return;
    try {
      map.setFeatureState(
        { source: SOURCE_ID, id: state.hoverId },
        { hover: false },
      );
    } catch { /* source may not exist — ignore */ }
    state.hoverId = null;
  };

  // -------------------------------------------------------------------
  // Renderer — build the FeatureCollection that drives the source.
  // -------------------------------------------------------------------

  /**
   * Length of a LineString in metres. Works for both straight (2-point)
   * connections and densely-sampled geodesics — summing haversines
   * between consecutive points equals the true arc length of the
   * underlying geodesic, since each step IS the great-circle distance
   * between those two samples.
   */
  const lineStringLengthMeters = (coords) => {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += haversine(coords[i - 1], coords[i]);
    }
    return total;
  };

  const buildCollection = () => {
    const out = [];

    // 1. Persistent user features. Auto-connections are now stored as
    //    permanent `kind: 'line'` features with `autoGen: true` on
    //    their properties — so they flow through the same pipeline as
    //    hand-drawn lines. Mode switches can't mutate them any more.
    //
    //    We stamp `displayOrder` on markers from insertion order so
    //    the label layer renders a stable 1..N matching `markerOrder`.
    const markerIndex = new Map();
    state.markerOrder.forEach((mid, i) => markerIndex.set(mid, i + 1));

    for (const f of state.features.values()) {
      if (f.properties?.kind === 'marker') {
        const display = markerIndex.get(f.id);
        if (display != null) {
          out.push({ ...f, properties: { ...f.properties, displayOrder: display, _fid: f.id } });
          continue;
        }
      }
      out.push({ ...f, properties: { ...f.properties, _fid: f.id } });
    }

    // 2. In-progress draft (line being authored, shape preview, …).
    if (state.draft) out.push(state.draft);

    // 3. Vertex + midpoint handles for the selected feature.
    if (state.selectedId && state.tool === 'select') {
      const sel = state.features.get(state.selectedId);
      if (sel) {
        let i = 0;
        for (const v of listVertices(sel)) {
          out.push({
            type: 'Feature',
            id: `__vertex_${state.selectedId}_${i++}`,
            geometry: { type: 'Point', coordinates: v.lngLat },
            properties: {
              kind: 'vertex',
              parentId: state.selectedId,
              path: v.ref.path,
            },
          });
        }
        let m = 0;
        for (const mp of listMidpoints(sel)) {
          out.push({
            type: 'Feature',
            id: `__midvertex_${state.selectedId}_${m++}`,
            geometry: { type: 'Point', coordinates: mp.lngLat },
            properties: {
              kind: 'vertex-mid',
              parentId: state.selectedId,
              path: mp.ref.path,
              op: 'insert',
            },
          });
        }
      }
    }

    // Route-length stat is the sum of every auto-gen line's arc length.
    // User-drawn lines don't count — they're arbitrary polylines and
    // don't form a "route" semantically. Keeping the stat scoped to
    // auto-gen features means it remains meaningful after mode switches
    // (because those lines don't disappear).
    let totalMeters = 0;
    for (const f of state.features.values()) {
      if (f.properties?.autoGen && f.geometry?.type === 'LineString') {
        totalMeters += lineStringLengthMeters(f.geometry.coordinates);
      }
    }
    emit('metrics', {
      markers: state.markerOrder.length,
      totalMeters,
      formatted: formatDistance(totalMeters),
    });
    return { type: 'FeatureCollection', features: out };
  };

  /**
   * Build the FeatureCollection driving the measure (ruler) source.
   * Empty when the toggle is off OR when there are fewer than two
   * markers — both edge cases the brief calls out explicitly. When
   * empty we still push an empty collection through `setData` so a
   * mid-flight toggle clears the overlay immediately.
   */
  const buildMeasureCollection = () => {
    if (!prefs.measure || state.markerOrder.length < 2) {
      return { type: 'FeatureCollection', features: [] };
    }
    const markers = state.markerOrder
      .map((mid) => state.features.get(mid))
      .filter((f) => f
        && f.geometry?.type === 'Point'
        && f.properties?.kind === 'marker')
      .map((f) => ({ id: f.id, coordinates: f.geometry.coordinates }));
    const { features } = buildMeasureFeatures(markers);
    return { type: 'FeatureCollection', features };
  };

  /** Snapshot of the current marker list in the shape `measure.js` expects. */
  const currentMeasureMarkers = () => state.markerOrder
    .map((mid) => state.features.get(mid))
    .filter((f) => f
      && f.geometry?.type === 'Point'
      && f.properties?.kind === 'marker')
    .map((f) => ({ id: f.id, coordinates: f.geometry.coordinates }));

  const rerender = () => {
    if (!tryInstallAndRender()) {
      // Style is mid-swap — schedule a single retry once it settles
      // so the engine doesn't sit on stale state forever.
      scheduleStyleSettleRetry();
    }
  };

  // -------------------------------------------------------------------
  // Feature lifecycle helpers used by tools.
  // -------------------------------------------------------------------

  /**
   * Build an auto-gen line feature from one marker to another. The
   * feature is a regular `kind: 'line'` so all the rendering, editing
   * and persistence paths treat it uniformly — the only discriminator
   * is `properties.autoGen` plus `properties.autoMode` (which records
   * the mode that produced it, for diagnostics and the route-stat
   * filter). Marker endpoints are tracked via `fromId`/`toId` for
   * possible future cleanup on marker deletion.
   */
  const makeAutoGenLine = (from, to, autoMode) => {
    const id = nextId('line');
    const coords = connectionCoords(
      from.geometry.coordinates,
      to.geometry.coordinates,
      { geodesic: !!prefs.geodesic },
    );
    return {
      type: 'Feature',
      id,
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        kind: 'line',
        color: prefs.color,
        fill: prefs.fill,
        weight: prefs.weight,
        opacity: prefs.opacity,
        autoGen: true,
        autoMode,
        fromId: from.id,
        toId: to.id,
        createdAt: Date.now(),
      },
    };
  };

  /**
   * Freeze auto-connections for the just-placed marker into permanent
   * line features. Mutates `state.features` in place — does NOT push
   * history (the caller's `addFeature` already did) and does not
   * rerender (the caller does that one step up).
   *
   *   • `sequence`: one line from marker[N-1] → marker[N].
   *   • `hub`:      one line from marker[0]   → marker[N].
   *   • `mesh`:     N lines from every prior marker → marker[N].
   *   • `optimal`:  TSP over every marker stamped with the current
   *                 optimizer epoch; replaces lines of the same epoch.
   *                 See `optimalConnect()` below for the details and
   *                 the rationale for scope-isolated re-solves.
   *   • `none`:     no auto-connection.
   *
   * After this returns, the created lines are permanent — switching
   * connection mode later leaves them untouched.
   */
  const autoConnectOnMarker = (newMarkerId) => {
    const mode = prefs.connectionMode;

    if (mode === 'optimal') {
      optimalConnect();
      return;
    }
    // Defensive: non-connecting mode (or unknown string from stale
    // persisted prefs) — nothing to do.
    if (mode !== 'sequence' && mode !== 'hub' && mode !== 'mesh') return;

    const markers = state.markerOrder
      .map((mid) => state.features.get(mid))
      .filter((f) => f && f.geometry?.type === 'Point' && f.properties?.kind === 'marker');
    const newIdx = markers.findIndex((m) => m.id === newMarkerId);
    if (newIdx < 1) return; // First marker has nothing to connect to.
    const to = markers[newIdx];

    if (mode === 'sequence') {
      const ln = makeAutoGenLine(markers[newIdx - 1], to, 'sequence');
      state.features.set(ln.id, ln);
    } else if (mode === 'hub') {
      const ln = makeAutoGenLine(markers[0], to, 'hub');
      state.features.set(ln.id, ln);
    } else if (mode === 'mesh') {
      for (let i = 0; i < newIdx; i++) {
        const ln = makeAutoGenLine(markers[i], to, 'mesh');
        state.features.set(ln.id, ln);
      }
    }
  };

  /**
   * Re-solve the open TSP inside the current optimizer epoch scope
   * and replace the epoch's tour legs with the new ones. Called from
   * `autoConnectOnMarker` when `mode === 'optimal'`.
   *
   * Scope definition:
   *
   *   • A marker is "in scope" iff its `properties.optimizerEpoch`
   *     equals the current `optimizerEpoch` closure value.
   *   • A line is "in scope" iff it is autoGen, `autoMode === 'optimal'`
   *     and its `properties.optimizerEpoch` matches.
   *
   * The just-placed marker was stamped in `addFeature`, so by the
   * time we're called it is already in scope. Markers/lines from a
   * previous optimal session (different epoch), or from any other
   * mode (no stamp), are NEVER touched — this is the architectural
   * promise the user asked for.
   *
   * Replacing rather than appending keeps the visible state optimal
   * at every step: as markers arrive, the tour reshuffles only among
   * same-epoch markers, so the result always looks like a single
   * coherent route, not a growing pile of insert-heuristic artifacts.
   */
  const optimalConnect = () => {
    const scope = state.markerOrder
      .map((mid) => state.features.get(mid))
      .filter((f) => f
        && f.geometry?.type === 'Point'
        && f.properties?.kind === 'marker'
        && f.properties?.optimizerEpoch === optimizerEpoch);
    if (scope.length < 2) return; // Need at least two points for a leg.

    // Sweep only lines belonging to THIS epoch. Lines from prior
    // optimal sessions (or from a persisted reload) have a different
    // stamp and are invisible to this replacement pass.
    for (const [id, f] of state.features) {
      if (f.properties?.autoGen
          && f.properties?.autoMode === 'optimal'
          && f.properties?.optimizerEpoch === optimizerEpoch) {
        state.features.delete(id);
      }
    }
    // Drop selection if it referenced a cleared line.
    if (state.selectedId && !state.features.has(state.selectedId)) {
      state.selectedId = null;
    }

    const pts = scope.map((m) => m.geometry.coordinates);
    const tour = optimalTour(pts);
    for (let i = 0; i < tour.length - 1; i++) {
      const from = scope[tour[i]];
      const to = scope[tour[i + 1]];
      const ln = makeAutoGenLine(from, to, 'optimal');
      ln.properties.optimizerEpoch = optimizerEpoch;
      state.features.set(ln.id, ln);
    }
  };

  const addFeature = (feature, { skipHistory = false } = {}) => {
    if (!skipHistory) pushHistory();
    const id = feature.id ?? nextId(feature.properties?.kind ?? 'f');
    feature.id = id;
    if (!feature.properties) feature.properties = {};
    feature.properties.createdAt = Date.now();
    state.features.set(id, feature);
    if (feature.properties.kind === 'marker') {
      state.markerOrder.push(id);
      // Stamp the per-marker number so the symbol layer can render it.
      feature.properties.order = state.markerOrder.length;
      // If the user is in optimal mode, stamp the marker with the
      // current epoch BEFORE auto-connecting — `optimalConnect` reads
      // this property to decide which markers are in scope. Markers
      // placed in any other mode carry no stamp, which makes them
      // invisible to every future optimizer session.
      if (prefs.connectionMode === 'optimal') {
        feature.properties.optimizerEpoch = optimizerEpoch;
      }
      // Freeze auto-connections inline. One user click = one history
      // entry: the snapshot taken above covers both the marker and
      // every auto-line it triggers, so Ctrl+Z reverses the whole
      // gesture in a single step.
      autoConnectOnMarker(id);
    }
    schedulePersist();
    emit('change');
    rerender();
    return id;
  };

  const updateFeature = (id, mutator, { skipHistory = false } = {}) => {
    const f = state.features.get(id);
    if (!f) return;
    if (!skipHistory) pushHistory();
    const next = typeof mutator === 'function' ? mutator(deepClone(f)) : mutator;
    if (!next) {
      removeFeature(id, { skipHistory: true });
      return;
    }
    next.id = id;
    state.features.set(id, next);
    schedulePersist();
    emit('change');
    rerender();
  };

  const removeFeature = (id, { skipHistory = false } = {}) => {
    if (!state.features.has(id)) return;
    if (!skipHistory) pushHistory();
    state.features.delete(id);
    state.markerOrder = state.markerOrder.filter((m) => m !== id);
    // Renumber marker labels so they stay 1..N.
    state.markerOrder.forEach((mid, i) => {
      const m = state.features.get(mid);
      if (m && m.properties) m.properties.order = i + 1;
    });
    if (state.selectedId === id) state.selectedId = null;
    schedulePersist();
    emit('change');
    rerender();
  };

  const selectFeature = (id, { silent = false } = {}) => {
    if (state.selectedId === id) return;
    const prev = state.selectedId;
    if (prev) {
      try { map.setFeatureState({ source: SOURCE_ID, id: prev }, { selected: false }); }
      catch { /* style may have rebuilt */ }
    }
    state.selectedId = id;
    if (!silent) emit('selection', { id });
    rerender();
  };

  const clearSelection = () => selectFeature(null);

  const deleteSelected = () => {
    if (!state.selectedId) return;
    removeFeature(state.selectedId);
  };

  const clearAll = () => {
    if (state.features.size === 0) return;
    pushHistory();
    state.features.clear();
    state.markerOrder.length = 0;
    state.selectedId = null;
    state.draft = null;
    schedulePersist();
    emit('change');
    rerender();
  };

  // -------------------------------------------------------------------
  // Pencil recorder — a DOM-listener stroke capture installed/removed
  // as the pencil tool is armed/disarmed. Runs entirely on native
  // PointerEvents so mouse, touch and pen input all work uniformly.
  // -------------------------------------------------------------------
  const pencilRecorder = createFreeDrawRecorder(map, {
    epsilonPx: 2.2,
    smooth: true,
    onPreview: (samples) => {
      if (!samples || samples.length < 2) {
        if (state.draft?.properties?.kind === 'pencil-draft') {
          state.draft = null;
          rerender();
        }
        return;
      }
      const coords = [];
      for (const [x, y] of samples) {
        try {
          const ll = map.unproject([x, y]);
          coords.push([ll.lng, ll.lat]);
        } catch { /* skip invalid */ }
      }
      if (coords.length < 2) return;
      state.draft = {
        type: 'Feature',
        id: '__draft_pencil',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          kind: 'pencil-draft',
          color: prefs.color,
          weight: prefs.weight,
          opacity: prefs.opacity,
          preview: true,
        },
      };
      rerender();
    },
    onCommit: (geom) => {
      const hadDraft = !!state.draft;
      state.draft = null;
      if (geom) {
        addFeature({
          type: 'Feature',
          id: nextId('pencil'),
          geometry: geom,
          properties: {
            kind: 'pencil',
            color: prefs.color,
            fill: prefs.fill,
            weight: prefs.weight,
            opacity: prefs.opacity,
          },
        });
      } else if (hadDraft) {
        rerender();
      }
    },
  });

  /**
   * Toggle the pencil recorder based on the active tool. Idempotent —
   * attach/detach internally short-circuit if already in the desired
   * state. Called from setTool() and also after style rebuilds so a
   * theme swap can't orphan the listeners.
   */
  const syncPencilLifecycle = () => {
    if (state.enabled && state.tool === 'pencil') {
      pencilRecorder.attach();
    } else {
      pencilRecorder.detach();
    }
  };

  // -------------------------------------------------------------------
  // Eraser recorder — owns its own pointer listeners so the gesture
  // works on touch as well as mouse, and so the in-flight cursor
  // overlay can be drawn once into the map container without fighting
  // with MapLibre's own pan/zoom handlers.
  //
  // History coalescing: one drag = one undo step. We push a single
  // snapshot at pointerdown via `onStrokeStart`, then every per-tick
  // erase mutates `state.features` directly with `skipHistory`. On
  // pointerup the last state of the stroke is what `state` holds, so
  // a subsequent Ctrl+Z restores the pre-drag world in one step.
  // -------------------------------------------------------------------

  /**
   * Apply the eraser disk centred at `[lng, lat]` once. Walks every
   * persistent feature, deletes those entirely covered, splits the
   * partially-covered LineStrings (lines / pencils / auto-gen
   * connections) into surviving fragments, and never touches features
   * the disk doesn't intersect.
   *
   * No history push here — the caller (the eraser recorder) frames the
   * whole drag with a single `pushHistory` at stroke start, so each
   * tick coalesces into that one undo step.
   *
   * @param {[number, number]} centerLngLat
   */
  const eraseAt = (centerLngLat) => {
    const radiusPx = Math.max(2, Number(prefs.eraserSize) || 30);
    let mutated = false;

    // Snapshot the iteration target — `state.features` may grow with
    // replacement fragments inside the loop, and we don't want to
    // re-scan our own outputs (their IDs are fresh, so they were
    // born OUTSIDE the disk by construction).
    const snapshotIds = Array.from(state.features.keys());
    for (const id of snapshotIds) {
      const feature = state.features.get(id);
      if (!feature) continue;
      // Skip drafts/handles entirely — those live in the rendered
      // collection but not in `state.features`, so they can't be hit
      // here in the first place. Defensive guard for synthetic kinds
      // that might one day end up persisted by mistake.
      const kind = feature.properties?.kind;
      if (kind === 'vertex' || kind === 'vertex-mid') continue;

      const result = eraseFeatureInRadius(feature, centerLngLat, radiusPx, map);
      if (result === 'unchanged') continue;

      mutated = true;
      state.features.delete(id);
      if (state.selectedId === id) state.selectedId = null;
      // Drop the marker from the ordered list if it was one. Replacement
      // fragments are LineStrings (eraser only splits lines), so they
      // never re-enter `markerOrder`.
      const orderIdx = state.markerOrder.indexOf(id);
      if (orderIdx >= 0) state.markerOrder.splice(orderIdx, 1);

      for (const piece of result.replace) {
        const newId = nextId(piece.properties?.kind ?? 'erased');
        piece.id = newId;
        state.features.set(newId, piece);
      }
    }

    if (mutated) {
      // Renumber markers after a marker erasure so labels stay 1..N.
      state.markerOrder.forEach((mid, i) => {
        const m = state.features.get(mid);
        if (m && m.properties) m.properties.order = i + 1;
      });
      schedulePersist();
      emit('change');
      rerender();
    }
  };

  const eraserRecorder = createEraserRecorder(map, {
    getRadius: () => Number(prefs.eraserSize) || 30,
    onStrokeStart: () => { pushHistory(); },
    onErase: (lngLat) => { eraseAt(lngLat); },
    // No onStrokeEnd payload — the per-tick mutations already drove
    // schedulePersist/emit, so all that's left at pointerup is to
    // release the gesture suspension, which the recorder does itself.
  });

  /**
   * Toggle the eraser recorder based on the active tool. Mirrors
   * `syncPencilLifecycle` — same idempotent attach/detach contract.
   */
  const syncEraserLifecycle = () => {
    if (state.enabled && state.tool === 'eraser') {
      eraserRecorder.attach();
    } else {
      eraserRecorder.detach();
    }
  };

  // Tools that finish on dblclick need doubleClickZoom disabled so the
  // gesture reaches the tool instead of zooming the map (critical on
  // mobile where double-tap is the only way to fire dblclick).
  const DBLCLICK_TOOLS = new Set(['line', 'polygon']);
  const syncDoubleClickZoom = () => {
    if (state.enabled && DBLCLICK_TOOLS.has(state.tool)) {
      map.doubleClickZoom?.disable?.();
    } else {
      map.doubleClickZoom?.enable?.();
    }
  };

  // -------------------------------------------------------------------
  // Map event wiring. One listener per map event; the tool dispatcher
  // (`runTool`) reads `state.tool` and routes to the right handler.
  // -------------------------------------------------------------------

  const ctx = {
    map,
    state,
    prefs,
    addFeature,
    updateFeature,
    removeFeature,
    selectFeature,
    clearSelection,
    pushHistory,
    rerender,
    emit,
    nextId,
  };

  /**
   * When measure mode is enabled, tapping a marker is reserved for the
   * pairwise-distance readout — no tool may also act on the same
   * click. Otherwise the marker tool would drop a new dot beside the
   * one the user just tried to query (the bug users hit when querying
   * distances with the marker tool armed), and the line/polygon tools
   * would push a vertex on top of the marker.
   *
   * Hit detection is deliberately coordinate-based rather than going
   * through `queryRenderedFeatures`. The marker layer's hit-test
   * sometimes doesn't return matches (e.g. when style validation
   * keeps the `cart-draw-point` layer out of the live style on edge
   * configurations), and we still need the suppression to work on
   * those paths — otherwise the user taps the dot they just placed
   * to read its distance and ends up with a duplicate marker.
   *
   * The hit radius is generous (16 px) so a slightly-off finger tap
   * still counts as "on the marker": the marker dot is only ~8 px
   * in radius, which is too tight for touch targets.
   *
   * @param {{x: number, y: number}} point Canvas-relative pixels.
   * @returns {string|null} Hit marker id, or null when nothing's near.
   */
  const HIT_RADIUS_PX = 16;
  const findMarkerNearPoint = (point) => {
    let bestId = null;
    let bestDist = HIT_RADIUS_PX * HIT_RADIUS_PX;
    for (const mid of state.markerOrder) {
      const f = state.features.get(mid);
      if (!f || f.geometry?.type !== 'Point') continue;
      let projected;
      try { projected = map.project(f.geometry.coordinates); }
      catch { continue; }
      const dx = projected.x - point.x;
      const dy = projected.y - point.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDist) {
        bestDist = d2;
        bestId = mid;
      }
    }
    return bestId;
  };
  const measureClickHitsMarker = (point) => {
    if (!prefs.measure) return false;
    return findMarkerNearPoint(point) != null;
  };

  /**
   * Detect a tap on a committed line feature. If hit, emit `lineAction`
   * so the UI can show a "detach" tooltip. Returns true when a line was
   * hit (suppresses further tool dispatch). Skipped when a draft is
   * in-flight so drawing isn't interrupted.
   */
  const LINE_HIT_TOLERANCE = 10;
  const detectLineHit = (e) => {
    if (state.draft) return false;
    const bbox = [
      [e.point.x - LINE_HIT_TOLERANCE, e.point.y - LINE_HIT_TOLERANCE],
      [e.point.x + LINE_HIT_TOLERANCE, e.point.y + LINE_HIT_TOLERANCE],
    ];
    let hits;
    try {
      hits = map.queryRenderedFeatures(bbox, { layers: [LAYERS.line] });
    } catch { return false; }
    if (!hits || hits.length === 0) return false;
    for (const hit of hits) {
      // MapLibre may return the id as a numeric index or as the string
      // we set. Also check properties._fid which we stamp below.
      const id = hit.properties?._fid || hit.id;
      if (!id || !state.features.has(id)) continue;
      const f = state.features.get(id);
      if (f.geometry?.type !== 'LineString') continue;
      emit('lineAction', {
        lineId: id,
        pointPx: { x: e.point.x, y: e.point.y },
        properties: f.properties,
      });
      return true;
    }
    return false;
  };

  const onClick = (e) => {
    if (!state.enabled) return;
    if (measureClickHitsMarker(e.point)) return;
    // Line action: tap on any line shows detach tooltip (works in all modes).
    if (detectLineHit(e)) return;
    runTool('click', ctx, e);
  };
  const onDblClick = (e) => { if (state.enabled) runTool('dblclick', ctx, e); };
  const onMouseDown = (e) => {
    if (!state.enabled) return;
    // Same suppression on mousedown so the select tool's translate-
    // drag doesn't kick in on a measure tap either.
    if (measureClickHitsMarker(e.point)) return;
    runTool('mousedown', ctx, e);
  };
  const onMouseMove = (e) => { if (state.enabled) runTool('mousemove', ctx, e); };
  const onMouseUp = (e) => { if (state.enabled) runTool('mouseup', ctx, e); };
  const onContextMenu = (e) => { if (state.enabled) runTool('contextmenu', ctx, e); };

  const onKeyDown = (e) => {
    if (!state.enabled) return;
    // Only react when the focus isn't sitting inside an input/textarea
    // so the panel's editable fields keep their native shortcuts.
    const tag = (e.target?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Escape') {
      if (state.draft) {
        state.draft = null;
        rerender();
        emit('draft', null);
      } else if (state.selectedId) {
        clearSelection();
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedId) {
        deleteSelected();
        e.preventDefault();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) redo();
      else undo();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      redo();
      e.preventDefault();
    }
  };

  const onStyleData = () => {
    // Style rebuild — our source/layers were wiped. Reinstate them and
    // push the current state back so drawings reappear. The pencil
    // recorder listens on the map CONTAINER, not the style, so it
    // survives a rebuild unchanged — but we still re-sync in case a
    // container swap ever happens (defensive).
    //
    // `setStyle({ diff: false })` (used by the theme / mode switcher)
    // emits multiple `styledata` events while the style is still
    // mid-swap. During those early events `isStyleLoaded()` reports
    // false, so `ensureLayers` correctly bails — but a later
    // `styledata` may not arrive until the user touches the map again,
    // and that left a window where the drawings stayed invisible
    // until the first new gesture poked the source back into life.
    //
    // The fix: when the early attempt bails, fall back to a one-shot
    // `idle` listener. `idle` is guaranteed to fire after every
    // setStyle once the new style finishes settling, so we always
    // converge on a ready state without spamming retries.
    queueMicrotask(() => {
      const ready = tryInstallAndRender();
      if (!ready) scheduleStyleSettleRetry();
    });
  };

  /**
   * Try to install the engine's source/layers and push the current
   * collection. Returns `true` when both succeeded, `false` when the
   * style was still mid-swap. Safe to call repeatedly — every step is
   * idempotent.
   */
  const tryInstallAndRender = () => {
    const installed = ensureLayers();
    const src = map.getSource(SOURCE_ID);
    if (!installed || !src) return false;
    try {
      src.setData(buildCollection());
    } catch {
      return false;
    }
    // Push the measure overlay separately. A failure here shouldn't
    // unwind the main render — the editing stack has already updated
    // and we'd rather show drawings without ruler than nothing at
    // all. The overlay will reconverge on the next render tick.
    const measureSrc = map.getSource(MEASURE_SOURCE_ID);
    if (measureSrc) {
      try { measureSrc.setData(buildMeasureCollection()); }
      catch { /* style mid-swap — measure will retry next tick */ }
    }
    if (state.selectedId) {
      try {
        map.setFeatureState({ source: SOURCE_ID, id: state.selectedId }, { selected: true });
      } catch { /* feature may not exist yet */ }
    }
    setLayerCursor();
    syncPencilLifecycle();
    syncEraserLifecycle();
    syncDoubleClickZoom();
    return true;
  };

  // One-shot retry latch. Multiple `styledata` events during a single
  // `setStyle` would otherwise pile up a stack of `idle` listeners; the
  // flag debounces them down to a single retry per swap.
  let styleSettleRetryArmed = false;
  const scheduleStyleSettleRetry = () => {
    if (styleSettleRetryArmed) return;
    styleSettleRetryArmed = true;
    const retry = () => {
      styleSettleRetryArmed = false;
      tryInstallAndRender();
    };
    // `idle` fires after every setStyle once the new style has fully
    // settled (sources registered, sprite/glyphs loaded, first frame
    // rendered) — that's the canonical "done" signal in MapLibre and
    // the most reliable single hook to retry installation on.
    map.once('idle', retry);
  };

  // -------------------------------------------------------------------
  // Install.
  //
  // The map's style may still be loading when `createDrawEngine` is
  // called (the bootstrap chain runs synchronously after `new Map(…)`,
  // before the style finishes parsing). We try `ensureLayers` now so
  // that warm reloads — where the style is already cached — install
  // instantly. If the style isn't ready, the function bails and the
  // `load` / `styledata` listeners below retry as soon as it is.
  // -------------------------------------------------------------------

  ensureLayers();

  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);
  map.on('contextmenu', onContextMenu);
  map.on('styledata', onStyleData);
  // Belt-and-braces: even if no `styledata` fires after this point,
  // `load` always does on a fresh map. Once the style is ready we
  // install the layer stack and push the persisted feature collection
  // through the source for the first time.
  map.once('load', () => {
    ensureLayers();
    rerender();
    syncPencilLifecycle();
    syncEraserLifecycle();
    syncDoubleClickZoom();
  });
  window.addEventListener('keydown', onKeyDown);

  // Hover tracking — sets cursor + feature-state for halo visuals.
  const onLayerEnter = (e) => {
    const f = e.features?.[0];
    if (!f) return;
    if (state.hoverId && state.hoverId !== f.id) {
      try { map.setFeatureState({ source: SOURCE_ID, id: state.hoverId }, { hover: false }); }
      catch { /* */ }
    }
    state.hoverId = f.id;
    try { map.setFeatureState({ source: SOURCE_ID, id: f.id }, { hover: true }); }
    catch { /* */ }
    setLayerCursor();
  };
  const onLayerLeave = () => {
    if (state.hoverId) {
      try { map.setFeatureState({ source: SOURCE_ID, id: state.hoverId }, { hover: false }); }
      catch { /* */ }
    }
    state.hoverId = null;
    setLayerCursor();
  };

  for (const layerId of HIT_LAYERS) {
    map.on('mouseenter', layerId, onLayerEnter);
    map.on('mouseleave', layerId, onLayerLeave);
  }

  // -------------------------------------------------------------------
  // Marker tap → measure tooltip.
  //
  // A click/tap on ANY marker (regardless of the active tool) emits
  // a `markerTooltip` event carrying the formatted distance to the
  // marker's neighbour:
  //
  //   • non-last marker → distance to the NEXT marker
  //   • last marker     → distance to the PREVIOUS marker
  //
  // The UI layer (the dock controller in `controls.js`) listens and
  // renders the floating tooltip. We never compute or expose the
  // total length from first to last — that's deliberate: this is a
  // pairwise ruler, not a route summary.
  //
  // Hit-testing uses the same `findMarkerNearPoint` helper as the
  // tool-suppression path. Going through `state.features` rather
  // than `queryRenderedFeatures({ layers: [LAYERS.point] })` keeps
  // the readout working even on the codepaths where the marker
  // layer didn't make it into the live style (the engine has a
  // pre-existing layer-spec validation issue that occasionally
  // leaves cart-draw-point unregistered). The user gets the same
  // reliable tap-to-read behaviour either way.
  // -------------------------------------------------------------------
  const onMeasureClick = (e) => {
    if (!state.enabled) return;
    if (!prefs.measure) return;
    const id = findMarkerNearPoint(e.point);
    if (!id) {
      // Empty space tap — close any open tooltip. Doing this in the
      // same handler (instead of a separate "empty click" listener)
      // keeps the open/close logic on a single decision point and
      // removes the ordering problem between two click handlers.
      emit('markerTooltip', { hide: true });
      return;
    }
    const dist = distanceForMarker(currentMeasureMarkers(), id);
    if (!dist) {
      // Fewer than two markers — emit a hide event so any open
      // tooltip from a previous state goes away.
      emit('markerTooltip', { hide: true });
      return;
    }
    emit('markerTooltip', {
      hide: false,
      markerId: id,
      pointPx: { x: e.point.x, y: e.point.y },
      meters: dist.meters,
      label: dist.label,
      fromId: dist.fromId,
      toId: dist.toId,
    });
  };
  map.on('click', onMeasureClick);

  // Restore persisted features.
  //
  // Single, explicit migration pass: every persisted feature is
  // either copied verbatim into `state.features` or, if it carries
  // the pre-refactor `kind: 'connection'` discriminator, rewritten
  // into the current `kind: 'line', autoGen: true` shape so newer
  // code paths treat it uniformly. No ambient side-effects — we do
  // NOT touch live prefs, we do NOT synthesise missing geometry.
  // What was persisted is what we restore.
  const persisted = loadFeatures();
  for (const f of persisted) {
    if (f.properties?.kind === 'connection') {
      const coords = f.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lid = nextId('line');
      state.features.set(lid, {
        type: 'Feature',
        id: lid,
        geometry: { type: 'LineString', coordinates: coords.slice() },
        properties: {
          kind: 'line',
          color: f.properties.color ?? prefs.color,
          fill: f.properties.fill ?? prefs.fill,
          weight: f.properties.weight ?? prefs.weight,
          opacity: f.properties.opacity ?? prefs.opacity,
          autoGen: true,
          autoMode: f.properties.connectionMode ?? 'sequence',
          fromId: f.properties.fromId,
          toId: f.properties.toId,
          createdAt: f.properties.createdAt ?? Date.now(),
        },
      });
      continue;
    }
    state.features.set(f.id, f);
    if (f.properties?.kind === 'marker') {
      state.markerOrder.push(f.id);
    }
  }
  // Renumber marker labels — they may have been saved out of order on
  // older versions of the schema.
  state.markerOrder.forEach((mid, i) => {
    const m = state.features.get(mid);
    if (m && m.properties) m.properties.order = i + 1;
  });

  rerender();

  // -------------------------------------------------------------------
  // Public handle.
  // -------------------------------------------------------------------

  /** Activate the engine (subscribed to map events). */
  const enable = () => {
    state.enabled = true;
    syncPencilLifecycle();
    syncEraserLifecycle();
    syncDoubleClickZoom();
    setLayerCursor();
    emit('enabled', true);
  };
  /** Deactivate — map events are ignored but features stay rendered. */
  const disable = () => {
    state.enabled = false;
    state.draft = null;
    state.drag = null;
    clearHover();
    syncPencilLifecycle();
    syncEraserLifecycle();
    syncDoubleClickZoom();
    setLayerCursor();
    rerender();
    emit('enabled', false);
  };

  const commitDraftIfValid = () => {
    const draft = state.draft;
    if (!draft) return;
    const kind = draft.properties?.kind;
    if (kind === 'line-draft') {
      const coords = draft.geometry?.coordinates;
      // Drop the trailing rubber-band vertex (tracks cursor, not authored).
      const final = coords?.slice(0, -1);
      if (final && final.length >= 2) {
        addFeature({
          type: 'Feature',
          id: nextId('line'),
          geometry: { type: 'LineString', coordinates: final },
          properties: {
            kind: 'line',
            color: draft.properties.color,
            fill: draft.properties.fill,
            weight: draft.properties.weight,
            opacity: draft.properties.opacity,
          },
        });
      }
    } else if (kind === 'polygon-draft') {
      const coords = draft.geometry?.coordinates?.slice(0, -1);
      if (coords && coords.length >= 3) {
        coords.push(coords[0]);
        addFeature({
          type: 'Feature',
          id: nextId('polygon'),
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: {
            kind: 'polygon',
            color: draft.properties.color,
            fill: draft.properties.fill,
            weight: draft.properties.weight,
            opacity: draft.properties.opacity,
          },
        });
      }
    }
    emit('draft', null);
  };

  const setTool = (tool) => {
    if (state.tool === tool) return;
    state.tool = tool;
    // Auto-commit valid drafts on tool switch. On mobile, users
    // can't easily double-tap or long-press to finish a line/polygon,
    // so switching tools is their natural "done" gesture.
    commitDraftIfValid();
    state.draft = null;
    state.drag = null;
    clearHover();
    savePrefs({ tool });
    prefs.tool = tool;
    syncPencilLifecycle();
    syncEraserLifecycle();
    syncDoubleClickZoom();
    setLayerCursor();
    rerender();
    emit('tool', tool);
  };

  /**
   * Solve the open TSP over the current markers and REPLACE every
   * prior auto-generated connection with the tour. A single explicit
   * user action, exposed in the UI as its own button.
   *
   * This is NOT a mode: it doesn't touch `prefs.connectionMode`, it
   * doesn't change what happens on the next marker placement. The
   * reason is semantic clarity — the user asked "optimise what I
   * already placed", not "always connect markers optimally". Making
   * it a mode would require re-solving the TSP on every new marker
   * and shuffling previously-committed tour legs in the process,
   * which is exactly the surprise-move behaviour users complained
   * about with the old sequence/hub/mesh modes.
   *
   * Replacement (not additive) semantics matter: users who had been
   * drawing in sequence/hub/mesh and click "optimise" want their
   * route recomputed, not a second overlapping graph dropped on top.
   * We strip every feature with `properties.autoGen` before committing
   * the new tour; user-drawn lines / polygons / shapes / markers are
   * untouched.
   *
   * One history entry per click: `pushHistory()` is called once, the
   * replacement is atomic, one Ctrl+Z undoes the whole action.
   *
   * @returns {number} Number of tour legs committed (0 if < 2 markers).
   */
  const optimizeRoute = () => {
    const markers = state.markerOrder
      .map((mid) => state.features.get(mid))
      .filter((f) => f && f.geometry?.type === 'Point' && f.properties?.kind === 'marker');
    if (markers.length < 2) return 0;

    pushHistory();

    // Clear every pre-existing auto-gen connection so the new tour
    // replaces — rather than overlays — whatever sequence/hub/mesh
    // route was previously visible. Safe during iteration: JS Map
    // iteration is insertion-order and tolerates deletion of the
    // current entry.
    for (const [id, f] of state.features) {
      if (f.properties?.autoGen) state.features.delete(id);
    }
    // A cleared auto-gen line might have been the currently-selected
    // feature — drop the selection so the handle layer doesn't try to
    // render vertices for a feature that no longer exists.
    if (state.selectedId && !state.features.has(state.selectedId)) {
      state.selectedId = null;
    }

    const pts = markers.map((m) => m.geometry.coordinates);
    const tour = optimalTour(pts);
    let added = 0;
    for (let i = 0; i < tour.length - 1; i++) {
      const from = markers[tour[i]];
      const to = markers[tour[i + 1]];
      const ln = makeAutoGenLine(from, to, 'optimal');
      state.features.set(ln.id, ln);
      added++;
    }
    schedulePersist();
    emit('change');
    rerender();
    return added;
  };

  /**
   * Set the connection mode used for FUTURE marker placements:
   *
   *   • validates `mode` is one of the supported values,
   *   • no-op when it's the current mode,
   *   • bumps `optimizerEpoch` on a transition INTO `'optimal'` — this
   *     is the _only_ side effect beyond prefs/emit, and it's pure in
   *     the sense that no feature geometry is touched. The bump is
   *     what makes the next marker placement start a fresh TSP scope
   *     rather than re-open the previous optimizer session.
   *   • writes prefs (in-memory + localStorage),
   *   • emits `connectionMode` for the UI.
   *
   * Does NOT:
   *
   *   • recompute, move or delete any existing geometry,
   *   • re-render the map (nothing changed on screen).
   *
   * The central invariant — "mode change affects only future
   * placements" — still holds: a new epoch only affects markers
   * placed AFTER the transition. Existing stamped markers from a
   * previous optimizer session retain their stamps and remain frozen
   * because no subsequent re-solve will target their epoch.
   */
  const setConnectionMode = (mode) => {
    if (!VALID_CONNECTION_MODES.has(mode)) return;
    if (prefs.connectionMode === mode) return;
    if (mode === 'optimal') {
      optimizerEpoch += 1;
    }
    prefs.connectionMode = mode;
    savePrefs({ connectionMode: mode });
    emit('connectionMode', mode);
  };

  const setShape = (shape) => {
    if (prefs.shapeType === shape) return;
    prefs.shapeType = shape;
    savePrefs({ shapeType: shape });
    emit('shape', shape);
  };

  const setPrefs = (patch) => {
    Object.assign(prefs, patch);
    savePrefs(patch);
    // The layer paint expressions read every style property from each
    // feature's own `properties` bag (`color`, `fill`, `weight`,
    // `opacity`). New features pick up the updated prefs automatically
    // via styleBag(prefs) in tools.js — no need to rebuild layers.
    //
    // We DO push the new colour into the vertex-handle layers, since
    // those don't read from feature properties (handles are synthetic
    // and have no user-controlled colour). Handle stroke colour
    // matches the palette so it feels connected to the rest.
    if (patch.color) {
      for (const id of [LAYERS.vertex, LAYERS.vertexMid]) {
        if (map.getLayer(id)) {
          try { map.setPaintProperty(id, 'circle-stroke-color', prefs.color); }
          catch { /* */ }
        }
      }
    }
    // Resize the eraser cursor immediately so the user sees their
    // slider adjustment without having to nudge the pointer.
    if ('eraserSize' in patch) eraserRecorder.syncRadius();
    // Toggling the measure overlay off should also dismiss any
    // currently-visible floating tooltip — otherwise the readout
    // would survive the master switch and confuse the user.
    if ('measure' in patch && !patch.measure) {
      emit('markerTooltip', { hide: true });
    }
    rerender();
    emit('prefs', { ...prefs });
  };

  /**
   * Finish or discard any in-progress draft. Called by the panel when
   * the dock controller closes the draw panel. Commits valid geometry
   * (enough vertices) so mobile users don't lose work when the panel
   * auto-dismisses; discards incomplete stubs.
   */
  const cancelDraft = () => {
    if (!state.draft) return;
    commitDraftIfValid();
    state.draft = null;
    rerender();
  };

  const exportGeoJSON = () => ({
    type: 'FeatureCollection',
    features: Array.from(state.features.values()),
  });

  const importGeoJSON = (json) => {
    if (!json || !Array.isArray(json.features)) return 0;
    pushHistory();
    let added = 0;
    for (const f of json.features) {
      if (!f.geometry) continue;
      const id = nextId(f.properties?.kind ?? 'imp');
      const next = deepClone(f);
      next.id = id;
      if (!next.properties) next.properties = {};
      state.features.set(id, next);
      if (next.properties.kind === 'marker') state.markerOrder.push(id);
      added++;
    }
    state.markerOrder.forEach((mid, i) => {
      const m = state.features.get(mid);
      if (m && m.properties) m.properties.order = i + 1;
    });
    schedulePersist();
    emit('change');
    rerender();
    return added;
  };

  const dispose = () => {
    pencilRecorder.dispose();
    eraserRecorder.dispose();
    map.off('click', onClick);
    map.off('dblclick', onDblClick);
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
    map.off('contextmenu', onContextMenu);
    map.off('styledata', onStyleData);
    map.off('click', onMeasureClick);
    for (const layerId of HIT_LAYERS) {
      map.off('mouseenter', layerId, onLayerEnter);
      map.off('mouseleave', layerId, onLayerLeave);
    }
    window.removeEventListener('keydown', onKeyDown);
    for (const layer of Object.values(LAYERS)) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    if (map.getSource(MEASURE_SOURCE_ID)) map.removeSource(MEASURE_SOURCE_ID);
    if (saveTimer) clearTimeout(saveTimer);
    delete map.__cartDraw;
  };

  /**
   * Flush any pending debounced save immediately. Intended for tests
   * that need a synchronous persistence round-trip; production paths
   * can rely on the normal debounce + dispose semantics.
   */
  const flushPersist = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveFeatures(Array.from(state.features.values()));
  };

  const handle = {
    enable, disable,
    setTool, setConnectionMode, setShape, setPrefs,
    optimizeRoute,
    getPrefs: () => ({ ...prefs }),
    getState: () => ({
      tool: state.tool,
      enabled: state.enabled,
      selectedId: state.selectedId,
      markerCount: state.markerOrder.length,
      featureCount: state.features.size,
      historyDepth: history.undo.length,
      redoDepth: history.redo.length,
    }),
    undo, redo,
    clearAll, deleteSelected, cancelDraft,
    exportGeoJSON, importGeoJSON,
    on,
    dispose,
    /** Internal hooks — exposed so `tools.js` can manipulate state. */
    _ctx: ctx,
    _addFeature: addFeature,
    _updateFeature: updateFeature,
    _removeFeature: removeFeature,
    _selectFeature: selectFeature,
    _clearSelection: clearSelection,
    _pushHistory: pushHistory,
    _rerender: rerender,
    _nextId: nextId,
    _flushPersist: flushPersist,
  };

  map.__cartDraw = handle;
  return handle;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export { LAYERS, SOURCE_ID } from './layers.js';
