/**
 * Heads-up display — a small, premium glass chip that surfaces map
 * telemetry without crowding the canvas:
 *
 *   • FPS                — live frame rate (colour-tiered green/amber/red)
 *   • ZOOM               — current camera zoom, 2 decimals
 *   • TILES              — outstanding tile fetches
 *   • LAT / LON / ELEV   — appended on hover-capable pointers; tracks
 *                          the cursor and shows DEM elevation under it
 *
 * Visual model
 * ------------
 * The HUD is built around a 40 px square anchor button (same family
 * as the MapLibre native controls and the hypso legend toggle). The
 * anchor doubles as an FPS health-pulse — its dot indicator is
 * coloured by the current FPS tier so the user gets an at-a-glance
 * signal even with the panel collapsed. Clicking the anchor expands
 * the full telemetry panel that slides out alongside it:
 *
 *    Collapsed:   [●]
 *    Expanded:    [●][ FPS  · ZOOM · TILES · LAT · LON · ELEV ]
 *
 * On narrow viewports the expanded panel switches to a vertical
 * stack so it doesn't fight the dock for horizontal space.
 *
 * Persistence
 * -----------
 * Open/closed state survives reload via `src/ui/store.js`. The
 * default is collapsed on touch / narrow viewports (the chrome would
 * otherwise eat too much of an already-tight canvas).
 *
 * Elevation source: `map.queryTerrainElevation(lngLat)`. When terrain
 * is disabled or unloaded the API returns null/NaN — the HUD shows an
 * em-dash instead of an error.
 */

import { loadUiPrefs, saveUiPrefs } from './store.js';

const FMT_COORD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const FMT_ZOOM = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT_ELEV = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

