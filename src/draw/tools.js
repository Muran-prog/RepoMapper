/**
 * Tool dispatch — per-tool MapLibre event handlers.
 *
 * Each tool is a small bag of functions keyed by the MapLibre event
 * name (`click`, `mousedown`, `mousemove`, `mouseup`, `dblclick`,
 * `contextmenu`). The engine's master listener calls `runTool(eventName,
 * ctx, e)` which looks up the handler for the active tool and invokes
 * it. Missing handlers are silently skipped — that's how each tool
 * opts into only the events it cares about.
 *
 * Intent-detection notes
 * ----------------------
 *   • A small movement between mousedown and mouseup (< 4 px) is a
 *     "click"; longer is a "drag". This is the same heuristic that
 *     desktop OSes use and matches user expectation.
 *   • In `select` mode, clicking on a vertex handle starts a vertex
 *     drag; clicking on a midpoint handle inserts a new vertex; clicking
 *     on the feature body starts a translation drag.
 *   • Tools that author multi-vertex geometries (line, polygon) finish
 *     on `dblclick` OR when the user clicks within 12 px of the first
 *     vertex (polygon auto-close). Esc cancels (handled in engine.js).
 */

import { HIT_LAYERS, HANDLE_LAYERS } from './layers.js';
import {
  makeCircle,
  makeRectangle,
  makeRegularPolygon,
  makeStar,
  makeArrow,
} from './shapes.js';
import {
  updateVertex,
  insertVertex,
  translateFeature,
} from './edit.js';
import { haversine } from './connections.js';

/** Pixel threshold below which we classify pointer travel as "click". */
const CLICK_SLOP_PX = 5;

/** Default shape size (pixels) used when prefs.shapeSize is missing. */
const DEFAULT_SHAPE_SIZE_PX = 100;

/**
 * Build a uniform style bag for newly-authored features. Every tool
 * goes through this so the layer paint can rely on the same property
 * set (`color`, `fill`, `weight`, `opacity`) without per-kind
 * fallbacks.
 */
function styleBag(prefs) {
  return {
    color: prefs.color,
    fill: prefs.fill,
    weight: prefs.weight,
    opacity: prefs.opacity,
  };
}

/**
 * Convert a pixel radius to metres at the given map centre + zoom.
 * Uses the map's current projection so shapes retain their apparent
 * on-screen size across zoom levels at commit time (the shape itself
 * is then in metres, so it grows/shrinks correctly on zoom-out).
 */
function pxRadiusToMeters(map, center, radiusPx) {
  try {
    const screen = map.project(center);
    const edge = map.unproject([screen.x + radiusPx, screen.y]);
    return haversine(center, [edge.lng, edge.lat]);
  } catch {
    // Fallback on pathological camera states.
    return radiusPx * 100;
  }
}

/** Tap radius (px) — clicking inside this radius of the first vertex of
 *  a polygon draft closes it. Generous so touch users hit it easily. */
const POLY_CLOSE_PX = 14;

/** When any of these modifiers are pressed we yield to the underlying
 *  map shortcuts (ctrl/cmd+click = fly-to in `interactions.js`; shift =
 *  rotate gesture; alt is reserved for power-user variants). The active
 *  drawing tool simply ignores the event and lets MapLibre handle it. */
