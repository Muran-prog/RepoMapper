/**
 * Eraser — pointer-driven feature destroyer.
 *
 * Two layers, kept deliberately separate so the engine can wire them
 * up without leaking DOM concerns into geometry:
 *
 *   1. `createEraserRecorder` — a thin pointer-event listener bound to
 *      the map container. It tracks the cursor position, paints a
 *      circular DOM overlay so the user sees the erase radius, and
 *      while the primary button is held it streams `(lng, lat)` ticks
 *      to the engine. Same lifecycle pattern as the freedraw recorder
 *      (attach / detach / dispose) so the engine can swap them in/out
 *      as the active tool changes.
 *
 *   2. `eraseFeatureInRadius` — pure geometry. Given a feature, a
 *      centre `[lng, lat]` and a pixel radius, returns either
 *      `'unchanged'` or `{ remove: true, replace: Feature[] }` so the
 *      engine can remove the original and splice the surviving
 *      fragments back into `state.features`.
 *
 * Pixel-space hit-testing
 * -----------------------
 * The eraser radius is specified in PIXELS at the current zoom — one
 * 30 px circle is one 30 px circle whether the user is staring at the
 * Carpathians at z14 or at the whole continent at z4. To keep the
 * spec consistent we project every candidate vertex through MapLibre's
 * `project(lngLat) → screen px` once per erase tick and run all the
 * "is this inside the circle?" maths in screen space. That naturally
 * handles tilted / rotated cameras: the eraser is always a circle on
 * the SCREEN, never an ellipse on the ground.
 *
 * Partial line erasure
 * --------------------
 * For LineStrings (lines, polylines, pencil strokes, auto-generated
 * connections) the erase pass walks segment-by-segment, finds where
 * each segment enters / exits the eraser disk via the standard
 * line-circle quadratic, and emits the OUTSIDE portions as new pieces.
 * A line crossed by a small eraser becomes two shorter lines; a line
 * grazed at one tip just gets shortened.
 *
 * Polygon erasure is whole-feature (delete on touch) — partial
 * topology is non-trivial (hole insertion, ring splitting, fill
 * recomputation) and not part of the user-facing spec.
 */

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------

/** Squared 2D distance — avoids sqrt in hot paths. */
function sqDist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** Linear interpolation in lng/lat space. Good enough at eraser scale. */
function lerpLL(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Project a `[lng, lat]` to map container pixel coords, or null on error. */
function projectLL(map, lngLat) {
  try {
    const p = map.project(lngLat);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return [p.x, p.y];
  } catch {
    return null;
  }
}

/**
 * Solve the quadratic |a + t·(b - a) - c|² = r² for t-values in (0, 1)
 * — i.e. interior intersections between the parametric segment AB and
 * the circle of centre C, radius R. Returns 0, 1 or 2 t-values sorted
 * ascending. Endpoints are handled by the caller via aIn/bIn flags.
 */
function segmentCircleTs(a, b, c, r) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const A = dx * dx + dy * dy;
  if (A < 1e-12) return [];
  const fx = a[0] - c[0];
  const fy = a[1] - c[1];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sd = Math.sqrt(disc);
  const t1 = (-B - sd) / (2 * A);
  const t2 = (-B + sd) / (2 * A);
  const out = [];
  const EPS = 1e-6;
  if (t1 > EPS && t1 < 1 - EPS) out.push(t1);
  if (t2 > EPS && t2 < 1 - EPS && Math.abs(t2 - t1) > EPS) out.push(t2);
  return out;
}

/**
 * Even-odd ray cast — point-in-ring in pixel space. Used to catch the
 * "the eraser is inside a big polygon's fill" case without relying on
 * vertex / edge proximity.
 */
function pointInRingPx(point, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const cross =
      ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-12) + xi);
    if (cross) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------
// Per-geometry erase passes
// ---------------------------------------------------------------------

