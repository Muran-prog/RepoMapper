/**
 * Heads-up display: FPS, current zoom, lat/lon under the cursor, live
 * tile-loading activity, and DEM-sampled elevation under the cursor.
 *
 * The HUD is adaptive:
 *
 *   • On hover-capable pointers (desktop, laptop, some tablets with a
 *     mouse), all rows are visible including LAT/LON/ELEV which track
 *     the cursor.
 *   • On touch-only devices, LAT/LON/ELEV are hidden because they're
 *     meaningless without a hover pointer; only FPS, ZOOM and TILES show.
 *
 * The elevation reading uses `map.queryTerrainElevation(lngLat)` — which
 * returns the elevation at the given coord IF terrain is enabled with a
 * DEM. When terrain is off the function returns null/undefined, and the
 * HUD shows an em-dash for the ELEV row instead of an error.
 *
 * The container's CSS positions the HUD top-left on phones (where the
 * bottom-left is occupied by the scale bar and the bottom sheet) and
 * bottom-left on desktop.
 */

const FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const FMT_Z = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT_ELEV = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

export function mountHUD(map, perf, root, { caps } = {}) {
  const showMouseRows = !!caps?.hasHover && !!caps?.hasFinePointer;

  root.innerHTML = `
    <div class="hud" data-mode="${showMouseRows ? 'full' : 'compact'}">
      <div class="hud-row">
        <span class="hud-label">FPS</span>
        <span data-hud="fps" class="hud-value">—</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">ZOOM</span>
        <span data-hud="zoom" class="hud-value">—</span>
      </div>
      ${
        showMouseRows
          ? `
        <div class="hud-row">
          <span class="hud-label">LAT</span>
          <span data-hud="lat" class="hud-value">—</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">LON</span>
          <span data-hud="lon" class="hud-value">—</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">ELEV</span>
          <span data-hud="elev" class="hud-value">—</span>
        </div>`
          : ''
      }
      <div class="hud-row">
        <span class="hud-label">TILES</span>
        <span data-hud="tiles" class="hud-value">0</span>
      </div>
    </div>
  `;

  const refs = {
    fps: root.querySelector('[data-hud=fps]'),
    zoom: root.querySelector('[data-hud=zoom]'),
    lat: root.querySelector('[data-hud=lat]'),
    lon: root.querySelector('[data-hud=lon]'),
    elev: root.querySelector('[data-hud=elev]'),
    tiles: root.querySelector('[data-hud=tiles]'),
  };

  const stop = perf.subscribe((r) => {
    refs.fps.textContent = String(r.fps);
    refs.fps.dataset.tier = r.fps >= 50 ? 'good' : r.fps >= 30 ? 'mid' : 'low';
    refs.zoom.textContent = FMT_Z.format(r.zoom);
    refs.tiles.textContent = String(r.tilesLoading);
  });

  let onMouse = null;
  if (showMouseRows) {
    // Throttle the elevation lookup to ~30 Hz; queryTerrainElevation
    // walks the DEM source and is non-trivial under heavy mousemove.
    let pendingElev = null;
    let lastSample = 0;

    const sampleElev = (lngLat) => {
      if (!map.queryTerrainElevation) return null;
      try {
        return map.queryTerrainElevation(lngLat);
      } catch {
        return null;
      }
    };

    onMouse = (e) => {
      refs.lat.textContent = FMT.format(e.lngLat.lat);
      refs.lon.textContent = FMT.format(e.lngLat.lng);
      const now = performance.now();
      if (now - lastSample < 32) {
        // Coalesce — schedule one more sample after the throttle window.
        pendingElev = e.lngLat;
        return;
      }
      lastSample = now;
      pendingElev = null;
      const elev = sampleElev(e.lngLat);
      if (elev == null || !Number.isFinite(elev)) {
        refs.elev.textContent = '—';
      } else {
        refs.elev.textContent = `${FMT_ELEV.format(elev)} м`;
      }
    };
    map.on('mousemove', onMouse);

    // Periodically flush coalesced samples so the readout settles when
    // the mouse stops moving inside the throttle window.
    const flush = setInterval(() => {
      if (!pendingElev) return;
      onMouse({ lngLat: pendingElev });
    }, 100);

    return () => {
      stop();
      map.off('mousemove', onMouse);
      clearInterval(flush);
    };
  }

  return () => {
    stop();
    if (onMouse) map.off('mousemove', onMouse);
  };
}
