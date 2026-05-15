/**
 * Floating "detach" tooltip for lines.
 *
 * Appears when the user taps any committed line (in any tool mode).
 * Shows a single "Открепить" button that removes the tapped line
 * without affecting any other features. Hides on camera move, empty
 * tap, or after a timeout.
 */

const HIDE_DELAY_MS = 5000;

/**
 * Mount the line-action tooltip on the map container and subscribe to
 * the engine's `lineAction` event.
 *
 * @param {object} opts
 * @param {object} opts.engine      Handle from `createDrawEngine`.
 * @param {maplibregl.Map} opts.map MapLibre instance.
 * @returns {() => void} Unmount function.
 */
export function mountLineActionTooltip({ engine, map }) {
  if (!engine || !map) return () => {};
  const container = map.getContainer?.();
  if (!container) return () => {};

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const el = document.createElement('div');
  el.className = 'cart-line-action-tooltip';
  el.setAttribute('role', 'status');
  el.dataset.state = 'hidden';
  el.innerHTML = `<button class="cart-line-action-btn" type="button" data-ctl="detach">Открепить</button>`;
  container.appendChild(el);

  const btn = el.querySelector('[data-ctl="detach"]');
  let activeLineId = null;
  let activeSegIdx = null;
  let hideTimer = 0;
  let showTimestamp = 0;

  const armAutoHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => hide(), HIDE_DELAY_MS);
  };

  const show = (payload) => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    activeLineId = payload.lineId;
    showTimestamp = Date.now();

    const rect = container.getBoundingClientRect();
    const w = rect.width || container.clientWidth || 0;
    const h = rect.height || container.clientHeight || 0;
    const elW = el.offsetWidth || 90;
    const elH = el.offsetHeight || 36;
    const margin = 8;
    let x = payload.pointPx.x;
    let y = payload.pointPx.y - 20;
    x = Math.max(elW / 2 + margin, Math.min(w - elW / 2 - margin, x));
    if (y - elH < margin) {
      y = payload.pointPx.y + 26;
    }
    y = Math.max(margin + elH / 2, Math.min(h - margin - elH / 2, y));
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    el.dataset.state = 'visible';
    armAutoHide();
  };

  const hide = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    el.dataset.state = 'hidden';
    activeLineId = null;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeLineId) {
      engine._removeLineSegment(activeLineId, activeSegIdx);
    }
    hide();
  });

  const offLineAction = engine.on('lineAction', (payload) => {
    if (!payload || !payload.lineId) { hide(); return; }
    activeSegIdx = payload.segIdx ?? null;
    show(payload);
  });

  // Hide on empty map click. Ignore clicks within 150ms of show so the
  // same tap that opened the tooltip doesn't immediately close it.
  const onMapClick = () => {
    if (Date.now() - showTimestamp < 150) return;
    if (el.dataset.state === 'visible') hide();
  };
  map.on('click', onMapClick);

  const onCameraMove = () => hide();
  map.on('movestart', onCameraMove);

  return () => {
    offLineAction();
    map.off('click', onMapClick);
    map.off('movestart', onCameraMove);
    if (hideTimer) clearTimeout(hideTimer);
    if (el.parentNode) el.parentNode.removeChild(el);
  };
}
