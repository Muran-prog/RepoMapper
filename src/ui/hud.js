/**
 * Heads-up display — a small, premium glass pill that surfaces map
 * telemetry without being noisy:
 *
 *   • FPS                — live frame rate (colour-tiered green/amber/red)
 *   • ZOOM               — current camera zoom, 2 decimals
 *   • TILES              — outstanding tile fetches
 *   • LAT / LON / ELEV   — appended on hover-capable pointers; tracks
 *                          the cursor and shows DEM elevation under it
 *
 * Visual model
 * ------------
 * One horizontal glass pill at the bottom-left, broken into compact
 * "stat" cells separated by hairline dividers. Each stat is a label-
 * over-value pair so the eye can scan the numbers in a single sweep:
 *
 *    ┌──────────────────────────────────────────────┐
 *    │ FPS   Z      TILES   LAT      LON     ELEV   │
 *    │  60   5.42    24    48.379  31.166   1842 м │
 *    └──────────────────────────────────────────────┘
 *
 * On touch devices the LAT/LON/ELEV stats are absent (they require a
 * hovering pointer); the pill simply renders with three cells.
 *
 * Elevation source: `map.queryTerrainElevation(lngLat)`. When terrain
 * is disabled or unloaded the API returns null/NaN — the HUD shows an
 * em-dash instead of an error.
 */

const FMT_COORD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const FMT_ZOOM = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT_ELEV = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

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

  // The cursor-driven stats (LAT/LON/ELEV) live in a separately
  // styleable group so we can fade them in / out as a unit when the
  // pointer enters or leaves the canvas.
  const cursorCells = showCursor
    ? `
      <div class="hud-stat-group" data-hud-group="cursor" data-state="idle">
        ${statHTML('lat', 'LAT', '—')}
        ${statHTML('lon', 'LON', '—')}
        ${statHTML('elev', 'ELEV', '—')}
      </div>
    `
    : '';

  root.innerHTML = `
    <div class="hud" data-mode="${showCursor ? 'full' : 'compact'}" role="status" aria-live="off">
      <div class="hud-stat-group hud-stat-group-primary">
        ${statHTML('fps', 'FPS', '—')}
        ${statHTML('zoom', 'ZOOM', '—')}
        ${statHTML('tiles', 'TILES', '0')}
      </div>
      ${cursorCells}
    </div>
  `;

  const refs = {
    fps: root.querySelector('[data-hud=fps]'),
    zoom: root.querySelector('[data-hud=zoom]'),
    lat: root.querySelector('[data-hud=lat]'),
    lon: root.querySelector('[data-hud=lon]'),
    elev: root.querySelector('[data-hud=elev]'),
    tiles: root.querySelector('[data-hud=tiles]'),
    cursorGroup: root.querySelector('[data-hud-group="cursor"]'),
    fpsCell: root.querySelector('[data-hud-stat="fps"]'),
  };

  const stop = perf.subscribe((r) => {
    if (refs.fps) refs.fps.textContent = String(r.fps);
    if (refs.fpsCell) {
      const tier = r.fps >= 50 ? 'good' : r.fps >= 30 ? 'mid' : 'low';
      refs.fpsCell.dataset.tier = tier;
    }
    if (refs.zoom) refs.zoom.textContent = FMT_ZOOM.format(r.zoom);
    if (refs.tiles) refs.tiles.textContent = String(r.tilesLoading);
  });

  let onMouseMove = null;
  let onMouseLeave = null;
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

    onMouseLeave = () => {
      if (refs.cursorGroup) refs.cursorGroup.dataset.state = 'idle';
    };

    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseLeave);

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
    if (flushTimer) clearInterval(flushTimer);
  };
}
