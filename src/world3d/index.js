/**
 * Real World 3D Mode — entry point.
 *
 * Lazily loads CesiumJS and manages a full 3D geospatial viewer that
 * replaces the MapLibre 2D / 2.5D map when the user switches to
 * "3D Мир" mode. The viewer provides:
 *
 *   • True 3D terrain from Cesium World Terrain (real DEM data, 1:1 scale)
 *   • High-resolution satellite / aerial imagery
 *   • OSM Buildings as full 3D geometry via 3D Tiles
 *   • WASD flight controls with altitude-adaptive speed
 *   • Seamless camera synchronisation to / from the MapLibre map
 *
 * Loading strategy
 * ----------------
 * CesiumJS (~3.3 MB gzipped) is loaded *on-demand* the first time the
 * user activates the 3D mode. A loading overlay covers the transition.
 * Once loaded, the viewer instance persists across mode toggles (hidden
 * but alive) so subsequent switches are instantaneous.
 *
 * No CesiumJS code is pulled at initial page load — the 2D map starts
 * as fast as before.
 */

import { CESIUM, UKRAINE_CENTER } from '../config.js';
import { createWorld3DViewer, destroyWorld3DViewer, syncCameraFromMapLibre } from './viewer.js';
import { installFlightControls, removeFlightControls } from './controls.js';

// ---------------------------------------------------------------------------
// Module-level state.
// ---------------------------------------------------------------------------

/** Whether CesiumJS has been loaded into the page. */
let cesiumLoaded = false;

/** The live Cesium.Viewer instance, or null. */
let viewer = null;

/** Active flight-controller handle, or null. */
let flightControls = null;

/** The container element for the 3D viewer. */
let container = null;

/** Loading-state flag to prevent re-entrant activation. */
let activating = false;

// ---------------------------------------------------------------------------
// Lazy loader — injects CesiumJS scripts + CSS into <head> on first use.
// ---------------------------------------------------------------------------

/**
 * Dynamically load CesiumJS from CDN. Resolves with `window.Cesium`
 * once the library is fully initialised. Rejects on network failure.
 *
 * @returns {Promise<typeof Cesium>}
 */
function loadCesiumJS() {
  if (cesiumLoaded && window.Cesium) return Promise.resolve(window.Cesium);

  return new Promise((resolve, reject) => {
    // Set CESIUM_BASE_URL *before* the script executes so workers
    // and asset look-ups resolve correctly.
    window.CESIUM_BASE_URL = CESIUM.cdnBase + '/';

    // CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CESIUM.cdnBase + '/Widgets/widgets.css';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);

    // JS
    const script = document.createElement('script');
    script.src = CESIUM.cdnBase + '/Cesium.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (!window.Cesium) {
        reject(new Error('CesiumJS loaded but window.Cesium is undefined'));
        return;
      }
      cesiumLoaded = true;
      resolve(window.Cesium);
    };
    script.onerror = () => reject(new Error('Failed to load CesiumJS from CDN'));
    document.head.appendChild(script);
  });
}

// ---------------------------------------------------------------------------
// Container management.
// ---------------------------------------------------------------------------

/**
 * Ensure the `#cesium-container` element exists inside `#canvas`.
 * Creates it lazily and hides it by default.
 *
 * @returns {HTMLElement}
 */
function ensureContainer() {
  if (container) return container;
  const canvas = document.getElementById('canvas');
  if (!canvas) throw new Error('#canvas element not found');

  container = document.createElement('div');
  container.id = 'cesium-container';
  container.className = 'cesium-container';
  container.style.display = 'none';
  canvas.appendChild(container);
  return container;
}

/**
 * Show the loading overlay inside the cesium container.
 *
 * @param {HTMLElement} host
 * @returns {HTMLElement} The overlay element (caller removes it after load).
 */
function showLoadingOverlay(host) {
  const overlay = document.createElement('div');
  overlay.className = 'world3d-loading';
  overlay.innerHTML = `
    <div class="world3d-loading-inner">
      <div class="world3d-loading-spinner" role="presentation"></div>
      <p>Загрузка 3D-движка…</p>
    </div>
  `;
  host.appendChild(overlay);
  return overlay;
}

// ---------------------------------------------------------------------------
// Public API — mount / unmount / query.
// ---------------------------------------------------------------------------

/**
 * Activate the Real World 3D mode.
 *
 * On first call this lazily loads CesiumJS and creates the viewer.
 * On subsequent calls it simply shows the already-running viewer.
 *
 * @param {maplibregl.Map} map  The current MapLibre map (for camera sync).
 * @returns {Promise<void>}
 */
export async function activateWorld3D(map) {
  if (activating) return;
  activating = true;

  try {
    const host = ensureContainer();
    host.style.display = '';

    // Hide the MapLibre canvas so it doesn't fight for GPU resources.
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.display = 'none';

    if (viewer) {
      // Already created — just sync camera and resume rendering.
      syncCameraFromMapLibre(viewer, map);
      viewer.scene.requestRender();
      if (!flightControls) {
        flightControls = installFlightControls(viewer);
      }
      activating = false;
      return;
    }

    // First activation — load CesiumJS.
    const overlay = showLoadingOverlay(host);

    let Cesium;
    try {
      Cesium = await loadCesiumJS();
    } catch (err) {
      overlay.remove();
      host.style.display = 'none';
      if (mapEl) mapEl.style.display = '';
      // eslint-disable-next-line no-console
      console.error('[world3d] Failed to load CesiumJS:', err);
      activating = false;
      throw err;
    }

    // Create the viewer.
    try {
      viewer = await createWorld3DViewer(Cesium, host, { map });
    } catch (err) {
      overlay.remove();
      host.style.display = 'none';
      if (mapEl) mapEl.style.display = '';
      // eslint-disable-next-line no-console
      console.error('[world3d] Failed to create 3D viewer:', err);
      activating = false;
      throw err;
    }

    // Install WASD flight controls.
    flightControls = installFlightControls(viewer);

    // Remove loading overlay with a fade.
    overlay.classList.add('world3d-loading--fade');
    setTimeout(() => overlay.remove(), 400);

    // Expose for console debugging.
    window.__cart3d = { viewer, Cesium };
  } finally {
    activating = false;
  }
}

/**
 * Deactivate the 3D mode — hide the viewer, show MapLibre.
 *
 * Does NOT destroy the Cesium viewer so re-activation is instant.
 * Call `destroyWorld3D()` if you need to fully tear it down.
 */
export function deactivateWorld3D() {
  if (container) container.style.display = 'none';

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.display = '';

  // Pause flight controls while hidden.
  if (flightControls) {
    removeFlightControls(flightControls);
    flightControls = null;
  }
}

/**
 * Fully destroy the Cesium viewer and release GPU resources.
 * Rarely needed — prefer `deactivateWorld3D()` for mode toggles.
 */
export function destroyWorld3D() {
  deactivateWorld3D();
  if (viewer) {
    destroyWorld3DViewer(viewer);
    viewer = null;
  }
  if (container) {
    container.innerHTML = '';
  }
  window.__cart3d = undefined;
}

/**
 * @returns {boolean} Whether the 3D viewer is currently visible.
 */
export function isWorld3DActive() {
  return !!viewer && container?.style.display !== 'none';
}

/**
 * @returns {Cesium.Viewer | null}
 */
export function getWorld3DViewer() {
  return viewer;
}
