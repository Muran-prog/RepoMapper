/**
 * Free-draw recorder.
 *
 * Captures a pointer trail across the map, then simplifies it with the
 * Ramer-Douglas-Peucker (RDP) algorithm so the persisted geometry is
 * short and clean while still tracing what the user drew.
 *
 * Two coordinate spaces are involved:
 *
 *   • Capture happens in *screen pixels* against the map's container.
 *     We record `(x, y, t)` triples so the RDP tolerance can be applied
 *     in pixels — visual fidelity is what matters to the user, not
 *     metres.
 *
 *   • On commit we unproject every retained sample to `[lng, lat]` so
 *     the feature persists in geographic coordinates and remains valid
 *     under pan/zoom.
 *
 * Smoothing
 * ---------
 * After RDP we optionally run a Chaikin pass to round off corners. The
 * combination — simplify, then smooth — produces a hand-drawn look at
 * roughly 20–40 vertices per typical stroke, which is friendly for
 * MapLibre's GPU tessellator.
 *
 * Performance
 * -----------
 * We coalesce pointermove events with `requestAnimationFrame` so a
 * fast finger doesn't queue hundreds of redundant samples per frame.
 * RDP is O(n log n) average — fine for the ~500-sample strokes a single
 * gesture produces.
 */

/**
 * Perpendicular squared distance from `p` to the segment `[a, b]`.
 * All inputs are 2D screen pixel pairs.
 */
function distSqToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return ex * ex + ey * ey;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  const ex = p[0] - projX;
  const ey = p[1] - projY;
  return ex * ex + ey * ey;
}

/**
 * Ramer-Douglas-Peucker simplification. Iterative implementation that
 * avoids the recursion depth blow-up of the naive version on long
 * strokes.
 *
 * @param {Array<[number, number]>} pts Screen-pixel polyline.
 * @param {number} epsilon              Tolerance in pixels.
 * @returns {Array<[number, number]>}
 */