function hasReservedModifier(e) {
  const o = e?.originalEvent;
  if (!o) return false;
  return !!(o.ctrlKey || o.metaKey || o.shiftKey || o.altKey);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pxDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function queryAt(map, point, layers) {
  try {
    return map.queryRenderedFeatures(point, { layers }) || [];
  } catch {
    return [];
  }
}

/**
 * Hit-test the engine source. Prefers handles (vertex / midpoint) over
 * feature bodies so editing a selected feature feels natural.
 */
function hitAt(map, point) {
  const handles = queryAt(map, point, HANDLE_LAYERS);
  if (handles.length) return { kind: 'handle', feature: handles[0] };
  const body = queryAt(map, point, HIT_LAYERS);
  if (body.length) {
    // Prefer points over lines over fills (smaller / harder to hit).
    const ordered = body.slice().sort((a, b) => priority(a) - priority(b));
    return { kind: 'feature', feature: ordered[0] };
  }
  return null;
}

function priority(f) {
  const kind = f.properties?.kind;
  if (kind === 'marker') return 0;
  if (f.geometry?.type === 'Point') return 1;
  if (f.geometry?.type === 'LineString') return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Per-tool implementations.
// ---------------------------------------------------------------------------

/**
 * MARKER — drop a marker at the click point. Auto-snaps to a nearby
 * existing marker if the user is trying to retouch the same spot.
 */
const markerTool = {
  click(ctx, e) {
    const { map, state, prefs, addFeature, nextId } = ctx;
    if (state.drag) return; // already handling something
    if (hasReservedModifier(e)) return; // let map shortcuts win
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    // Snap-to-existing: if the click is within ~14 px of an existing
    // marker, just select it instead of creating a near-duplicate.
    const hit = hitAt(map, e.point);
    if (hit?.kind === 'feature' && hit.feature.properties?.kind === 'marker') {
      ctx.selectFeature(hit.feature.id);
      return;
    }

    addFeature({
      type: 'Feature',
      id: nextId('marker'),
      geometry: { type: 'Point', coordinates: lngLat },
      properties: {
        kind: 'marker',
        ...styleBag(prefs),
        radius: 8,
      },
    });
  },
};

/**
 * LINE — multi-click polyline authoring. Each click adds a vertex;
 * double-click or pressing Enter finishes; Esc cancels (handled by the
 * engine's keydown listener).
 */
const lineTool = {
  click(ctx, e) {
    if (hasReservedModifier(e)) return;
    const { state, prefs, addFeature, rerender, emit, nextId } = ctx;
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    if (!state.draft || state.draft.properties?.kind !== 'line-draft') {
      state.draft = {
        type: 'Feature',
        id: '__draft_line',
        geometry: { type: 'LineString', coordinates: [lngLat, lngLat] },
        properties: {
          kind: 'line-draft',
          ...styleBag(prefs),
          preview: false,
        },
      };
      emit('draft', 'line');
    } else {
      state.draft.geometry.coordinates.push(lngLat);
    }
    rerender();
  },

  mousemove(ctx, e) {
    const { state, rerender } = ctx;
    if (!state.draft || state.draft.properties?.kind !== 'line-draft') return;
    const coords = state.draft.geometry.coordinates;
    coords[coords.length - 1] = [e.lngLat.lng, e.lngLat.lat];
    rerender();
  },

  dblclick(ctx, e) {
    e.preventDefault();
    finishLine(ctx);
  },

  contextmenu(ctx, e) {
    e.preventDefault();
    finishLine(ctx);
  },
};

function finishLine(ctx) {
  const { state, addFeature, rerender, emit, nextId } = ctx;
  const draft = state.draft;
  if (!draft || draft.properties?.kind !== 'line-draft') return;
  const coords = draft.geometry.coordinates;
  // Drop the trailing rubber-band vertex (matches the current mouse
  // position, not an authored point).
  const finalCoords = coords.slice(0, -1);
  state.draft = null;
  emit('draft', null);
  if (finalCoords.length < 2) {
    rerender();
    return;
  }
  addFeature({
    type: 'Feature',
    id: nextId('line'),
    geometry: { type: 'LineString', coordinates: finalCoords },
    properties: {
      kind: 'line',
      color: draft.properties.color,
      fill: draft.properties.fill,
      weight: draft.properties.weight,
      opacity: draft.properties.opacity,
    },
  });
}

/**
 * POLYGON — same authoring flow as line, but auto-closes when the
 * user clicks near the first vertex, and the rubber-band closes the
 * ring back to the start.
 */
const polygonTool = {
  click(ctx, e) {
    if (hasReservedModifier(e)) return;
    const { map, state, prefs, rerender, emit } = ctx;
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    if (!state.draft || state.draft.properties?.kind !== 'polygon-draft') {
      state.draft = {
        type: 'Feature',
        id: '__draft_polygon',
        geometry: { type: 'LineString', coordinates: [lngLat, lngLat] },
        properties: {
          kind: 'polygon-draft',
          ...styleBag(prefs),
          preview: false,
        },
      };
      emit('draft', 'polygon');
      rerender();
      return;
    }

    const coords = state.draft.geometry.coordinates;
    // Check auto-close: distance from click pixel to the first vertex
    // pixel must be inside POLY_CLOSE_PX.
    const firstScreen = map.project(coords[0]);
    if (
      coords.length >= 3 &&
      pxDistance(firstScreen, e.point) <= POLY_CLOSE_PX
    ) {
      finishPolygon(ctx);
      return;
    }
    coords.push(lngLat);
    rerender();
  },

  mousemove(ctx, e) {
    const { state, rerender } = ctx;
    if (!state.draft || state.draft.properties?.kind !== 'polygon-draft') return;
    const coords = state.draft.geometry.coordinates;
    coords[coords.length - 1] = [e.lngLat.lng, e.lngLat.lat];
    rerender();
  },

  dblclick(ctx, e) {
    e.preventDefault();
    finishPolygon(ctx);
  },

  contextmenu(ctx, e) {
    e.preventDefault();
    finishPolygon(ctx);
  },
};

function finishPolygon(ctx) {
  const { state, addFeature, rerender, emit, nextId } = ctx;
  const draft = state.draft;
  if (!draft || draft.properties?.kind !== 'polygon-draft') return;
  const coords = draft.geometry.coordinates.slice(0, -1);
  state.draft = null;
  emit('draft', null);
  if (coords.length < 3) {
    rerender();
    return;
  }
  // Close the ring.
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

/**
 * SHAPE — single-click drops a template centred on the click point.
 * All shapes share one size knob (`prefs.shapeSize` in pixels) that
 * controls the on-screen radius / half-extent at the moment of
 * placement. Pixel-based sizing keeps every shape visually similar
 * regardless of zoom level — no more "rectangle in pixels, circle in
 * metres" inconsistency the old code had.
 */
const shapeTool = {
  click(ctx, e) {
    if (hasReservedModifier(e)) return;
    const { map, prefs, addFeature, nextId } = ctx;
    const center = [e.lngLat.lng, e.lngLat.lat];
    const sizePx = Math.max(20, Math.min(400, prefs.shapeSize ?? DEFAULT_SHAPE_SIZE_PX));
    const radiusM = pxRadiusToMeters(map, center, sizePx);

    let geometry;
    const kind = `shape-${prefs.shapeType}`;
    switch (prefs.shapeType) {
      case 'rectangle': {
        const screen = map.project(center);
        const halfW = sizePx * 1.3;
        const halfH = sizePx * 0.85;
        const tl = map.unproject([screen.x - halfW, screen.y - halfH]);
        const br = map.unproject([screen.x + halfW, screen.y + halfH]);
        geometry = makeRectangle([tl.lng, tl.lat], [br.lng, br.lat]);
        break;
      }
      case 'regular':
        geometry = makeRegularPolygon(center, radiusM, prefs.shapeSides ?? 6);
        break;
      case 'star':
        geometry = makeStar(center, radiusM, 5);
        break;
      case 'arrow': {
        // Arrow is a pair of features (shaft + head) committed
        // together; they share a group id so future editing can
        // recognise them as a unit.
        const screen = map.project(center);
        const halfLen = sizePx * 1.5;
        const start = map.unproject([screen.x - halfLen, screen.y]);
        const end = map.unproject([screen.x + halfLen, screen.y]);
        const arrow = makeArrow([start.lng, start.lat], [end.lng, end.lat]);
        const groupId = nextId('arrow');
        addFeature({
          type: 'Feature',
          id: nextId('arrow-shaft'),
          geometry: arrow.shaft,
          properties: {
            kind: 'arrow-shaft',
            ...styleBag(prefs),
            groupId,
          },
        }, { skipHistory: false });
        addFeature({
          type: 'Feature',
          id: nextId('arrow-head'),
          geometry: arrow.head,
          properties: {
            kind: 'arrow-head',
            ...styleBag(prefs),
            groupId,
          },
        }, { skipHistory: true });
        return;
      }
      case 'circle':
      default:
        geometry = makeCircle(center, radiusM);
        break;
    }

    addFeature({
      type: 'Feature',
      id: nextId(kind),
      geometry,
      properties: {
        kind,
        ...styleBag(prefs),
      },
    });
  },
};

// Pencil (free-draw) is NOT a map-event tool — the engine installs a
// dedicated PointerEvent listener directly on the map container when
// state.tool === 'pencil'. See createDrawEngine() for the lifecycle.
// This keeps touch devices working (MapLibre doesn't emit mouse*
// events on pure-touch input) and removes the pointerId filtering
// bug the old implementation suffered from.

/**
 * SELECT — click to select / clear, drag a vertex to edit, drag a body
 * to translate.
 */
const selectTool = {
  click(ctx, e) {
    const { map, state, selectFeature, clearSelection } = ctx;
    // If we ended a drag here, the click event still fires after
    // mouseup. Suppress this stray click so a drag doesn't also count
    // as a selection toggle.
    if (state.drag?.justEnded) {
      state.drag = null;
      return;
    }
    const hit = hitAt(map, e.point);
    if (!hit) {
      clearSelection();
      return;
    }
    if (hit.kind === 'handle' && hit.feature.properties?.kind === 'vertex-mid') {
      // Midpoint click — insert a vertex.
      const parentId = hit.feature.properties.parentId;
      const path = hit.feature.properties.path;
      const lngLat = hit.feature.geometry.coordinates;
      const parent = state.features.get(parentId);
      if (!parent) return;
      ctx.pushHistory();
      const next = insertVertex(parent, { path, op: 'insert' }, lngLat);
      ctx.updateFeature(parentId, next, { skipHistory: true });
      return;
    }
    if (hit.kind === 'feature') {
      selectFeature(hit.feature.id);
    }
  },

  mousedown(ctx, e) {
    const { map, state } = ctx;
    if (e.originalEvent?.button !== 0 && e.originalEvent?.button !== undefined) return;
    const hit = hitAt(map, e.point);
    if (!hit) return;

    // Handle drag: vertex.
    if (hit.kind === 'handle' && hit.feature.properties?.kind === 'vertex') {
      e.preventDefault();
      const parentId = hit.feature.properties.parentId;
      const path = hit.feature.properties.path;
      state.drag = {
        kind: 'vertex',
        parentId,
        path,
        start: { x: e.point.x, y: e.point.y },
        moved: false,
      };
      map.dragPan?.disable?.();
      ctx.pushHistory();
      return;
    }
    // Body drag: translate the feature.
    if (hit.kind === 'feature') {
      e.preventDefault();
      ctx.selectFeature(hit.feature.id, { silent: true });
      state.drag = {
        kind: 'translate',
        parentId: hit.feature.id,
        start: { x: e.point.x, y: e.point.y },
        lastLngLat: [e.lngLat.lng, e.lngLat.lat],
        moved: false,
      };
      map.dragPan?.disable?.();
      ctx.pushHistory();
    }
  },

  mousemove(ctx, e) {
    const { map, state } = ctx;
    if (!state.drag) return;
    if (state.drag.kind === 'vertex') {
      const dPx = pxDistance(state.drag.start, e.point);
      if (dPx < CLICK_SLOP_PX && !state.drag.moved) return;
      state.drag.moved = true;
      const parent = state.features.get(state.drag.parentId);
      if (!parent) return;
      const next = updateVertex(parent, { path: state.drag.path }, [e.lngLat.lng, e.lngLat.lat]);
      ctx.updateFeature(state.drag.parentId, next, { skipHistory: true });
    } else if (state.drag.kind === 'translate') {
      const dPx = pxDistance(state.drag.start, e.point);
      if (dPx < CLICK_SLOP_PX && !state.drag.moved) return;
      state.drag.moved = true;
      const parent = state.features.get(state.drag.parentId);
      if (!parent) return;
      const dLng = e.lngLat.lng - state.drag.lastLngLat[0];
      const dLat = e.lngLat.lat - state.drag.lastLngLat[1];
      state.drag.lastLngLat = [e.lngLat.lng, e.lngLat.lat];
      const next = translateFeature(parent, dLng, dLat);
      ctx.updateFeature(state.drag.parentId, next, { skipHistory: true });
    }
  },

  mouseup(ctx, e) {
    const { map, state } = ctx;
    if (!state.drag) return;
    map.dragPan?.enable?.();
    if (state.drag.moved) {
      // Mark that a drag just ended so the synthetic click doesn't
      // toggle selection.
      state.drag.justEnded = true;
      // Clear the drag flag on the next tick so a real click after the
      // drag still works.
      setTimeout(() => {
        if (state.drag?.justEnded) state.drag = null;
      }, 50);
    } else {
      state.drag = null;
    }
  },
};

// ---------------------------------------------------------------------------
// Registry + dispatcher.
// ---------------------------------------------------------------------------

const TOOLS = {
  select: selectTool,
  marker: markerTool,
  line: lineTool,
  polygon: polygonTool,
  shape: shapeTool,
  // pencil has no map-event handlers — see note above.
};

/**
 * Public dispatcher invoked by the engine on every map event. Looks up
 * the active tool's handler for `eventName` and runs it. When the
 * pencil tool is active every map event is ignored here — the
 * dedicated PointerEvent listener in engine.js handles strokes.
 *
 * @param {string} eventName
 * @param {object} ctx
 * @param {object} e
 */
export function runTool(eventName, ctx, e) {
  const tool = ctx.state.tool;
  const t = TOOLS[tool];
  if (!t) return;
  t[eventName]?.(ctx, e);
}