/** Apply the eraser to a single LineString. */
function eraseLineString(feature, coords, cPx, radiusPx, map) {
  if (!Array.isArray(coords) || coords.length < 2) return 'unchanged';
  const r2 = radiusPx * radiusPx;
  const vertsPx = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    const p = projectLL(map, coords[i]);
    if (!p) return 'unchanged';
    vertsPx[i] = p;
  }

  let touched = false;
  const pieces = [];
  /** @type {Array<[number, number]> | null} */
  let current = null;

  const flushCurrent = () => {
    if (current && current.length >= 2) pieces.push(current);
    current = null;
  };
  const extendCurrent = (pt) => {
    if (!current) {
      current = [pt.slice()];
      return;
    }
    const last = current[current.length - 1];
    if (Math.abs(last[0] - pt[0]) > 1e-12 || Math.abs(last[1] - pt[1]) > 1e-12) {
      current.push(pt.slice());
    }
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const a = vertsPx[i];
    const b = vertsPx[i + 1];
    const aLL = coords[i];
    const bLL = coords[i + 1];
    const aIn = sqDist(a, cPx) <= r2;
    const bIn = sqDist(b, cPx) <= r2;
    const ts = segmentCircleTs(a, b, cPx, radiusPx);

    // Whole segment outside the disk — keep entirely.
    if (!aIn && !bIn && ts.length === 0) {
      extendCurrent(aLL);
      extendCurrent(bLL);
      continue;
    }
    // Whole segment inside the disk — drop entirely.
    if (aIn && bIn && ts.length === 0) {
      touched = true;
      flushCurrent();
      continue;
    }

    // Mixed: piecewise. Build cut t-values, then keep / drop each
    // sub-interval based on its midpoint's in/out status.
    touched = true;
    const cuts = [0];
    for (const t of ts) {
      if (t > cuts[cuts.length - 1] + 1e-9 && t < 1 - 1e-9) cuts.push(t);
    }
    cuts.push(1);
    for (let k = 0; k < cuts.length - 1; k++) {
      const t0 = cuts[k];
      const t1 = cuts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      const midPx = [a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm];
      const midIn = sqDist(midPx, cPx) <= r2;
      const sub0 = t0 === 0 ? aLL : lerpLL(aLL, bLL, t0);
      const sub1 = t1 === 1 ? bLL : lerpLL(aLL, bLL, t1);
      if (midIn) {
        flushCurrent();
      } else {
        extendCurrent(sub0);
        extendCurrent(sub1);
      }
    }
  }
  flushCurrent();

  if (!touched) return 'unchanged';

  const baseProps = feature.properties || {};
  const replace = pieces
    .filter((p) => p.length >= 2)
    .map((p) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: p },
      properties: { ...baseProps },
    }));
  return { remove: true, replace };
}

/** Apply the eraser to a single Polygon. Whole-feature delete on touch. */
function erasePolygon(feature, ringsLL, cPx, radiusPx, map) {
  if (!Array.isArray(ringsLL) || ringsLL.length === 0) return 'unchanged';
  const r2 = radiusPx * radiusPx;

  // Vertex hit — cheapest test, do it first.
  for (const ring of ringsLL) {
    if (!Array.isArray(ring)) continue;
    for (const v of ring) {
      const p = projectLL(map, v);
      if (!p) continue;
      if (sqDist(p, cPx) <= r2) return { remove: true, replace: [] };
    }
  }
  // Edge intersection.
  for (const ring of ringsLL) {
    if (!Array.isArray(ring)) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = projectLL(map, ring[i]);
      const b = projectLL(map, ring[i + 1]);
      if (!a || !b) continue;
      if (segmentCircleTs(a, b, cPx, radiusPx).length > 0) {
        return { remove: true, replace: [] };
      }
    }
  }
  // Eraser sits entirely inside the outer ring's fill.
  const outer = ringsLL[0];
  if (Array.isArray(outer) && outer.length >= 3) {
    const outerPx = [];
    for (const c of outer) {
      const p = projectLL(map, c);
      if (p) outerPx.push(p);
    }
    if (outerPx.length >= 3 && pointInRingPx(cPx, outerPx)) {
      return { remove: true, replace: [] };
    }
  }
  return 'unchanged';
}

// ---------------------------------------------------------------------
// Public: per-feature erase
// ---------------------------------------------------------------------

/**
 * Run an erase pass on a single feature. Pure — does not touch any
 * engine state. The caller must remove the original and add any
 * replacement features.
 *
 * @param {GeoJSON.Feature} feature
 * @param {[number, number]} centerLngLat
 * @param {number} radiusPx
 * @param {maplibregl.Map} map
 * @returns {'unchanged' | { remove: true, replace: GeoJSON.Feature[] }}
 */
export function eraseFeatureInRadius(feature, centerLngLat, radiusPx, map) {
  const g = feature?.geometry;
  if (!g) return 'unchanged';
  const cPx = projectLL(map, centerLngLat);
  if (!cPx) return 'unchanged';

  switch (g.type) {
    case 'Point': {
      const p = projectLL(map, g.coordinates);
      if (!p) return 'unchanged';
      if (sqDist(p, cPx) <= radiusPx * radiusPx) {
        return { remove: true, replace: [] };
      }
      return 'unchanged';
    }
    case 'LineString':
      return eraseLineString(feature, g.coordinates, cPx, radiusPx, map);
    case 'Polygon':
      return erasePolygon(feature, g.coordinates, cPx, radiusPx, map);
    default:
      return 'unchanged';
  }
}

// ---------------------------------------------------------------------
// Pointer recorder
// ---------------------------------------------------------------------

/**
 * Bind native PointerEvents on the map container and stream erase ticks.
 *
 * @param {maplibregl.Map} map
 * @param {object} opts
 * @param {() => number} opts.getRadius     Returns the eraser radius (px).
 * @param {([number, number]) => void} [opts.onErase]
 *        Called with `[lng, lat]` once per pointerdown and per move tick
 *        while the primary button is held.
 * @param {() => void} [opts.onStrokeStart] Called on the leading edge of
 *        a drag — engines typically push history here.
 * @param {() => void} [opts.onStrokeEnd]   Called on pointerup / cancel.
 */