export function rdp(pts, epsilon = 2) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const eps2 = epsilon * epsilon;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  /** Pair stack: [start, end] indices to consider. */
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distSqToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxI !== -1 && maxD > eps2) {
      keep[maxI] = 1;
      stack.push([s, maxI]);
      stack.push([maxI, e]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out;
}

/**
 * One pass of Chaikin's corner-cutting algorithm. Each segment is
 * replaced by two points at 1/4 and 3/4 of the way along it, which
 * rounds off sharp corners without inflating vertex counts too much.
 *
 * Endpoints are preserved so the smoothed stroke still starts/ends at
 * the exact pen-down / pen-up location.
 *
 * @param {Array<[number, number]>} pts
 * @returns {Array<[number, number]>}
 */
export function chaikin(pts) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
    out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Create a free-draw recorder bound to a MapLibre map.
 *
 * The recorder owns its own native PointerEvent listeners on the map
 * container. The engine calls `attach()` when the pencil tool becomes
 * active and `detach()` when it switches away. No routing through
 * MapLibre's `mousedown/mousemove/mouseup` is used — MapLibre only
 * synthesises those for mouse input, so touch devices would never
 * fire them; and even for mouse, MapLibre's event objects are not
 * PointerEvents so a `pointerId` filter on the move stream silently
 * dropped every sample.
 *
 * During an in-flight stroke the recorder disables map gestures so
 * the pen tracks the finger / mouse instead of dragging the map; on
 * commit/cancel it restores them.
 *
 * @param {maplibregl.Map} map
 * @param {object} [opts]
 * @param {number} [opts.epsilonPx=2.2]   RDP tolerance (pixels).
 * @param {boolean} [opts.smooth=true]    Run a Chaikin pass after RDP.
 * @param {number} [opts.minSamples=3]    Discard strokes shorter than this.
 * @param {function(Array<[number, number]>):void} [opts.onPreview]
 *        Called with screen-pixel samples on every animation frame so
 *        the caller can draw a live preview.
 * @param {function(GeoJSON.LineString|null):void} [opts.onCommit]
 *        Called on pointerup/cancel with the simplified geographic
 *        LineString, or `null` if the stroke was too short / cancelled.
 */
export function createFreeDrawRecorder(map, opts = {}) {
  const {
    epsilonPx = 2.2,
    smooth = true,
    minSamples = 3,
    onPreview,
    onCommit,
  } = opts;

  const container = map.getContainer();

  /** @type {Array<[number, number]>} */
  let samples = [];
  let active = false;
  let pointerId = null;
  let rafId = null;
  let pendingFlush = false;
  let attached = false;

  const localCoords = (e) => {
    const rect = container.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const scheduleFlush = () => {
    if (pendingFlush) return;
    pendingFlush = true;
    rafId = requestAnimationFrame(() => {
      pendingFlush = false;
      rafId = null;
      onPreview?.(samples);
    });
  };

  const suspendMapGestures = () => {
    map.dragPan?.disable?.();
    map.scrollZoom?.disable?.();
    map.doubleClickZoom?.disable?.();
    map.touchPitch?.disable?.();
    map.touchZoomRotate?.disable?.();
  };

  const restoreMapGestures = () => {
    map.dragPan?.enable?.();
    map.scrollZoom?.enable?.();
    map.doubleClickZoom?.enable?.();
    map.touchPitch?.enable?.();
    map.touchZoomRotate?.enable?.();
  };

  const resetStroke = () => {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    pendingFlush = false;
    samples = [];
    active = false;
    pointerId = null;
  };

  const finalise = (pts) => {
    if (pts.length < minSamples) return null;
    let simplified = rdp(pts, epsilonPx);
    if (smooth) simplified = chaikin(simplified);
    const coords = simplified
      .map(([x, y]) => {
        try {
          const ll = map.unproject([x, y]);
          return [ll.lng, ll.lat];
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (coords.length < 2) return null;
    return { type: 'LineString', coordinates: coords };
  };

  // Pointer event handlers — attached to the map container directly.
  const onPointerDown = (e) => {
    if (active) return;
    // Only the primary button for mouse; touch/pen always report
    // button === 0 so this is a safe filter across input types.
    if (e.button != null && e.button !== 0) return;

    e.preventDefault();
    // Capture the pointer so we keep receiving move/up events even if
    // the finger/mouse drifts outside the map container.
    try { container.setPointerCapture(e.pointerId); } catch { /* unsupported */ }

    active = true;
    pointerId = e.pointerId;
    samples = [localCoords(e)];
    suspendMapGestures();
    scheduleFlush();
  };

  const onPointerMove = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    e.preventDefault();
    const p = localCoords(e);
    const last = samples[samples.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 0.5 || Math.abs(last[1] - p[1]) > 0.5) {
      samples.push(p);
      scheduleFlush();
    }
  };

  const onPointerUp = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    e.preventDefault();
    try { container.releasePointerCapture(pointerId); } catch { /* */ }
    const pts = samples.slice();
    resetStroke();
    restoreMapGestures();
    onCommit?.(finalise(pts));
  };

  const onPointerCancel = (e) => {
    if (!active) return;
    if (e.pointerId != null && e.pointerId !== pointerId) return;
    try { container.releasePointerCapture(pointerId); } catch { /* */ }
    resetStroke();
    restoreMapGestures();
    onCommit?.(null);
  };

  // Prevent the browser from turning a touch-drag into a page scroll
  // on iOS while the pencil is armed. We set `touch-action: none` on
  // the container via the attach flag below.

  return {
    /** True while a stroke is being recorded. */
    isActive: () => active,

    /**
     * Start listening for pointer events on the map container.
     * Idempotent — safe to call repeatedly.
     */
    attach() {
      if (attached) return;
      attached = true;
      container.addEventListener('pointerdown', onPointerDown, { passive: false });
      container.addEventListener('pointermove', onPointerMove, { passive: false });
      container.addEventListener('pointerup', onPointerUp, { passive: false });
      container.addEventListener('pointercancel', onPointerCancel, { passive: false });
      // Prevent native touch gestures (scroll, pinch-to-zoom) from
      // hijacking the stroke on iOS / Android.
      container.dataset.cartPencil = '1';
    },

    /**
     * Stop listening and cancel any in-flight stroke. Idempotent.
     */
    detach() {
      if (!attached) return;
      attached = false;
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
      delete container.dataset.cartPencil;
      if (active) {
        try { container.releasePointerCapture(pointerId); } catch { /* */ }
        resetStroke();
        restoreMapGestures();
      }
    },

    /** Cancel an in-flight stroke without committing. */
    cancel() {
      if (!active) return;
      try { container.releasePointerCapture(pointerId); } catch { /* */ }
      resetStroke();
      restoreMapGestures();
    },

    /** Drop all listeners — call when the engine is torn down. */
    dispose() {
      this.detach();
    },
  };
}
