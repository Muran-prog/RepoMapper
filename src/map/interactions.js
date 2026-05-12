/**
 * Interaction tweaks layered on top of MapLibre's stock zoom/pan behaviour.
 *
 * Responsibilities:
 *
 *   • softer scroll-zoom rate so a mouse wheel glides instead of jumping
 *   • two-finger touchPitch enablement so tablets can tilt
 *   • shift+dbl-click to zoom out (desktop power-user feature)
 *   • ctrl/cmd+click "fly to point"
 *   • OS-level `prefers-reduced-motion` honoured for fly-to animations
 *   • keyboard accessibility — the canvas takes focus on click
 *
 * Terrain lifecycle
 * -----------------
 * MapLibre's `terrain.exaggeration` is a plain number (the style-spec
 * doesn't accept zoom-driven expressions for it). To get zoom-adaptive
 * relief we:
 *
 *   1. Install a `zoomend` handler that samples TERRAIN.exaggerationStops,
 *      multiplies by the active profile's & user slider's multipliers,
 *      and calls `map.setTerrain({ source, exaggeration })`.
 *   2. Below `TERRAIN.terrain3DMinZoom` the handler calls `setTerrain(null)`
 *      so low-zoom overview stays 2D (avoids a noticeable bulge at the
 *      country level and saves GPU).
 *   3. Reduce-motion sticks to `setTerrain(null)` always.
 *
 * Carpathian fly-to presets
 * -------------------------
 * Named peaks/passes pulled from the OSM wiki plus a region overview.
 * Kept here (rather than in a separate "locations.js") so UI controls
 * have one place to import from.
 */

import { TERRAIN } from '../config.js';
import {
  evalExaggeration,
  hillshadeExaggeration,
  HILLSHADE_BASE_MUL_META,
} from '../style/terrain.js';

export function installInteractionTuning(map, { caps } = {}) {
  const isTouch = !!caps?.isTouch;
  const reduceMotion = !!caps?.prefersReducedMotion;

  // ----- Scroll wheel ---------------------------------------------------
  if (map.scrollZoom) {
    map.scrollZoom.setWheelZoomRate(1 / 320);
    map.scrollZoom.setZoomRate(1 / 110);
  }

  // ----- Touch ----------------------------------------------------------
  if (isTouch) {
    map.touchPitch?.enable();
    map.touchZoomRotate?.enable();
  }

  // ----- Keyboard / focus ----------------------------------------------
  const container = map.getContainer();
  container.setAttribute('tabindex', '0');
  container.addEventListener('click', () => {
    container.focus({ preventScroll: true });
  });

  // ----- Desktop power-user shortcuts ----------------------------------
  map.on('dblclick', (e) => {
    if (!e.originalEvent?.shiftKey) return;
    e.preventDefault();
    if (reduceMotion) {
      map.jumpTo({ center: e.lngLat, zoom: map.getZoom() - 1 });
    } else {
      map.easeTo({ center: e.lngLat, zoom: map.getZoom() - 1, duration: 240 });
    }
  });

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

  // ----- Terrain lifecycle --------------------------------------------
  installTerrainLifecycle(map, { reduceMotion });
}

/**
 * Attach a `zoomend` handler that enables/disables 3D terrain and
 * updates its exaggeration based on the current zoom. Also re-applies
 * the user's slider multiplier to all hillshade layers on every
 * `styledata` (so style rebuilds — theme switch, layer toggle — keep
 * the slider's effect).
 *
 * Safe to call on maps without a terrain-capable style — `setTerrain`
 * is called defensively only when the style has a `terrain-dem` source.
 */
function installTerrainLifecycle(map, { reduceMotion }) {
  /** Update the root-level `terrain` block (3D terrain). */
  const applyTerrain = () => {
    const cart = map._cart ?? {};
    const cfg = cart.profileConfig ?? {};
    const features = cart.features ?? {};
    const userMul = typeof cart.userExaggerationMul === 'number' ? cart.userExaggerationMul : 1;

    const hasDem = typeof map.getSource === 'function' && !!map.getSource('terrain-dem');
    if (!hasDem) return;

    const terrainEnabled =
      !reduceMotion &&
      !!features.terrain3D &&
      !!cfg.enableTerrain3D;

    const zoom = map.getZoom();
    // Below the threshold we explicitly turn terrain off. At zoom 0.4
    // short of the threshold we also ramp exaggeration to 0 so the
    // toggle doesn't produce a visible pop.
    if (!terrainEnabled || zoom < TERRAIN.terrain3DMinZoom - 0.4) {
      if (map.getTerrain()) map.setTerrain(null);
      return;
    }

    const mul = (cfg.terrainExaggerationMul ?? 1) * userMul;
    const exaggeration = evalExaggeration(zoom, TERRAIN.exaggerationStops, mul);
    if (exaggeration <= 0.0001) {
      if (map.getTerrain()) map.setTerrain(null);
      return;
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration });
  };

  /**
   * Re-apply the user's slider mul to hillshade layers. Run on style
   * reloads so the slider position survives `applyStyle` rebuilds. Skipped
   * on plain zoom events because hillshade's own zoom-interp already
   * handles those without intervention.
   */
  const applyHillshade = () => {
    const cart = map._cart ?? {};
    const userMul = typeof cart.userExaggerationMul === 'number' ? cart.userExaggerationMul : 1;
    if (userMul === 1) return; // common case: nothing to override
    applyHillshadeExaggeration(map, userMul, reduceMotion);
  };

  map.on('zoomend', applyTerrain);
  map.on('styledata', applyTerrain);
  map.on('styledata', applyHillshade);
  map.once('load', applyTerrain);
  map.once('load', applyHillshade);
}

