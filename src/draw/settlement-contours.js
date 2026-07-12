/**
 * Manual settlement contours — author settlement outlines by hand.
 *
 * Why this exists
 * ---------------
 * The data-driven settlement outline stack (`src/style/settlements.js`)
 * frames every village / town / city whose boundary OMT exposes — plus
 * a point-ring fallback for polygon-less places and a hand-curated
 * supplement layer for spots OSM omits entirely (e.g. Заросляк). That
 * supplement is a HARD-CODED GeoJSON polygon in
 * `settlements-supplement.js`: every newly-missing place needs a code
 * change. This module replaces that workflow with an interactive one —
 * the user activates a mode, traces the outline of a settlement the
 * automatic detection missed, and it is saved + rendered with the exact
 * same look as every other settlement outline.
 *
 * Design
 * ------
 * A self-contained engine, deliberately INDEPENDENT of the general
 * drawing engine (`src/draw/engine.js`) so the two never interfere —
 * separate sources, separate layers, separate localStorage key, its own
 * undo-free authoring loop. It reuses the project's battle-tested pure
 * primitives, so the build/edit semantics are identical to the drawing
 * tools the brief points at:
 *
 *   • Authoring mirrors the polyline ("Ломаная") tool from `tools.js`:
 *     click to add a vertex, the last vertex rubber-bands to the cursor,
 *     double-click / Enter / a click near the first vertex finishes,
 *     Esc cancels. On finish the open polyline is closed into a Polygon
 *     ring so it renders as a framed plot.
 *   • Editing reuses the exact pure helpers from `edit.js`
 *     (`updateVertex` / `insertVertex` / `deleteVertex` / `listVertices`
 *     / `listMidpoints`) so individual points can be moved, inserted and
 *     removed WITHOUT recreating the whole contour.
 *
 * Rendering
 * ---------
 * Committed contours live in one GeoJSON source and are traced by the
 * shared `settlementPerimeterLayers()` builder — the very same paint the
 * supplement layers use — so a hand-drawn contour is visually
 * indistinguishable from a detected settlement outline. A transient
 * overlay source carries the in-progress draft line and the vertex /
 * midpoint editing handles; it is never persisted.
 *
 * Style resilience
 * ----------------
 * `applyStyle()` rebuilds the whole map style via `setStyle({diff:false})`
 * on theme / quality switches, which drops every runtime source + layer.
 * Like the drawing engine, we re-install on `styledata` / `idle` / `load`
 * and re-read the active theme each time so contours re-appear (recoloured
 * for the new theme) without any external wiring.
 */

import { getTokens } from '../style/tokens.js';
import { settlementPerimeterLayers } from '../style/settlements.js';
import { kv } from '../state/account-store.js';
import {
  listVertices,
  listMidpoints,
  updateVertex,
  insertVertex,
  deleteVertex,
  centroidOf,
} from './edit.js';
import { applySettlementContourLayerOrder } from '../map/layer-order.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Persistent polygon source — one per page, holds every saved contour. */
const SOURCE_ID = 'cart-settlement-contours';
/** Transient overlay source — draft line + editing handles, never saved. */
const OVERLAY_SOURCE_ID = 'cart-settlement-contours-overlay';

/** Layer id prefix for the four perimeter layers. */
const OUTLINE_PREFIX = 'cart-contour-outline';
/** Overlay layer ids. */
const LAYERS = Object.freeze({
  draftCasing: 'cart-contour-draft-casing',
  draft: 'cart-contour-draft',
  midpoint: 'cart-contour-vertex-mid',
  vertex: 'cart-contour-vertex',
});

/** Hit-test layers for editing handles (front to back priority). */
const HANDLE_LAYERS = Object.freeze([LAYERS.vertex, LAYERS.midpoint]);

/** localStorage blob holding the saved FeatureCollection. */
const STORE_KEY = 'cart:settlement-contours:v1';

/** Feature discriminator stamped on every committed contour. */
const KIND = 'settlement-contour';

/** Pixel travel below which a pointer gesture counts as a "click". */
const CLICK_SLOP_PX = 5;
/** Click within this many px of the first vertex closes the ring. */
const CLOSE_PX = 14;
/** Debounce window before flushing contour changes to localStorage. */
const SAVE_DEBOUNCE_MS = 320;