export function createEraserRecorder(map, opts = {}) {
  const { getRadius, onErase, onStrokeStart, onStrokeEnd } = opts;
  const container = map.getContainer();

  let attached = false;
  let active = false;
  let pointerId = null;
  let lastX = -1;
  let lastY = -1;
  /** @type {HTMLElement | null} */
  let cursor = null;

  const localCoords = (e) => {
    const rect = container.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const ensureCursor = () => {
    if (cursor) return cursor;
    cursor = document.createElement('div');
    cursor.className = 'cart-eraser-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.position = 'absolute';
    cursor.style.pointerEvents = 'none';
    cursor.style.left = '0';
    cursor.style.top = '0';
    cursor.style.transform = 'translate(-9999px, -9999px)';
    container.appendChild(cursor);
    return cursor;
  };

  const updateCursor = (x, y) => {
    if (!cursor) return;
    const r = Math.max(2, Number(getRadius?.() ?? 30));
    cursor.style.width = `${r * 2}px`;
    cursor.style.height = `${r * 2}px`;
    cursor.style.transform = `translate(${x - r}px, ${y - r}px)`;
    lastX = x;
    lastY = y;
  };

  const hideCursor = () => {
    if (!cursor) return;
    cursor.style.transform = 'translate(-9999px, -9999px)';
    lastX = -1;
    lastY = -1;
  };

  const suspendGestures = () => {
    map.dragPan?.disable?.();
    map.scrollZoom?.disable?.();
    map.doubleClickZoom?.disable?.();
    map.touchPitch?.disable?.();
    map.touchZoomRotate?.disable?.();
  };
  const restoreGestures = () => {
    map.dragPan?.enable?.();
    map.scrollZoom?.enable?.();
    map.doubleClickZoom?.enable?.();
    map.touchPitch?.enable?.();
    map.touchZoomRotate?.enable?.();
  };

  const dispatchErase = (x, y) => {
    try {
      const ll = map.unproject([x, y]);
      onErase?.([ll.lng, ll.lat]);
    } catch { /* unproject can throw on style rebuild — ignore */ }
  };

  const onPointerDown = (e) => {
    if (active) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    try { container.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    active = true;
    pointerId = e.pointerId;
    suspendGestures();
    onStrokeStart?.();
    const [x, y] = localCoords(e);
    updateCursor(x, y);
    dispatchErase(x, y);
  };

  const onPointerMove = (e) => {
    const [x, y] = localCoords(e);
    updateCursor(x, y);
    if (!active || e.pointerId !== pointerId) return;
    e.preventDefault();
    dispatchErase(x, y);
  };

  const endStroke = (e) => {
    if (!active) return;
    if (e && e.pointerId != null && e.pointerId !== pointerId) return;
    try { container.releasePointerCapture(pointerId); } catch { /* */ }
    active = false;
    pointerId = null;
    restoreGestures();
    onStrokeEnd?.();
  };

  const onPointerUp = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    e.preventDefault();
    endStroke(e);
  };

  const onPointerCancel = (e) => endStroke(e);
  const onPointerLeave = () => {
    // Hide the preview when the cursor leaves the map; an in-flight
    // stroke keeps going thanks to setPointerCapture, but the preview
    // doesn't help while the cursor is off-screen.
    if (!active) hideCursor();
  };

  return {
    /** True while the user is mid-drag. */
    isActive: () => active,

    attach() {
      if (attached) return;
      attached = true;
      ensureCursor();
      container.dataset.cartEraser = '1';
      container.addEventListener('pointerdown', onPointerDown, { passive: false });
      container.addEventListener('pointermove', onPointerMove, { passive: false });
      container.addEventListener('pointerup', onPointerUp, { passive: false });
      container.addEventListener('pointercancel', onPointerCancel, { passive: false });
      container.addEventListener('pointerleave', onPointerLeave);
    },

    detach() {
      if (!attached) return;
      attached = false;
      delete container.dataset.cartEraser;
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
      container.removeEventListener('pointerleave', onPointerLeave);
      if (active) {
        try { container.releasePointerCapture(pointerId); } catch { /* */ }
        active = false;
        pointerId = null;
        restoreGestures();
      }
      if (cursor) {
        cursor.remove();
        cursor = null;
      }
    },

    /**
     * Re-apply the cursor size after the user adjusts the eraser
     * slider while hovering. Cheap — the next pointermove would do the
     * same, but calling it on prefs change keeps the preview snappy
     * even when the cursor is held still.
     */
    syncRadius() {
      if (!cursor || lastX < 0) return;
      updateCursor(lastX, lastY);
    },

    dispose() { this.detach(); },
  };
}
