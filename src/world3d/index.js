/**
 * Real World 3D Mode ("3D Мир") — native MapLibre terrain.
 *
 * Path B (2026-06 rebuild): the 3D mode is no longer a separate CesiumJS
 * globe. It is the SAME MapLibre map flipped into an immersive,
 * terrain-3D fly state:
 *
 *   • The Cart vector style is draped per-pixel onto the AWS `terrain-dem`
 *     mesh via `map.setTerrain` — the exact technique the reference uses,
 *     so vectors stay crisp, labels render natively in 3D, and there is no
 *     raster-tile smear or satellite fallback.
 *   • Real elevations from the same DEM that powers hillshade / contours.
 *   • 3D buildings come for free from the style's `building_3d`
 *     fill-extrusion layer.
 *   • WASD flight controls with altitude-adaptive speed + a small HUD.
 *
 * The immersive style itself (terrain forced on at a fixed exaggeration)
 * is built by `buildModeStyle('world3d')` in createMap.js. This module
 * only manages the imperative camera state: pitch, pitch ceiling, flight
 * controls and the terrain "always-on" flag the lifecycle honours.
 *
 * No CesiumJS, no extra container, no 3.3 MB CDN download — the 2D map
 * engine IS the 3D engine.
 */

import { WORLD3D, UKRAINE_CENTER } from '../config.js';
import { installFlight } from './flight.js';

// ---------------------------------------------------------------------------
// Module-level state.
// ---------------------------------------------------------------------------

/** Active flight-controller handle, or null. */
let flight = null;

/** Camera state captured on entry, restored on exit. */
let savedCamera = null;

/** Pitch ceiling restored on exit (MapLibre default is 60). */
let savedMaxPitch = null;

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Activate immersive 3D on the live MapLibre map. The caller
 * (`applyMapMode`) has already installed the immersive Cart+terrain
 * style; here we flip the camera + flight state.
 *
 * @param {import('maplibre-gl').Map} map
 * @returns {Promise<void>}
 */
export async function activateWorld3D(map) {
  if (!map) return;

  // Flag the terrain lifecycle to keep terrain on at every zoom.
  if (map._cart) map._cart.world3dActive = true;

  // Make sure terrain is live immediately (don't wait for the next
  // zoomend / styledata tick).
  try {
    if (typeof map.getSource === 'function' && map.getSource('terrain-dem')) {
      const userMul =
        typeof map._cart?.userExaggerationMul === 'number'
          ? map._cart.userExaggerationMul
          : 1;
      map.setTerrain({
        source: 'terrain-dem',
        exaggeration: WORLD3D.exaggeration * userMul,
      });
    }
  } catch {
    /* terrain optional — style without DEM still flies, just flat */
  }

  // Raise the pitch ceiling for low-angle mountain shots, then tilt in.
  savedMaxPitch = typeof map.getMaxPitch === 'function' ? map.getMaxPitch() : 60;
  if (typeof map.setMaxPitch === 'function') map.setMaxPitch(WORLD3D.maxPitch);

  savedCamera = {
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    zoom: map.getZoom(),
    center: map.getCenter(),
  };

  // If we're way zoomed out (country overview), nudge in so the relief
  // actually reads in 3D; otherwise keep the user's current framing.
  const targetZoom = Math.max(map.getZoom(), 8.5);
  map.easeTo({
    pitch: WORLD3D.enterPitch,
    bearing: WORLD3D.enterBearing,
    zoom: targetZoom,
    duration: 900,
    essential: true,
  });

  // Install WASD flight + HUD.
  if (!flight) flight = installFlight(map);
}

/**
 * Deactivate immersive 3D — drop flight controls, flatten the camera,
 * and hand terrain control back to the 2D lifecycle. The subsequent
 * style swap (in applyMapMode) restores the flat map.
 *
 * @param {import('maplibre-gl').Map} [map]
 */
export function deactivateWorld3D(map) {
  if (flight) {
    flight.destroy();
    flight = null;
  }

  if (!map) {
    savedCamera = null;
    savedMaxPitch = null;
    return;
  }

  if (map._cart) map._cart.world3dActive = false;

  // Flatten the camera back to a 2D view.
  map.easeTo({
    pitch: 0,
    bearing: savedCamera?.bearing ?? 0,
    duration: 600,
    essential: true,
  });

  // Restore the pitch ceiling.
  if (savedMaxPitch != null && typeof map.setMaxPitch === 'function') {
    map.setMaxPitch(savedMaxPitch);
  }

  // Let the 2D terrain lifecycle decide whether terrain stays on at the
  // current zoom (it usually turns off below TERRAIN.terrain3DMinZoom).
  try {
    if (typeof map.getTerrain === 'function' && map.getTerrain() && map.getZoom() < 7) {
      map.setTerrain(null);
    }
  } catch {
    /* ignore */
  }

  savedCamera = null;
  savedMaxPitch = null;
}

/**
 * @param {import('maplibre-gl').Map} [map]
 * @returns {boolean}
 */
export function isWorld3DActive(map) {
  return !!map?._cart?.world3dActive;
}

// Re-exported for convenience / debugging from the console.
export { UKRAINE_CENTER };