/** Double-tap detection for touch devices where dblclick doesn't fire. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function pxDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function activeTheme() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme || 'dark';
}

/** Count the distinct (non-closure) vertices of a contour polygon. */
function ringPointCount(feature) {
  const ring = feature?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring)) return 0;
  // Last point duplicates the first to close the ring.
  return Math.max(0, ring.length - 1);
}

/** Format a `[lng, lat]` pair for the side-panel readout. */
function fmtCoord(lngLat) {
  if (!Array.isArray(lngLat)) return '—';
  const [lng, lat] = lngLat;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// ---------------------------------------------------------------------------
// Persistence (defensive — storage may be unavailable / quota-limited).
// ---------------------------------------------------------------------------

// Persisted through the account store (server-synced, in-memory) rather than
// localStorage — see src/state/account-store.js. Contour edits flush through
// here on change, which the store routes to the account's `contours` field.
function storage() {
  return kv;
}

function isValidContour(f) {
  return (
    f &&
    f.type === 'Feature' &&
    f.geometry &&
    f.geometry.type === 'Polygon' &&
    Array.isArray(f.geometry.coordinates) &&
    Array.isArray(f.geometry.coordinates[0]) &&
    f.geometry.coordinates[0].length >= 4
  );
}

function loadContours() {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.features)) return [];
    return parsed.features.filter(isValidContour);
  } catch {
    return [];
  }
}

function saveContours(features) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORE_KEY, JSON.stringify({ version: 1, features }));
  } catch {
    /* quota / serialise error — best-effort, state stays in memory */
  }
}

// ---------------------------------------------------------------------------
// Engine factory.
// ---------------------------------------------------------------------------

/**
 * Create (or reuse) the settlement-contour engine for a map.
 *
 * Idempotent: a second call on the same map returns the existing handle
 * so hot-reloads / double-mounts don't stack listeners.
 *
 * @param {import('maplibre-gl').Map} map
 * @returns {object} engine handle
 */
