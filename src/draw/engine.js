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
  makeSource,
  makeLayers,
  findInsertBeforeLayer,
} from './layers.js';
import { buildConnections, formatDistance, haversine } from './connections.js';
import { listVertices, listMidpoints } from './edit.js';
import {
  loadFeatures,
  saveFeatures,
  loadPrefs,
  savePrefs,
  defaultPrefs,
} from './store.js';
import { runTool } from './tools.js';

const HISTORY_LIMIT = 60;
const SAVE_DEBOUNCE_MS = 320;

/** Stable monotonically-increasing id generator. */
let __idCounter = 0;
function nextId(prefix = 'f') {
  __idCounter += 1;
  return `draw-${prefix}-${Date.now().toString(36)}-${__idCounter.toString(36)}`;
}

/**
 * @typedef {object} DrawEngineHandle
 * @property {function(string):void} setTool
 * @property {function(string):void} setConnectionMode
 * @property {function(string):void} setShape
 * @property {function(Partial<import('./store.js').DrawPrefs>):void} setPrefs
 * @property {function():import('./store.js').DrawPrefs} getPrefs
 * @property {function():object} getState   Snapshot for the UI.
 * @property {function():void} undo
 * @property {function():void} redo
 * @property {function():void} clearAll
 * @property {function():void} deleteSelected
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
   * along to accept them. Bails silently when the style is still
   * loading — the `styledata`/`load` listeners below retry as soon as
   * the style is ready, so the very first user-visible call succeeds.
   *
   * Re-entrant by design: it gets called from three places — install
   * time, the `load` callback, and the `styledata` listener that fires
   * on every theme/quality rebuild.
   */
  const ensureLayers = () => {
    if (!map.getStyle) return;
    // MapLibre throws on addSource/addLayer until the style has fully
    // parsed. The `isStyleLoaded` probe is the canonical guard; older
    // builds may not expose it, in which case we fall back to a
    // try/catch on addSource alone.
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return;
    if (!map.getSource(SOURCE_ID)) {
      try {
        map.addSource(SOURCE_ID, makeSource());
      } catch {
        // Style still settling — let the next styledata try again.
        return;
      }
    }
    const before = findInsertBeforeLayer(map);
    for (const spec of makeLayers({
      color: prefs.color,
      fill: prefs.fill,
      weight: prefs.weight,
    })) {
      if (!map.getLayer(spec.id)) {
        try { map.addLayer(spec, before); }
        catch {
          try { map.addLayer(spec); }
          catch { /* style still settling — retry on next styledata */ }
        }
      }
    }
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
      pencil: 'crosshair',
      shape: 'crosshair',
      polygon: 'crosshair',
    };
    canvas.style.cursor = map2cursor[state.tool] ?? '';
  };

  // -------------------------------------------------------------------
  // Renderer — build the FeatureCollection that drives the source.
  // -------------------------------------------------------------------

  const buildCollection = () => {
    const out = [];

    // 1. Persistent user features.
    for (const f of state.features.values()) out.push(f);

    // 2. Auto-connections between markers.
    const markers = state.markerOrder
      .map((id) => state.features.get(id))
      .filter((f) => f && f.geometry?.type === 'Point' && f.properties?.kind === 'marker')
      .map((f) => ({ id: f.id, lngLat: f.geometry.coordinates }));
    const { features: conns, totalMeters } = buildConnections(markers, {
      mode: prefs.connectionMode,
      geodesic: prefs.geodesic,
    });
    for (const c of conns) out.push(c);

    // 3. In-progress draft (line being authored, shape preview, …).
    if (state.draft) out.push(state.draft);

    // 4. Vertex + midpoint handles for the selected feature.
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

    emit('metrics', { markers: markers.length, totalMeters, formatted: formatDistance(totalMeters) });
    return { type: 'FeatureCollection', features: out };
  };

  const rerender = () => {
    ensureLayers();
    const src = map.getSource(SOURCE_ID);
    if (!src) return;
    src.setData(buildCollection());

    // Sync feature-state for selection / hover so the layer paint
    // expressions can pick them up. setFeatureState requires the
    // feature to be visible in the source.
    if (state.selectedId) {
      try {
        map.setFeatureState({ source: SOURCE_ID, id: state.selectedId }, { selected: true });
      } catch { /* feature may not exist yet */ }
    }
    setLayerCursor();
  };

  // -------------------------------------------------------------------
  // Feature lifecycle helpers used by tools.
  // -------------------------------------------------------------------

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

  const onClick = (e) => { if (state.enabled) runTool('click', ctx, e); };
  const onDblClick = (e) => { if (state.enabled) runTool('dblclick', ctx, e); };
  const onMouseDown = (e) => { if (state.enabled) runTool('mousedown', ctx, e); };
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
    // push the current state back so drawings reappear.
    queueMicrotask(() => {
      ensureLayers();
      rerender();
    });
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

  // Restore persisted features.
  const persisted = loadFeatures();
  for (const f of persisted) {
    if (f.properties?.kind === 'connection') continue; // connections are recomputed
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
    setLayerCursor();
    emit('enabled', true);
  };
  /** Deactivate — map events are ignored but features stay rendered. */
  const disable = () => {
    state.enabled = false;
    state.draft = null;
    setLayerCursor();
    rerender();
    emit('enabled', false);
  };

  const setTool = (tool) => {
    if (state.tool === tool) return;
    state.tool = tool;
    state.draft = null;
    savePrefs({ tool });
    prefs.tool = tool;
    setLayerCursor();
    rerender();
    emit('tool', tool);
  };

  const setConnectionMode = (mode) => {
    if (prefs.connectionMode === mode) return;
    prefs.connectionMode = mode;
    savePrefs({ connectionMode: mode });
    rerender();
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
    if (patch.color || patch.fill || patch.weight) {
      // Layer paint expressions reference the prefs at composition time;
      // a colour change is best reflected by re-adding layers with the
      // new defaults. Cheap because the source isn't replaced.
      for (const layer of Object.values(LAYERS)) {
        if (map.getLayer(layer)) map.removeLayer(layer);
      }
      ensureLayers();
    }
    rerender();
    emit('prefs', { ...prefs });
  };

  /**
   * Cancel any in-progress draft (line vertex chain, polygon ring,
   * pencil stroke). Safe no-op when nothing is being drawn. Called by
   * the panel when the dock controller closes the draw panel — this
   * way the user doesn't return to a stale rubber-band edge later.
   */
  const cancelDraft = () => {
    if (!state.draft) return;
    state.draft = null;
    rerender();
    emit('draft', null);
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
    map.off('click', onClick);
    map.off('dblclick', onDblClick);
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
    map.off('contextmenu', onContextMenu);
    map.off('styledata', onStyleData);
    for (const layerId of HIT_LAYERS) {
      map.off('mouseenter', layerId, onLayerEnter);
      map.off('mouseleave', layerId, onLayerLeave);
    }
    window.removeEventListener('keydown', onKeyDown);
    for (const layer of Object.values(LAYERS)) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    if (saveTimer) clearTimeout(saveTimer);
    delete map.__cartDraw;
  };

  const handle = {
    enable, disable,
    setTool, setConnectionMode, setShape, setPrefs,
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
  };

  map.__cartDraw = handle;
  return handle;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export { LAYERS, SOURCE_ID } from './layers.js';
