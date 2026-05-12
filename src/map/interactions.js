/**
 * Interaction tweaks layered on top of MapLibre's stock zoom/pan behaviour.
 *
 * MapLibre is already excellent out of the box; this module dials a few
 * parameters that are easy to overlook but materially improve the feel:
 *
 *   • softer scroll-zoom rate so a mouse wheel glides instead of jumping
 *   • two-finger touchPitch enablement so tablets can tilt
 *   • shift+dbl-click to zoom out (desktop power-user feature)
 *   • ctrl/cmd+click "fly to point" (also desktop)
 *   • OS-level `prefers-reduced-motion` honoured for fly-to animations
 *   • keyboard accessibility — the canvas takes focus on click
 *
 * Touch UX
 * --------
 * Single-finger pan, two-finger pinch-zoom and two-finger rotate are
 * MapLibre defaults. We enable `touchPitch` (two-finger drag to tilt) so
 * the 3D building extrusion is reachable from a tablet without a keyboard.
 */

export function installInteractionTuning(map, { caps } = {}) {
  const isTouch = !!caps?.isTouch;
  const reduceMotion = !!caps?.prefersReducedMotion;

  // ----- Scroll wheel ---------------------------------------------------
  if (map.scrollZoom) {
    // Slower than default for higher precision; the values are good across
    // both classic wheels and high-resolution trackpads.
    map.scrollZoom.setWheelZoomRate(1 / 320);
    map.scrollZoom.setZoomRate(1 / 110);
  }

  // ----- Touch ----------------------------------------------------------
  if (isTouch) {
    // Two-finger drag → tilt
    map.touchPitch?.enable();
    // Enable native two-finger rotation/pinch (default-on, but be explicit)
    map.touchZoomRotate?.enable();
  }

  // ----- Keyboard / focus ----------------------------------------------
  const container = map.getContainer();
  container.setAttribute('tabindex', '0');
  container.addEventListener('click', () => {
    // Regain focus so arrow-key panning works without an explicit Tab-in.
    container.focus({ preventScroll: true });
  });

  // ----- Desktop power-user shortcuts ----------------------------------
  // Shift+double-click → zoom out by one level (mirrors MapLibre's default
  // shift+drag zoom-out idea, but works in one gesture).
  map.on('dblclick', (e) => {
    if (!e.originalEvent?.shiftKey) return;
    e.preventDefault();
    if (reduceMotion) {
      map.jumpTo({ center: e.lngLat, zoom: map.getZoom() - 1 });
    } else {
      map.easeTo({ center: e.lngLat, zoom: map.getZoom() - 1, duration: 240 });
    }
  });

  // Ctrl/Cmd+click → fly to point (handy for visiting features pinpointed
  // from a popup or external link).
  map.on('click', (e) => {
    if (!(e.originalEvent?.ctrlKey || e.originalEvent?.metaKey)) return;
    if (reduceMotion) {
      map.jumpTo({ center: e.lngLat, zoom: Math.max(map.getZoom() + 2, 16) });
    } else {
      map.flyTo({
        center: e.lngLat,
        zoom: Math.max(map.getZoom() + 2, 16),
        speed: 1.4,
        curve: 1.6,
        essential: true,
      });
    }
  });
}

/**
 * Convenience camera presets exposed to UI controls.
 */
export const CAMERA_PRESETS = {
  ukraine: { center: [31.1656, 48.3794], zoom: 5.6, pitch: 0, bearing: 0 },
  kyiv: { center: [30.5234, 50.4501], zoom: 11, pitch: 0, bearing: 0 },
  lviv: { center: [24.0297, 49.8397], zoom: 12, pitch: 30, bearing: 0 },
  odesa: { center: [30.7233, 46.4825], zoom: 11.5, pitch: 0, bearing: 0 },
  kharkiv: { center: [36.2304, 49.9935], zoom: 11, pitch: 0, bearing: 0 },
  carpathians: { center: [24.5, 48.3], zoom: 8.5, pitch: 0, bearing: 0 },
};

/**
 * Fly to a named preset, respecting reduced-motion if requested.
 *
 * @param {maplibregl.Map} map
 * @param {string} name
 * @param {object} [opts]
 * @param {boolean} [opts.reduceMotion]
 */
export function flyToPreset(map, name, { reduceMotion = false } = {}) {
  const p = CAMERA_PRESETS[name];
  if (!p) return;
  if (reduceMotion) {
    map.jumpTo(p);
  } else {
    map.flyTo({ ...p, speed: 1.2, curve: 1.6, essential: true });
  }
}