export function createSettlementContourEngine(map) {
  if (map.__cartContours) return map.__cartContours;

  // -------------------------------------------------------------------
  // State.
  // -------------------------------------------------------------------
  const state = {
    /** @type {Map<string, GeoJSON.Feature>} id → polygon contour */
    contours: new Map(),
    /** Insertion order (newest last) for stable list rendering. */
    order: [],
    /** 'idle' | 'draw' | 'edit' */
    mode: 'idle',
    /** Contour id under edit, or null. */
    editingId: null,
    /** In-progress authoring ring: array of [lng,lat]; last = rubber-band. */
    draft: null,
    /** Active vertex drag descriptor while editing. */
    drag: null,
    /** Last tap for touch double-tap detection. */
    lastTap: { t: 0, point: null },
  };

  let counter = 0;
  const nextId = () =>
    `contour-${Date.now().toString(36)}-${(counter++).toString(36)}`;

  // -------------------------------------------------------------------
  // Event bus.
  // -------------------------------------------------------------------
  const listeners = new Map(); // event → Set<cb>
  const on = (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  };
  const emit = (event, payload) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch {
        /* a broken subscriber must not break the engine */
      }
    }
  };

  const emitChange = () => emit('change', getContours());
  const emitMode = () =>
    emit('mode', { mode: state.mode, editingId: state.editingId });

  // -------------------------------------------------------------------
  // Persistence (debounced).
  // -------------------------------------------------------------------
  let saveTimer = null;
  const flushPersist = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveContours(state.order.map((id) => state.contours.get(id)).filter(Boolean));
  };
  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPersist();
    }, SAVE_DEBOUNCE_MS);
  };

  // -------------------------------------------------------------------
  // Source + layer installation (resilient to style rebuilds).
  // -------------------------------------------------------------------

  /** Where to slot the outline layers — just under the first label layer
   *  so the contour sits above geometry but below text, matching the
   *  drawing engine's placement convention. */
  const findInsertBeforeLayer = () => {
    try {
      const layers = map.getStyle()?.layers ?? [];
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        if (
          l.type === 'symbol' &&
          (l.id.includes('label') || l.id.includes('text'))
        ) {
          return l.id;
        }
      }
    } catch {
      /* style not ready */
    }
    return undefined;
  };

  const overlayLayerSpecs = () => {
    const t = getTokens(activeTheme());
    return [
      // Draft casing — a soft dark backing so the in-flight line reads
      // on bright basemaps, echoing the committed contour's casing.
      {
        id: LAYERS.draftCasing,
        type: 'line',
        source: OVERLAY_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'draft'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': t.settlementCasing,
          'line-width': 6,
          'line-opacity': 0.55,
          'line-blur': 0.4,
        },
      },
      // Draft inline — dashed bright core that signals "authoring in
      // progress", in the same violet as the committed inline stroke.
      {
        id: LAYERS.draft,
        type: 'line',
        source: OVERLAY_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'draft'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': t.settlementInline,
          'line-width': 2.5,
          'line-dasharray': [1.4, 1.2],
        },
      },
      // Midpoint handles — click to insert a vertex.
      {
        id: LAYERS.midpoint,
        type: 'circle',
        source: OVERLAY_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'contour-vertex-mid'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-color': t.settlementInline,
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.75,
          'circle-opacity': 0.75,
          'circle-pitch-alignment': 'viewport',
        },
      },
      // Vertex handles — drag to move, right-click / Alt-click to delete.
      {
        id: LAYERS.vertex,
        type: 'circle',
        source: OVERLAY_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'contour-vertex'],
        paint: {
          'circle-radius': 5.5,
          'circle-color': '#ffffff',
          'circle-stroke-color': t.settlementInline,
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 1,
          'circle-opacity': 1,
          'circle-pitch-alignment': 'viewport',
        },
      },
    ];
  };

  /** Install sources + layers if the style is ready. Returns success. */
  const ensureLayers = () => {
    if (!map.isStyleLoaded?.()) return false;
    try {
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          tolerance: 0.0,
          buffer: 64,
        });
      }
      if (!map.getSource(OVERLAY_SOURCE_ID)) {
        map.addSource(OVERLAY_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          tolerance: 0.0,
          buffer: 64,
        });
      }

      // Outline layers — only render contours that aren't hidden.
      const before = findInsertBeforeLayer();
      const outlineLayers = settlementPerimeterLayers({
        t: getTokens(activeTheme()),
        source: SOURCE_ID,
        idPrefix: OUTLINE_PREFIX,
        minzoom: 0,
        filter: ['!=', ['get', 'hidden'], true],
      });
      for (const spec of outlineLayers) {
        if (!map.getLayer(spec.id)) {
          map.addLayer(spec, before && map.getLayer(before) ? before : undefined);
        }
      }

      // Overlay layers — always on top so handles stay clickable.
      for (const spec of overlayLayerSpecs()) {
        if (!map.getLayer(spec.id)) map.addLayer(spec);
      }
      applySettlementContourLayerOrder(map);
      return true;
    } catch {
      return false;
    }
  };

  /** Recolour the runtime layers after a theme change (in-place, no
   *  full reinstall needed when the source survives). */
  const recolorLayers = () => {
    const t = getTokens(activeTheme());
    const setPaint = (id, prop, value) => {
      try {
        if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
      } catch {
        /* layer mid-swap */
      }
    };
    setPaint(`${OUTLINE_PREFIX}_glow_outer`, 'line-color', t.settlementGlowOuter);
    setPaint(`${OUTLINE_PREFIX}_glow_inner`, 'line-color', t.settlementGlow);
    setPaint(`${OUTLINE_PREFIX}_casing`, 'line-color', t.settlementCasing);
    setPaint(`${OUTLINE_PREFIX}_inline`, 'line-color', t.settlementInline);
    setPaint(LAYERS.draftCasing, 'line-color', t.settlementCasing);
    setPaint(LAYERS.draft, 'line-color', t.settlementInline);
    setPaint(LAYERS.midpoint, 'circle-stroke-color', t.settlementInline);
    setPaint(LAYERS.vertex, 'circle-stroke-color', t.settlementInline);
  };

  // -------------------------------------------------------------------
  // Rendering.
  // -------------------------------------------------------------------

  const setData = (sourceId, fc) => {
    try {
      const src = map.getSource(sourceId);
      if (src && typeof src.setData === 'function') src.setData(fc);
    } catch {
      /* style mid-swap — next render retries */
    }
  };

  /** Push committed contours into the persistent source. */
  const renderContours = () => {
    const features = state.order
      .map((id) => state.contours.get(id))
      .filter(Boolean);
    setData(SOURCE_ID, { type: 'FeatureCollection', features });
  };

  /** Build the overlay collection: draft line + editing handles. */
  const buildOverlay = () => {
    const features = [];

    if (state.mode === 'draw' && state.draft && state.draft.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: state.draft.slice() },
        properties: { kind: 'draft' },
      });
    }

    if (state.mode === 'edit' && state.editingId) {
      const feature = state.contours.get(state.editingId);
      if (feature && feature.properties?.hidden !== true) {
        // Midpoints first (drawn under vertices), then vertices.
        for (const mp of listMidpoints(feature)) {
          const [ri, pi] = mp.ref.path;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: mp.lngLat },
            properties: { kind: 'contour-vertex-mid', ri, pi },
          });
        }
        let vi = 0;
        for (const v of listVertices(feature)) {
          const [ri, pi] = v.ref.path;
          features.push({
            type: 'Feature',
            id: `__cv_${vi++}`,
            geometry: { type: 'Point', coordinates: v.lngLat },
            properties: { kind: 'contour-vertex', ri, pi },
          });
        }
      }
    }

    return { type: 'FeatureCollection', features };
  };

  const renderOverlay = () => setData(OVERLAY_SOURCE_ID, buildOverlay());

  const renderAll = () => {
    renderContours();
    renderOverlay();
  };

  // -------------------------------------------------------------------
  // Contour CRUD.
  // -------------------------------------------------------------------

  const addContour = (feature) => {
    state.contours.set(feature.id, feature);
    state.order.push(feature.id);
    renderContours();
    schedulePersist();
    emitChange();
  };

  const updateContour = (id, nextFeature, { persist = true } = {}) => {
    if (!state.contours.has(id)) return;
    state.contours.set(id, nextFeature);
    renderContours();
    if (state.mode === 'edit' && state.editingId === id) renderOverlay();
    if (persist) schedulePersist();
    emitChange();
  };

  const removeContour = (id) => {
    if (!state.contours.has(id)) return;
    state.contours.delete(id);
    state.order = state.order.filter((x) => x !== id);
    if (state.editingId === id) {
      state.editingId = null;
      if (state.mode === 'edit') state.mode = 'idle';
      emitMode();
    }
    renderAll();
    schedulePersist();
    emitChange();
  };

  // -------------------------------------------------------------------
  // Cursor + map-gesture gating.
  // -------------------------------------------------------------------

  const applyCursor = () => {
    const canvas = map.getCanvas?.();
    if (!canvas) return;
    if (state.mode === 'draw') canvas.style.cursor = 'crosshair';
    else if (state.mode === 'edit') canvas.style.cursor = '';
    else canvas.style.cursor = '';
  };

  let dblZoomWasEnabled = null;
  const syncDoubleClickZoom = () => {
    // Drawing finishes on double-click — suppress the map's own
    // double-click-zoom while authoring so the finish gesture doesn't
    // also zoom the map. Restore the previous setting on exit.
    try {
      if (state.mode === 'draw') {
        if (dblZoomWasEnabled === null) {
          dblZoomWasEnabled = !!map.doubleClickZoom?.isEnabled?.();
        }
        map.doubleClickZoom?.disable?.();
      } else if (dblZoomWasEnabled !== null) {
        if (dblZoomWasEnabled) map.doubleClickZoom?.enable?.();
        dblZoomWasEnabled = null;
      }
    } catch {
      /* gesture handler not ready */
    }
  };

  // Authoring places vertices on discrete `click` events. MapLibre only
  // fires `click` when the pointer barely moves between mousedown and
  // mouseup — any larger travel is treated as a pan, which swallows the
  // click and just slides the map (the reported bug: press-and-slide to
  // "fix" the cursor before clicking does nothing but pan). Disabling
  // dragPan during the draw mode guarantees every press resolves to a
  // `click`, so vertex placement is deterministic. We snapshot and
  // restore the prior setting so editing / idle keep normal panning,
  // and so editing's own per-drag dragPan toggling isn't clobbered.
  let dragPanWasEnabled = null;
  const syncDrawPan = () => {
    try {
      if (state.mode === 'draw') {
        if (dragPanWasEnabled === null) {
          dragPanWasEnabled = !!map.dragPan?.isEnabled?.();
        }
        // Publish an authoring flag the freehand draw engine reads: when
        // a contour arms, controls.js flips that engine to its passive
        // `select` tool, whose own dragPan sync would otherwise re-enable
        // pan and swallow our authoring clicks. The flag tells it to
        // leave dragPan as we set it here.
        map.__cartContourAuthoring = true;
        map.dragPan?.disable?.();
      } else if (dragPanWasEnabled !== null) {
        map.__cartContourAuthoring = false;
        if (dragPanWasEnabled) map.dragPan?.enable?.();
        dragPanWasEnabled = null;
      }
    } catch {
      /* gesture handler not ready */
    }
  };

  // -------------------------------------------------------------------
  // Authoring (mirrors the polyline tool + polygon auto-close).
  // -------------------------------------------------------------------

  const isDoubleTap = (point) => {
    const now = Date.now();
    const prev = state.lastTap;
    const close = prev.point ? pxDistance(point, prev.point) < DOUBLE_TAP_PX : false;
    state.lastTap = { t: now, point: { x: point.x, y: point.y } };
    return now - prev.t < DOUBLE_TAP_MS && close;
  };

  const startDraftAt = (lngLat) => {
    // First authored vertex + a duplicated rubber-band vertex that
    // tracks the cursor until the next click — exactly the polyline
    // tool's draft shape.
    state.draft = [lngLat.slice(), lngLat.slice()];
    renderOverlay();
  };

  const onDrawClick = (e) => {
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    if (!state.draft) {
      startDraftAt(lngLat);
      return;
    }

    // Touch double-tap finishes (dblclick is unreliable on touch).
    if (isDoubleTap(e.point)) {
      finishDraft();
      return;
    }

    // Authored points are draft[0 .. n-2]; draft[n-1] is the rubber-band.
    const authored = state.draft.slice(0, -1);
    if (authored.length >= 3) {
      const firstPx = map.project(authored[0]);
      if (pxDistance(firstPx, e.point) <= CLOSE_PX) {
        finishDraft();
        return;
      }
    }
    // Promote the rubber-band into an authored vertex and start a new one.
    state.draft.push(lngLat);
    renderOverlay();
  };

  const onDrawMouseMove = (e) => {
    if (!state.draft) return;
    state.draft[state.draft.length - 1] = [e.lngLat.lng, e.lngLat.lat];
    renderOverlay();
  };

  const finishDraft = () => {
    const draft = state.draft;
    state.draft = null;
    if (!draft) return;
    // Drop the trailing rubber-band vertex (tracks cursor, not authored).
    const ring = draft.slice(0, -1);
    if (ring.length < 3) {
      // Not enough points for a polygon — discard silently.
      renderOverlay();
      return;
    }
    // Close the ring.
    ring.push(ring[0].slice());
    const id = nextId();
    const name = `Контур ${state.order.length + 1}`;
    addContour({
      type: 'Feature',
      id,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        kind: KIND,
        name,
        hidden: false,
        createdAt: Date.now(),
      },
    });
    // Authoring one contour returns to idle; the panel decides whether
    // to immediately re-arm for another.
    state.mode = 'idle';
    syncDoubleClickZoom();
    syncDrawPan();
    applyCursor();
    renderOverlay();
    emitMode();
    emit('created', { id });
  };

  const cancelDraft = () => {
    if (!state.draft) return;
    state.draft = null;
    renderOverlay();
  };

  // -------------------------------------------------------------------
  // Editing (reuses edit.js helpers).
  // -------------------------------------------------------------------

  const handleHitAt = (point) => {
    for (const layerId of HANDLE_LAYERS) {
      let hits = [];
      try {
        hits = map.queryRenderedFeatures(point, { layers: [layerId] }) || [];
      } catch {
        hits = [];
      }
      if (hits.length) return hits[0];
    }
    return null;
  };

  const refFromHandle = (handle, op) => {
    // Numeric ring/point indices are used instead of an array path so
    // MapLibre's property serialisation can never mangle them.
    const ri = Number(handle.properties.ri) || 0;
    const pi = Number(handle.properties.pi) || 0;
    return op ? { path: [ri, pi], op } : { path: [ri, pi] };
  };

  const onEditMouseDown = (e) => {
    if (state.mode !== 'edit' || !state.editingId) return;
    if (e.originalEvent?.button != null && e.originalEvent.button !== 0) return;
    const handle = handleHitAt(e.point);
    if (!handle || handle.properties?.kind !== 'contour-vertex') return;

    // Alt-click on a vertex deletes it (alternative to right-click).
    if (e.originalEvent?.altKey) {
      e.preventDefault();
      deleteVertexAt(refFromHandle(handle));
      return;
    }

    e.preventDefault();
    state.drag = {
      ref: refFromHandle(handle),
      start: { x: e.point.x, y: e.point.y },
      moved: false,
    };
    map.dragPan?.disable?.();
  };

  const onEditMouseMove = (e) => {
    if (!state.drag) return;
    const d = pxDistance(state.drag.start, e.point);
    if (d < CLICK_SLOP_PX && !state.drag.moved) return;
    state.drag.moved = true;
    const feature = state.contours.get(state.editingId);
    if (!feature) return;
    const next = updateVertex(feature, state.drag.ref, [e.lngLat.lng, e.lngLat.lat]);
    // Skip per-move persistence; flush once on mouseup.
    updateContour(state.editingId, next, { persist: false });
  };

  const onEditMouseUp = () => {
    if (!state.drag) return;
    const moved = state.drag.moved;
    state.drag = null;
    map.dragPan?.enable?.();
    if (moved) {
      // Suppress the synthetic click that follows a drag so it doesn't
      // get treated as a midpoint insert.
      suppressNextClick = true;
      flushPersist();
      emitChange();
    }
  };

  let suppressNextClick = false;

  const onEditClick = (e) => {
    if (state.mode !== 'edit' || !state.editingId) return;
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const handle = handleHitAt(e.point);
    if (!handle) return;
    if (handle.properties?.kind === 'contour-vertex-mid') {
      // Insert a new vertex at the clicked midpoint.
      const feature = state.contours.get(state.editingId);
      if (!feature) return;
      const next = insertVertex(feature, refFromHandle(handle, 'insert'), [
        e.lngLat.lng,
        e.lngLat.lat,
      ]);
      updateContour(state.editingId, next);
    }
  };

  const deleteVertexAt = (ref) => {
    const feature = state.contours.get(state.editingId);
    if (!feature) return;
    const next = deleteVertex(feature, ref);
    if (next === null) {
      // Would drop below a valid triangle — refuse and signal the UI.
      emit('vertexFloor', { id: state.editingId });
      return;
    }
    updateContour(state.editingId, next);
  };

  const onContextMenu = (e) => {
    if (state.mode !== 'edit' || !state.editingId) return;
    const handle = handleHitAt(e.point);
    if (handle?.properties?.kind === 'contour-vertex') {
      e.preventDefault();
      deleteVertexAt(refFromHandle(handle));
    }
  };

  // -------------------------------------------------------------------
  // Master map-event router.
  // -------------------------------------------------------------------

  const onClick = (e) => {
    if (state.mode === 'draw') onDrawClick(e);
    else if (state.mode === 'edit') onEditClick(e);
  };
  const onMouseMove = (e) => {
    if (state.mode === 'draw') onDrawMouseMove(e);
    else if (state.mode === 'edit') onEditMouseMove(e);
  };
  const onMouseDown = (e) => {
    if (state.mode === 'edit') onEditMouseDown(e);
  };
  const onMouseUp = () => {
    if (state.mode === 'edit') onEditMouseUp();
  };
  const onDblClick = (e) => {
    if (state.mode === 'draw') {
      e.preventDefault();
      finishDraft();
    }
  };
  const onKeyDown = (e) => {
    if (state.mode === 'draw') {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishDraft();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelDrawing();
      }
    } else if (state.mode === 'edit') {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopEditing();
      }
    }
  };

  // -------------------------------------------------------------------
  // Hover affordance — pointer feedback over editing handles.
  // -------------------------------------------------------------------
  const onHandleEnter = () => {
    if (state.mode === 'edit') {
      const canvas = map.getCanvas?.();
      if (canvas) canvas.style.cursor = 'pointer';
    }
  };
  const onHandleLeave = () => {
    if (state.mode === 'edit') {
      const canvas = map.getCanvas?.();
      if (canvas) canvas.style.cursor = '';
    }
  };

  // -------------------------------------------------------------------
  // Style-rebuild resilience.
  // -------------------------------------------------------------------
  let retryArmed = false;
  // Try to (re)install the source/layers and re-push the current data.
  // Returns true only when the style was ready and everything installed,
  // so the caller can decide whether an idle-retry is still needed.
  const tryInstallAndRender = () => {
    if (!ensureLayers()) return false;
    renderAll();
    recolorLayers();
    applyCursor();
    syncDoubleClickZoom();
    syncDrawPan();
    return true;
  };
  // One-shot `idle` latch. `idle` is the canonical "style fully settled"
  // signal in MapLibre and fires after every setStyle once the new style
  // has parsed, glyphs/sprites loaded and the first frame painted — the
  // single most reliable hook to converge installation on.
  const scheduleRetry = () => {
    if (retryArmed) return;
    retryArmed = true;
    map.once('idle', () => {
      retryArmed = false;
      // If the style was dirtied again between the idle signal and this
      // callback (another engine's idle pass may move layers), re-arm
      // for the next idle rather than dropping the reinstall on the
      // floor — no further styledata is guaranteed to arrive.
      if (!tryInstallAndRender()) scheduleRetry();
    });
  };
  const onStyleData = () => {
    // A theme / quality / map-mode switch swaps the whole style via
    // `setStyle({ diff: false })`, which drops our runtime layers and
    // emits several `styledata` events.
    //
    // 1) Attempt installation synchronously right now. When the style is
    //    already loaded this reinstalls the source/layers immediately —
    //    the proven behaviour callers (and tests) rely on.
    // 2) Belt-and-braces: always arm a one-shot `idle` retry. `idle` is
    //    guaranteed after every setStyle once the new style has fully
    //    parsed and painted, so we still reconverge if this synchronous
    //    attempt ran against a half-built style (`isStyleLoaded()` false)
    //    or one that gets replaced again later in the swap sequence.
    // Both paths are idempotent and cheap.
    tryInstallAndRender();
    scheduleRetry();
  };

  // -------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------

  function getContours() {
    return state.order
      .map((id) => state.contours.get(id))
      .filter(Boolean)
      .map((f) => ({
        id: f.id,
        name: f.properties?.name ?? '',
        hidden: f.properties?.hidden === true,
        pointCount: ringPointCount(f),
        centroid: centroidOf(f),
        centroidLabel: fmtCoord(centroidOf(f)),
        coordinates: (f.geometry?.coordinates?.[0] ?? []).slice(0, -1),
        editing: state.editingId === f.id,
      }));
  }

  function getState() {
    return {
      mode: state.mode,
      editingId: state.editingId,
      count: state.order.length,
      draftPoints: state.draft ? Math.max(0, state.draft.length - 1) : 0,
    };
  }

  function startDrawing() {
    stopEditing({ silent: true });
    state.mode = 'draw';
    state.draft = null;
    syncDoubleClickZoom();
    syncDrawPan();
    applyCursor();
    renderOverlay();
    emitMode();
  }

  function cancelDrawing() {
    if (state.mode !== 'draw') return;
    cancelDraft();
    state.mode = 'idle';
    syncDoubleClickZoom();
    syncDrawPan();
    applyCursor();
    emitMode();
  }

  function startEditing(id) {
    if (!state.contours.has(id)) return;
    if (state.mode === 'draw') cancelDrawing();
    // A hidden contour can't be edited meaningfully — reveal it first.
    const feature = state.contours.get(id);
    if (feature.properties?.hidden === true) setVisibility(id, true);
    state.mode = 'edit';
    state.editingId = id;
    applyCursor();
    renderOverlay();
    emitMode();
  }

  function stopEditing({ silent = false } = {}) {
    if (state.mode !== 'edit' && state.editingId == null) return;
    state.drag = null;
    map.dragPan?.enable?.();
    state.editingId = null;
    if (state.mode === 'edit') state.mode = 'idle';
    applyCursor();
    renderOverlay();
    if (!silent) emitMode();
  }

  function deleteContour(id) {
    removeContour(id);
  }

  function setVisibility(id, visible) {
    const f = state.contours.get(id);
    if (!f) return;
    const next = clone(f);
    next.properties.hidden = !visible;
    updateContour(id, next);
    if (!visible && state.editingId === id) stopEditing();
  }

  function toggleVisibility(id) {
    const f = state.contours.get(id);
    if (!f) return;
    setVisibility(id, f.properties?.hidden === true);
  }

  function renameContour(id, name) {
    const f = state.contours.get(id);
    if (!f) return;
    const next = clone(f);
    next.properties.name = String(name ?? '').slice(0, 80);
    updateContour(id, next);
  }

  function flyTo(id) {
    const f = state.contours.get(id);
    if (!f) return;
    const ring = f.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || !ring.length) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    try {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 80, maxZoom: 15, duration: 600 },
      );
    } catch {
      /* degenerate bounds — ignore */
    }
  }

  function clearAll() {
    state.contours.clear();
    state.order = [];
    state.editingId = null;
    if (state.mode !== 'idle') {
      state.mode = 'idle';
      syncDoubleClickZoom();
      syncDrawPan();
    }
    state.draft = null;
    applyCursor();
    renderAll();
    flushPersist();
    emitChange();
    emitMode();
  }

  function exportGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: state.order
        .map((id) => state.contours.get(id))
        .filter(Boolean)
        .map(clone),
    };
  }

  /**
   * Replace the entire contour set with `features` (an array of GeoJSON
   * polygon Features, or a `{ features: [...] }` collection). Used to apply
   * authoritative server state on login / refresh so contours appear on the
   * map immediately — without a page reload — and so the in-memory state and
   * the persisted blob can never diverge (which previously let the unload
   * flush clobber freshly-synced contours).
   */
  function replaceAll(features) {
    const list = Array.isArray(features)
      ? features
      : Array.isArray(features?.features)
        ? features.features
        : [];

    state.contours.clear();
    state.order = [];
    state.editingId = null;
    if (state.mode !== 'idle') {
      state.mode = 'idle';
      syncDoubleClickZoom();
      syncDrawPan();
    }
    state.draft = null;

    for (const f of list) {
      if (!isValidContour(f)) continue;
      const id = typeof f.id === 'string' && f.id ? f.id : nextId();
      const feature = clone(f);
      feature.id = id;
      feature.properties = {
        kind: KIND,
        name: feature.properties?.name ?? `Контур ${state.order.length + 1}`,
        hidden: feature.properties?.hidden === true,
        createdAt: feature.properties?.createdAt ?? Date.now(),
      };
      state.contours.set(id, feature);
      state.order.push(id);
    }

    applyCursor();
    ensureLayers();
    renderAll();
    flushPersist();
    emitChange();
    emitMode();
  }

  // Flush any pending debounced save before the page goes away so a
  // contour drawn moments before a reload / tab close isn't lost.
  const onPageHide = () => flushPersist();

  function dispose() {
    flushPersist();
    // Restore any gesture handlers we suspended for the draw mode so the
    // map is never left non-pannable after the engine goes away.
    if (state.mode === 'draw') {
      state.mode = 'idle';
      syncDoubleClickZoom();
      syncDrawPan();
    }
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onPageHide);
    map.off('click', onClick);
    map.off('dblclick', onDblClick);
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
    map.off('contextmenu', onContextMenu);
    map.off('styledata', onStyleData);
    for (const id of HANDLE_LAYERS) {
      map.off('mouseenter', id, onHandleEnter);
      map.off('mouseleave', id, onHandleLeave);
    }
    window.removeEventListener('keydown', onKeyDown);
    delete map.__cartContours;
  }

  // -------------------------------------------------------------------
  // Wire up.
  // -------------------------------------------------------------------

  // Restore persisted contours.
  for (const f of loadContours()) {
    // Defensive normalisation — guarantee the property shape downstream
    // code relies on, regardless of how old the persisted blob is.
    const id = typeof f.id === 'string' && f.id ? f.id : nextId();
    const feature = clone(f);
    feature.id = id;
    feature.properties = {
      kind: KIND,
      name: feature.properties?.name ?? `Контур ${state.order.length + 1}`,
      hidden: feature.properties?.hidden === true,
      createdAt: feature.properties?.createdAt ?? Date.now(),
    };
    state.contours.set(id, feature);
    state.order.push(id);
  }

  ensureLayers();
  renderAll();

  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);
  map.on('contextmenu', onContextMenu);
  map.on('styledata', onStyleData);
  for (const id of HANDLE_LAYERS) {
    map.on('mouseenter', id, onHandleEnter);
    map.on('mouseleave', id, onHandleLeave);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);
  map.once('load', () => {
    ensureLayers();
    renderAll();
  });

  const handle = {
    on,
    getContours,
    getState,
    startDrawing,
    cancelDrawing,
    startEditing,
    stopEditing,
    deleteContour,
    setVisibility,
    toggleVisibility,
    renameContour,
    flyTo,
    clearAll,
    replaceAll,
    exportGeoJSON,
    dispose,
  };
  map.__cartContours = handle;
  return handle;
}