/**
 * Convenience camera presets exposed to UI controls.
 *
 * The Carpathian cluster targets peaks/massifs that are popular with
 * climbers and hikers; coordinates from OSM (manually verified against
 * https://www.openstreetmap.org/ for each).
 */
export const CAMERA_PRESETS = {
  ukraine:     { center: [31.1656, 48.3794], zoom: 5.6,  pitch: 0,  bearing: 0 },
  kyiv:        { center: [30.5234, 50.4501], zoom: 11,   pitch: 0,  bearing: 0 },
  lviv:        { center: [24.0297, 49.8397], zoom: 12,   pitch: 30, bearing: 0 },
  odesa:       { center: [30.7233, 46.4825], zoom: 11.5, pitch: 0,  bearing: 0 },
  kharkiv:     { center: [36.2304, 49.9935], zoom: 11,   pitch: 0,  bearing: 0 },
  carpathians: { center: [24.5,    48.3],    zoom: 8.5,  pitch: 35, bearing: 0 },

  // Ukrainian Carpathian highlights — pitch is leaned in so terrain 3D
  // reads immediately after the fly-to completes.
  hoverla:    { center: [24.5003, 48.1600], zoom: 13.5, pitch: 55, bearing: -30 }, // 2061 m
  pip_ivan:   { center: [24.6253, 48.0463], zoom: 13.5, pitch: 55, bearing: 15  }, // 2028 m
  petros:     { center: [24.3938, 48.1522], zoom: 13.5, pitch: 55, bearing: -15 }, // 2020 m
  svydovets:  { center: [24.2667, 48.2500], zoom: 12.5, pitch: 45, bearing: 0   }, // massif
  chornohora: { center: [24.5000, 48.1500], zoom: 12,   pitch: 45, bearing: 0   }, // massif
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

/**
 * Re-apply the user's exaggeration multiplier to every hillshade layer in
 * the current style by rewriting their `hillshade-exaggeration` paint
 * property in-place. Each hillshade layer carries its per-direction
 * baseline mul on `metadata['cart:hillshadeBaseMul']` (set by
 * src/style/terrain.js); we multiply by `userMul` and rebuild the same
 * zoom-interp expression that compose-time produced.
 *
 * Why bother: 3D terrain is only visible at zoom ≥ 7 with pitch > 0, so
 * a user moving the slider at the default Ukraine view (zoom 5.6, pitch 0)
 * sees nothing change unless the slider also drives the always-visible
 * hillshade exaggeration.
 */
function applyHillshadeExaggeration(map, userMul, reduceMotion) {
  if (typeof map.getStyle !== 'function') return;
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return;
  for (const layer of style.layers) {
    if (layer.type !== 'hillshade') continue;
    const baseMul = layer.metadata?.[HILLSHADE_BASE_MUL_META] ?? 1;
    const expr = hillshadeExaggeration(baseMul * userMul, reduceMotion);
    try {
      map.setPaintProperty(layer.id, 'hillshade-exaggeration', expr);
    } catch {
      /* Layer not yet attached — happens during a style swap; the next
         compose will pick up the new userMul anyway. */
    }
  }
}

/**
 * Update the user-controlled exaggeration multiplier and immediately
 * re-apply it to BOTH 3D terrain (root-level `terrain.exaggeration` via
 * setTerrain in the zoomend handler) AND every hillshade layer (via
 * setPaintProperty). Called from the UI slider on every `input` event.
 *
 * @param {maplibregl.Map} map
 * @param {number} mul  0.5..2.0
 */
export function setUserExaggeration(map, mul) {
  const clamped = Math.max(0, Math.min(2.5, Number(mul) || 1));
  if (!map._cart) map._cart = {};
  map._cart.userExaggerationMul = clamped;

  const reduceMotion = !!map._cart.caps?.prefersReducedMotion;
  applyHillshadeExaggeration(map, clamped, reduceMotion);

  // Re-evaluate 3D terrain via the zoomend lifecycle. Synthesising the
  // event is cheaper than rebuilding the style for a slider drag, and
  // re-uses the existing `apply` closure that knows about reduce-motion,
  // min-zoom gating and the profile multiplier.
  map.fire('zoomend');
}
