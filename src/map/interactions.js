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
} from '../style/terrain.js';
import {
  applyHypsoStrength,
  applyHypsoStrengthAtZoom,
  applyHypsoRamp,
  rebalanceHillshadeForHypso,
  detectHypsoCaps,
  findActiveHypsoLayer,
} from '../style/hypso/index.js';
import { syncGridSource } from '../style/grid.js';

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

  // ----- Combined relief lifecycle ------------------------------------
  //
  // We deliberately use a single owner for hillshade-exaggeration to
  // avoid the race that used to exist between three independent
  // `styledata` listeners (terrain hillshade rewrite + hypso
  // smart-blend rewrite + user-mul rewrite). Each path used a slightly
  // different formula and the last-writer-wins ordering changed the
  // visible relief depending on timing.
  //
  // Now the ordering is:
  //   1. installTerrainLifecycle    → 3D terrain (setTerrain) only.
  //   2. installHillshadeLifecycle  → SOLE owner of
  //                                   hillshade-exaggeration. Applies
  //                                   the unified base × userMul ×
  //                                   hypsoBlend formula via
  //                                   rebalanceHillshadeForHypso.
  //   3. installHypsoLifecycle      → applies persisted ramp/strength
  //                                   to the live hypso layer.
  //   4. installHypsoZoomBinding    → pushes constant
  //                                   color-relief-opacity on every
  //                                   move event so the visible
  //                                   opacity matches
  //                                   evaluateStrengthAtZoom exactly.
  installTerrainLifecycle(map, { reduceMotion });
  installHillshadeLifecycle(map, { reduceMotion });
  installHypsoLifecycle(map, { reduceMotion });
  installHypsoZoomBinding(map);
  installGridLifecycle(map);
}

function installGridLifecycle(map) {
  const sync = () => syncGridSource(map);
  map.on('styledata', sync);
  map.on('moveend', sync);
  map.on('zoomend', sync);
  map.once('load', sync);
}

/**
 * Re-apply the hypso state (ramp + strength) after every style reload
 * so theme switches / quality switches preserve the user's choice and
 * the smart hillshade blend matches the live strength.
 *
 * Cold case: at boot, the style was composed with the initial state
 * baked in, so applying again is a no-op. After the user picks a new
 * ramp from the UI we don't rebuild the style — the runtime mutates
 * the live layer in place; but a theme switch DOES rebuild, and we
 * need the new style's hillshade layers to settle in the blended
 * state.
 *
 * Idempotent via `applyHypsoRamp`/`applyHypsoStrength`'s deepEqual
 * short-circuit and our own last-state memo, so it's safe to fire on
 * every styledata burst.
 */
function installHypsoLifecycle(map, { reduceMotion }) {
  void reduceMotion;
  let lastSig = '';
  const apply = () => {
    detectHypsoCaps(map);
    const state = map._cart?.hypso;
    if (!state) return;
    const layer = findActiveHypsoLayer(map);
    if (!layer) return;
    const sig = [
      state.mode,
      state.rampId,
      state.theme,
      state.strength,
      state.bathymetry ? 1 : 0,
      state.highContrast ? 1 : 0,
    ].join('|');
    // No state delta? Skip — the layer already has the right paint.
    if (sig === lastSig) return;
    lastSig = sig;
    applyHypsoRamp(map, state.rampId, { dispatch: false });
    applyHypsoStrength(map, state.strength, { dispatch: false });
  };

  map.on('styledata', apply);
  map.once('load', apply);
}

/**
 * SOLE owner of `hillshade-exaggeration`. Recomputes the unified
 * `base × baseMul × userMul × hypsoBlend` curve on every styledata
 * event and on every zoom event (so the visible exaggeration tracks
 * both the camera and the slider without lag).
 *
 * The runtime's `rebalanceHillshadeForHypso` is idempotent: it caches
 * a [strength, userMul, active, reduceMotion] signature per layer id
 * and skips setPaintProperty when nothing changed.
 */
function installHillshadeLifecycle(map, { reduceMotion }) {
  void reduceMotion;
  const apply = () => {
    const cart = map._cart ?? {};
    const hypso = cart.hypso;
    const strength = hypso && hypso.mode !== 'off' ? hypso.strength ?? 0 : 0;
    rebalanceHillshadeForHypso(map, strength);
  };
  map.on('styledata', apply);
  map.on('zoom', apply);
  map.once('load', apply);
}

/**
 * Bind a `move` handler that re-pushes the current zoom's hypso
 * opacity as a CONSTANT scalar. This is the runtime's defensive
 * fallback: even if MapLibre's evaluator for the zoom-driven
 * `color-relief-opacity` expression ever drifts from the spec (some
 * earlier `color-relief` builds did), the constant we push every
 * move event pins the visible opacity to
 * `evaluateStrengthAtZoom(zoom, strength)`.
 *
 * Idempotent per-zoom quantum via `applyHypsoStrengthAtZoom`'s
 * cache — at most a handful of setPaintProperty calls during a
 * scroll-zoom burst, not one per frame.
 */
function installHypsoZoomBinding(map) {
  const push = () => {
    applyHypsoStrengthAtZoom(map);
  };
  map.on('move', push);
  map.on('zoom', push);
  map.on('styledata', push);
  map.once('load', push);
}

/**
 * Attach a `zoomend` handler that enables/disables 3D terrain and
 * updates its exaggeration based on the current zoom. Hillshade lives
 * in `installHillshadeLifecycle` — this function deliberately no
 * longer touches `hillshade-exaggeration`.
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

  map.on('zoomend', applyTerrain);
  map.on('styledata', applyTerrain);
  map.once('load', applyTerrain);
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
 * Update the user-controlled exaggeration multiplier and re-run BOTH
 * the hillshade lifecycle (which owns hillshade-exaggeration and knows
 * how to blend it with hypso) AND the 3D terrain lifecycle.
 *
 * Called from the UI slider on every `input` event.
 *
 * @param {maplibregl.Map} map
 * @param {number} mul  0.5..2.0 (clamped to [0, 2.5] defensively)
 */
export function setUserExaggeration(map, mul) {
  const clamped = Math.max(0, Math.min(2.5, Number(mul) || 1));
  if (!map._cart) map._cart = {};
  map._cart.userExaggerationMul = clamped;

  // Invalidate the hillshade memo so rebalance actually pushes new
  // values now that userMul has changed. Single owner formula:
  // base × baseMul × userMul × hypsoBlend.
  if (map._cart.hypso) map._cart.hypso._lastHillshade = {};
  const strength =
    map._cart.hypso && map._cart.hypso.mode !== 'off'
      ? map._cart.hypso.strength ?? 0
      : 0;
  rebalanceHillshadeForHypso(map, strength);

  // Re-evaluate 3D terrain via the zoomend lifecycle. Synthesising the
  // event is cheaper than rebuilding the style for a slider drag, and
  // re-uses the existing `apply` closure that knows about reduce-motion,
  // min-zoom gating and the profile multiplier.
  map.fire('zoomend');
}
