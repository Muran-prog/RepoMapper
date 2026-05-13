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
 * Create a free-draw recorder bound to a MapLibre map. The caller is
 * responsible for calling `start()` on pointerdown and `commit()` on
 * pointerup; everything in between is handled automatically.
 *
 * The recorder briefly disables map panning during the stroke so the
 * pen tracks the finger / mouse instead of dragging the map.
 *
 * @param {maplibregl.Map} map
 * @param {object} [opts]
 * @param {number} [opts.epsilonPx=2.2]   RDP tolerance (pixels).
 * @param {boolean} [opts.smooth=true]    Run a Chaikin pass after RDP.
 * @param {number} [opts.minSamples=3]    Discard strokes shorter than this.
 * @param {function(Array<[number, number]>):void} [opts.onPreview]
 *        Called with screen-pixel samples on every animation frame so the
 *        UI can paint an in-flight preview (e.g. a temporary canvas).
 */
export function createFreeDrawRecorder(map, opts = {}) {
  const {
    epsilonPx = 2.2,
    smooth = true,
    minSamples = 3,
    onPreview,
  } = opts;

  /** @type {Array<[number, number]>} */
  let samples = [];
  let active = false;
  let pointerId = null;
  let rafId = null;
  let pendingFlush = false;
  const container = map.getContainer();

  const localCoords = (e) => {
    const rect = container.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const scheduleFlush = () => {
    if (pendingFlush) return;
    pendingFlush = true;
    rafId = requestAnimationFrame(() => {
      pendingFlush = false;
      onPreview?.(samples);
    });
  };

  const onPointerMove = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    e.preventDefault();
    const p = localCoords(e);
    const last = samples[samples.length - 1];
    // Dedup adjacent samples that landed in the same pixel.
    if (!last || Math.abs(last[0] - p[0]) > 0.5 || Math.abs(last[1] - p[1]) > 0.5) {
      samples.push(p);
      scheduleFlush();
    }
  };

  const onPointerEndCapture = (e) => {
    if (!active || (pointerId != null && e.pointerId !== pointerId)) return;
    // Caller drives the actual commit via `commit()` — we just stop
    // listening here. The recorder still owns `active` so a stray
    // pointermove after up doesn't keep appending samples.
    cleanup();
  };

  const cleanup = () => {
    container.removeEventListener('pointermove', onPointerMove, { capture: true });
    container.removeEventListener('pointerup', onPointerEndCapture, { capture: true });
    container.removeEventListener('pointercancel', onPointerEndCapture, { capture: true });
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    pendingFlush = false;
  };

  return {
    /** True while a stroke is being recorded. */
    isActive: () => active,

    /**
     * Begin recording. Disables map panning for the duration of the
     * gesture so the pen tracks the pointer.
     */
    start(e) {
      if (active) return;
      active = true;
      pointerId = e.pointerId ?? null;
      samples = [localCoords(e)];
      // Suppress map gestures while drawing. Each is checked to avoid
      // throwing on builds that haven't initialised them yet.
      map.dragPan?.disable?.();
      map.scrollZoom?.disable?.();
      map.doubleClickZoom?.disable?.();
      map.touchPitch?.disable?.();
      map.touchZoomRotate?.disable?.();
      container.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
      container.addEventListener('pointerup', onPointerEndCapture, { capture: true });
      container.addEventListener('pointercancel', onPointerEndCapture, { capture: true });
    },

    /**
     * Cancel an in-flight stroke without committing it. Re-enables the
     * map gestures.
     */
    cancel() {
      cleanup();
      active = false;
      pointerId = null;
      samples = [];
      this.restore();
    },

    /**
     * Commit the current stroke. Returns the simplified geographic
     * `LineString` geometry or `null` if the stroke was too short.
     */
    commit() {
      cleanup();
      active = false;
      const pts = samples;
      samples = [];
      this.restore();
      if (pts.length < minSamples) return null;
      let simplified = rdp(pts, epsilonPx);
      if (smooth) {
        simplified = chaikin(simplified);
      }
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
    },

    /** Re-enable map gestures suppressed in `start()`. */
    restore() {
      map.dragPan?.enable?.();
      map.scrollZoom?.enable?.();
      map.doubleClickZoom?.enable?.();
      map.touchPitch?.enable?.();
      map.touchZoomRotate?.enable?.();
    },

    /** Drop all listeners — call when the engine is torn down. */
    dispose() {
      cleanup();
      this.restore();
    },
  };
}
