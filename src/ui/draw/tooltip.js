/**
 * Floating distance tooltip — pairwise marker readout.
 *
 * Renders as an absolutely-positioned glass pill inside the map
 * container. The drawing engine emits a `markerTooltip` event when
 * the user clicks any marker; we position the pill above the click
 * point and fade it in. A second event with `{ hide: true }` (empty
 * map click, measure toggle off, fewer than two markers, etc.)
 * fades it out.
 *
 * Reduce-motion
 * -------------
 * When the user has `prefers-reduced-motion: reduce` set, we swap
 * the cross-fade for an instant show/hide — same final state, no
 * animation. The CSS does the actual work via a media query; this
 * module just toggles the `data-state` attribute the stylesheet
 * keys off.
 *
 * Lifecycle
 * ---------
 * The tooltip element is mounted once into the map container and
 * stays there for the page lifetime. Hiding is a `data-state="hidden"`
 * attribute swap (CSS handles opacity / pointer-events), not a DOM
 * remove — that way the element keeps its computed style and the
 * fade is jank-free.
 */

const HIDE_DELAY_MS = 4000;

/**
 * Mount the floating tooltip on the map container and subscribe to
 * the engine's `markerTooltip` event.
 *
 * @param {object} opts
 * @param {object} opts.engine      Handle from `createDrawEngine`.
 * @param {maplibregl.Map} opts.map MapLibre instance owning the
 *                                  container the tooltip overlays.
 * @returns {() => void} Unmount function — removes the listener and
 *                       the DOM element. Idempotent.
 */
export function mountMeasureTooltip({ engine, map }) {
  if (!engine || !map) return () => {};
  const container = map.getContainer?.();
  if (!container) return () => {};

  // The container needs a positioning context for the absolutely-
  // positioned tooltip — MapLibre already gives it `position:
  // relative`, but we set it defensively here so the tooltip works
  // even on hosts that recompute the container's positioning.
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const el = document.createElement('div');
  el.className = 'cart-measure-tooltip';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.dataset.state = 'hidden';
  el.innerHTML = `<span class="cart-measure-tooltip-label" data-ctl="label">—</span>`;
  container.appendChild(el);

  const labelNode = el.querySelector('[data-ctl="label"]');

  let hideTimer = 0;
  const armAutoHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hide();
    }, HIDE_DELAY_MS);
  };

  const show = (payload) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (labelNode) labelNode.textContent = payload.label;
    // Position above the click point, centred horizontally. The CSS
    // applies a small upward translate so the pill sits clear of
    // the marker dot. We clamp the X coordinate inside the
    // container so the pill never spills off-screen on edge taps.
    const rect = container.getBoundingClientRect();
    const w = rect.width || container.clientWidth || 0;
    const h = rect.height || container.clientHeight || 0;
    // The offsetWidth read forces a layout but we already need it
    // for clamping; this is a cheap one-time hit per tooltip show.
    const elW = el.offsetWidth || 80;
    const elH = el.offsetHeight || 32;
    const margin = 8;
    let x = payload.pointPx.x;
    let y = payload.pointPx.y - 18; // sits above the dot
    x = Math.max(elW / 2 + margin, Math.min(w - elW / 2 - margin, x));
    // If the tooltip would clip the top edge, flip below the marker.
    if (y - elH < margin) {
      y = payload.pointPx.y + 26;
      el.dataset.placement = 'below';
    } else {
      el.dataset.placement = 'above';
    }
    y = Math.max(margin + elH / 2, Math.min(h - margin - elH / 2, y));
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    el.dataset.state = 'visible';
    armAutoHide();
  };

  const hide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    el.dataset.state = 'hidden';
  };

  const offTooltip = engine.on('markerTooltip', (payload) => {
    if (!payload || payload.hide) {
      hide();
      return;
    }
    if (!payload.label || !payload.pointPx) {
      hide();
      return;
    }
    show(payload);
  });

  // If the map gets panned/zoomed/rotated the screen position the
  // tooltip refers to is stale — hide rather than recompute. The
  // tooltip is a discrete on-tap affordance, not a continuous
  // overlay, so dropping it is the right behaviour.
  const onCameraMove = () => hide();
  map.on('movestart', onCameraMove);

  return () => {
    offTooltip();
    map.off('movestart', onCameraMove);
    if (hideTimer) clearTimeout(hideTimer);
    if (el.parentNode) el.parentNode.removeChild(el);
  };
}
