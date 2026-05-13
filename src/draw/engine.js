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
          out.push({ ...f, properties: { ...f.properties, displayOrder: display } });
          continue;
        }
      }
      out.push(f);
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
   *   • `optimal`:  handled as a one-shot on mode-switch, not here.
   *   • `none`:     no auto-connection.
   *
   * After this returns, the created lines are permanent — switching
   * connection mode later leaves them untouched.
   */
  const autoConnectOnMarker = (newMarkerId) => {
    const mode = prefs.connectionMode;
    if (mode === 'none' || mode === 'optimal') return;

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

  const addFeature = (feature, { skipHistory = false, skipAutoConnect = false } = {}) => {
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
      // Freeze auto-connections inline so the history snapshot already
      // taken above covers both the marker and its connection lines —
      // one undo reverses the whole click.
      if (!skipAutoConnect) autoConnectOnMarker(id);
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
    // push the current state back so drawings reappear. The pencil
    // recorder listens on the map CONTAINER, not the style, so it
    // survives a rebuild unchanged — but we still re-sync in case a
    // container swap ever happens (defensive).
    queueMicrotask(() => {
      ensureLayers();
      rerender();
      syncPencilLifecycle();
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
    syncPencilLifecycle();
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
  //
  // Legacy upgrade path: in earlier versions, auto-connections were
  // ephemeral `kind: 'connection'` features produced on every render
  // from `connectionMode`. They were never persisted, but some older
  // internal builds may have tried to save them — normalise those to
  // permanent `kind: 'line'` auto-gen entries so the upgrade is loss-
  // less. See the follow-up `backfillAutoConnections` step below for
  // the case where users had markers + a live mode but no saved lines.
  const persisted = loadFeatures();
  let sawLegacyConnection = false;
  for (const f of persisted) {
    if (f.properties?.kind === 'connection') {
      sawLegacyConnection = true;
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

  /**
   * Second leg of the legacy upgrade: if the user had a live
   * connection mode + ≥ 2 markers but NO auto-gen lines in storage
   * (because the old code never persisted the ephemeral connections),
   * synthesise them now as permanent auto-gen lines matching the
   * stored mode. Runs exactly once — a guard on any existing autoGen
   * feature means reloads after the first upgrade are no-ops.
   */
  const backfillAutoConnections = () => {
    const mode = prefs.connectionMode;
    if (mode === 'none') return;
    if (state.markerOrder.length < 2) return;
    for (const f of state.features.values()) {
      if (f.properties?.autoGen) return; // already backfilled
    }
    const markers = state.markerOrder
      .map((mid) => state.features.get(mid))
      .filter((f) => f && f.geometry?.type === 'Point' && f.properties?.kind === 'marker');
    if (markers.length < 2) return;

    const addLine = (from, to, autoMode) => {
      const ln = makeAutoGenLine(from, to, autoMode);
      state.features.set(ln.id, ln);
    };
    if (mode === 'sequence') {
      for (let i = 1; i < markers.length; i++) addLine(markers[i - 1], markers[i], 'sequence');
    } else if (mode === 'hub') {
      for (let i = 1; i < markers.length; i++) addLine(markers[0], markers[i], 'hub');
    } else if (mode === 'mesh') {
      for (let i = 0; i < markers.length; i++) {
        for (let j = i + 1; j < markers.length; j++) addLine(markers[i], markers[j], 'mesh');
      }
    } else if (mode === 'optimal') {
      const pts = markers.map((m) => m.geometry.coordinates);
      const tour = optimalTour(pts);
      for (let i = 0; i < tour.length - 1; i++) {
        addLine(markers[tour[i]], markers[tour[i + 1]], 'optimal');
      }
      // Optimal is a one-shot; revert mode so a future marker placement
      // doesn't re-trigger auto-connection under the wrong semantics.
      prefs.connectionMode = 'none';
      savePrefs({ connectionMode: 'none' });
    }
    schedulePersist();
  };
  // Only backfill when we actually detect a legacy situation: either
  // a legacy `kind: 'connection'` entry was filtered above, or the
  // user has live markers with a non-none mode but no autogen lines.
  if (sawLegacyConnection || (prefs.connectionMode !== 'none' && state.markerOrder.length >= 2)) {
    backfillAutoConnections();
  }
  rerender();

  // -------------------------------------------------------------------
  // Public handle.
  // -------------------------------------------------------------------

  /** Activate the engine (subscribed to map events). */
  const enable = () => {
    state.enabled = true;
    syncPencilLifecycle();
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
    setLayerCursor();
    rerender();
    emit('enabled', false);
  };

  const setTool = (tool) => {
    if (state.tool === tool) return;
    state.tool = tool;
    // One-shot invariants that must hold immediately after a tool
    // switch, regardless of which tool we came from or which we're
    // heading to. Keeping them here (instead of sprinkled in each
    // tool handler) is what makes the state model predictable.
    state.draft = null;
    state.drag = null;
    clearHover();
    savePrefs({ tool });
    prefs.tool = tool;
    syncPencilLifecycle();
    setLayerCursor();
    rerender();
    emit('tool', tool);
  };

  /**
   * Solve the open TSP over the current markers, REPLACE every prior
   * auto-generated connection with the tour, and revert the mode to
   * `'none'`. Called when the user selects "optimal" — it's a one-shot
   * action, not an ongoing mode. Returns the number of lines added.
   *
   * The rationale: "optimal" is an OPERATION ("compute the best route
   * for what I have now"), not a MODE ("connect every new marker
   * optimally to everything else"). Treating it as a mode would require
   * re-solving the TSP on every new marker and would move existing
   * committed tour legs around in the process — the same architectural
   * problem users hit with the old sequence/hub/mesh modes.
   *
   * Replacement (not additive) semantics matter: users who had been
   * drawing in sequence/hub/mesh and click "optimal" want their route
   * recomputed, not a second overlapping graph dropped on top. We
   * strip every feature with `properties.autoGen` before committing
   * the new tour; user-drawn lines / polygons / shapes / markers are
   * untouched.
   */
  const runOptimalOnce = () => {
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

  const setConnectionMode = (mode) => {
    if (mode === 'optimal') {
      // Treat optimal as a one-shot action: run the solver NOW over
      // the current markers and revert the mode to `'none'` so it
      // doesn't try to apply again on the next marker placement.
      runOptimalOnce();
      if (prefs.connectionMode !== 'none') {
        prefs.connectionMode = 'none';
        savePrefs({ connectionMode: 'none' });
        emit('connectionMode', 'none');
      } else {
        // Re-emit so the UI re-selects the "none" radio even if it
        // was already there (user clicking optimal shouldn't leave
        // the "optimal" pill highlighted).
        emit('connectionMode', 'none');
      }
      return;
    }
    if (prefs.connectionMode === mode) return;
    prefs.connectionMode = mode;
    savePrefs({ connectionMode: mode });
    // No rerender needed — mode change affects only FUTURE marker
    // placements, never existing features. Emit so the panel's radio
    // group updates to reflect the new selection.
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
    pencilRecorder.dispose();
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