const CHEV_SVG = `
  <svg class="hud-chev" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 4 L10 8 L6 12" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

/** Build the HTML for a single stat cell. */
function statHTML(key, label, initialValue = '—') {
  return `
    <div class="hud-stat" data-hud-stat="${key}">
      <span class="hud-stat-label">${label}</span>
      <span class="hud-stat-value" data-hud="${key}">${initialValue}</span>
    </div>
  `;
}

export function mountHUD(map, perf, root, { caps } = {}) {
  const showCursor = !!caps?.hasHover && !!caps?.hasFinePointer;

  // First-run UX: collapsed by default on narrow viewports + touch
  // pointers so the HUD doesn't crowd the dock on phones. Once the
  // user toggles it, that choice is persisted and wins over the
  // default on every subsequent reload.
  const defaultCollapsed = !!(caps?.narrow || caps?.isCoarse);
  const prefs = loadUiPrefs({ hudCollapsed: defaultCollapsed });
  const initiallyCollapsed = prefs.hudCollapsed;

  // The cursor-driven stats (LAT/LON/ELEV) live in a separately
  // styleable group so we can fade them in / out as a unit when the
  // pointer enters or leaves the canvas.
  const cursorCells = showCursor
    ? `
      <div class="hud-stat-group" data-hud-group="cursor" data-state="idle">
        ${statHTML('lat', 'ШИР', '—')}
        ${statHTML('lon', 'ДОЛ', '—')}
        ${statHTML('elev', 'ВЫС', '—')}
      </div>
    `
    : '';

  root.innerHTML = `
    <div class="hud"
         data-mode="${showCursor ? 'full' : 'compact'}"
         data-collapsed="${initiallyCollapsed ? 'true' : 'false'}"
         role="status"
         aria-live="off">
      <button class="hud-toggle"
              type="button"
              data-ctl="hud-toggle"
              aria-expanded="${initiallyCollapsed ? 'false' : 'true'}"
              aria-controls="hud-panel"
              aria-label="${initiallyCollapsed ? 'Развернуть HUD' : 'Свернуть HUD'}"
              title="FPS">
        <span class="hud-toggle-dot" data-hud="fps-dot" aria-hidden="true"></span>
        ${CHEV_SVG}
      </button>
      <div class="hud-panel" id="hud-panel" aria-hidden="${initiallyCollapsed ? 'true' : 'false'}">
        <div class="hud-stat-group hud-stat-group-primary">
          ${statHTML('fps', 'FPS', '—')}
          ${statHTML('zoom', 'МАСШТ', '—')}
          ${statHTML('tiles', 'ТАЙЛЫ', '0')}
        </div>
        ${cursorCells}
      </div>
    </div>
  `;

  const hud = root.querySelector('.hud');
  const refs = {
    fps: root.querySelector('[data-hud=fps]'),
    fpsDot: root.querySelector('[data-hud="fps-dot"]'),
    zoom: root.querySelector('[data-hud=zoom]'),
    lat: root.querySelector('[data-hud=lat]'),
    lon: root.querySelector('[data-hud=lon]'),
    elev: root.querySelector('[data-hud=elev]'),
    tiles: root.querySelector('[data-hud=tiles]'),
    cursorGroup: root.querySelector('[data-hud-group="cursor"]'),
    fpsCell: root.querySelector('[data-hud-stat="fps"]'),
    toggle: root.querySelector('[data-ctl="hud-toggle"]'),
    panel: root.querySelector('.hud-panel'),
  };

  // ------------------------------------------------------------------
  // Collapse / expand. Stamps the same FPS tier onto the anchor button
  // so the dot stays meaningful even when the panel is hidden.
  // ------------------------------------------------------------------
  const setCollapsed = (collapsed, { persist = true } = {}) => {
    hud.dataset.collapsed = collapsed ? 'true' : 'false';
    if (refs.toggle) {
      refs.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      refs.toggle.setAttribute(
        'aria-label',
        collapsed ? 'Развернуть HUD' : 'Свернуть HUD',
      );
    }
    if (refs.panel) refs.panel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    if (collapsed && refs.cursorGroup) refs.cursorGroup.dataset.state = 'idle';
    if (persist) saveUiPrefs({ hudCollapsed: collapsed });
  };
  refs.toggle?.addEventListener('click', () => {
    setCollapsed(hud.dataset.collapsed !== 'true');
  });

  const stop = perf.subscribe((r) => {
    if (refs.fps) refs.fps.textContent = String(r.fps);
    const tier = r.fps >= 50 ? 'good' : r.fps >= 30 ? 'mid' : 'low';
    if (refs.fpsCell) refs.fpsCell.dataset.tier = tier;
    // Mirror the FPS tier onto the HUD root so the anchor dot picks
    // it up without an extra subscription. Cheap data-attribute set,
    // no layout cost.
    if (hud) hud.dataset.tier = tier;
    if (refs.zoom) refs.zoom.textContent = FMT_ZOOM.format(r.zoom);
    if (refs.tiles) refs.tiles.textContent = String(r.tilesLoading);
  });

  let onMouseMove = null;
  let onMouseLeave = null;
  let onHudLeave = null;
  let flushTimer = null;

  if (showCursor) {
    // Throttle elevation sampling to ~30 Hz — `queryTerrainElevation`
    // walks the live DEM source and is non-trivial under fast mouse
    // movement. We coalesce intermediate samples and flush the latest
    // when the pointer settles.
    let pendingLngLat = null;
    let lastSample = 0;

    const sampleElev = (lngLat) => {
      if (!map.queryTerrainElevation) return null;
      try {
        return map.queryTerrainElevation(lngLat);
      } catch {
        return null;
      }
    };

    onMouseMove = (e) => {
      // Skip the cursor-group activation while collapsed; the cells
      // aren't visible and we'd just be writing into a hidden DOM.
      if (hud?.dataset.collapsed === 'true') return;
      if (refs.cursorGroup) refs.cursorGroup.dataset.state = 'active';
      if (refs.lat) refs.lat.textContent = `${FMT_COORD.format(e.lngLat.lat)}°`;
      if (refs.lon) refs.lon.textContent = `${FMT_COORD.format(e.lngLat.lng)}°`;

      const now = performance.now();
      if (now - lastSample < 32) {
        pendingLngLat = e.lngLat;
        return;
      }
      lastSample = now;
      pendingLngLat = null;

      const elev = sampleElev(e.lngLat);
      if (refs.elev) {
        if (elev == null || !Number.isFinite(elev)) {
          refs.elev.textContent = '—';
        } else {
          refs.elev.textContent = `${FMT_ELEV.format(elev)} м`;
        }
      }
    };

    onMouseLeave = (e) => {
      // The HUD is overlaid on the map and captures pointer events, so
      // crossing onto it makes MapLibre fire `mouseout` on the canvas.
      // If we idled unconditionally the cursor group would collapse,
      // the HUD would shrink out from under the pointer, the canvas
      // would receive `mousemove` again, the group would re-expand,
      // and we'd ping-pong — the visible flicker on the HUD's right
      // edge. Detect that case via the original DOM event's
      // relatedTarget and keep the stats stable when the pointer is
      // simply hovering us.
      const related = e?.originalEvent?.relatedTarget;
      if (related instanceof Node && root.contains(related)) return;
      if (refs.cursorGroup) refs.cursorGroup.dataset.state = 'idle';
    };

    // Symmetric guard: when the pointer leaves the HUD to anything
    // that isn't the map canvas (the dock, the legend, the window
    // chrome…) idle the cursor stats so stale coordinates don't sit
    // on the chip. If it goes back to the map, the canvas's own
    // `mousemove` will keep them fresh — no action needed here.
    onHudLeave = (e) => {
      const related = e.relatedTarget;
      const mapEl = map.getContainer();
      if (related instanceof Node && mapEl.contains(related)) return;
      if (refs.cursorGroup) refs.cursorGroup.dataset.state = 'idle';
    };

    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseLeave);
    hud.addEventListener('mouseleave', onHudLeave);

    // Periodically flush coalesced samples so the readout settles when
    // the mouse stops moving inside the throttle window.
    flushTimer = setInterval(() => {
      if (!pendingLngLat) return;
      onMouseMove({ lngLat: pendingLngLat });
    }, 100);
  }

  return () => {
    stop();
    if (onMouseMove) map.off('mousemove', onMouseMove);
    if (onMouseLeave) map.off('mouseout', onMouseLeave);
    if (onHudLeave) hud.removeEventListener('mouseleave', onHudLeave);
    if (flushTimer) clearInterval(flushTimer);
  };
}
