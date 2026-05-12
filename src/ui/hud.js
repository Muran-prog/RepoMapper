/**
 * Heads-up display: FPS, current zoom, lat/lon under the cursor, and live
 * tile-loading activity.
 *
 * The HUD is adaptive:
 *
 *   • On hover-capable pointers (desktop, laptop, some tablets with a
 *     mouse), all rows are visible including LAT/LON which track the
 *     cursor.
 *   • On touch-only devices, the LAT/LON rows are hidden because they're
 *     meaningless without a hover pointer; only FPS, ZOOM and TILES show.
 *
 * The container's CSS positions the HUD top-left on phones (where the
 * bottom-left is occupied by the scale bar and the bottom sheet) and
 * bottom-left on desktop.
 */

const FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const FMT_Z = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    onMouse = (e) => {
      refs.lat.textContent = FMT.format(e.lngLat.lat);
      refs.lon.textContent = FMT.format(e.lngLat.lng);
    };
    map.on('mousemove', onMouse);
  }

  return () => {
    stop();
    if (onMouse) map.off('mousemove', onMouse);
  };
}
