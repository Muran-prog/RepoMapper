/**
 * WASD flight controller for the native-MapLibre "3D Мир" mode.
 *
 *   W / ↑      — fly forward along the camera heading
 *   S / ↓      — fly backward
 *   A / ←      — strafe left
 *   D / →      — strafe right
 *   E / Space  — ascend  (zoom out / gain altitude)
 *   Q / Shift  — descend (zoom in / lose altitude)
 *   Ctrl       — ×N boost
 *   Wheel      — adjust the speed multiplier (only while flying)
 *   Right-drag — look around (MapLibre's native drag-rotate / pitch)
 *
 * Movement is frame-rate independent (driven by requestAnimationFrame)
 * and altitude-adaptive: ground speed scales with the current
 * metres-per-pixel, so you crawl when inspecting a ridge and cover
 * kilometres per second at country scale.
 *
 * This is the MapLibre re-implementation of the old Cesium controller —
 * it manipulates the map camera (center / zoom / bearing) directly via
 * jumpTo, which plays nicely with `map.setTerrain`.
 */

import { WORLD3D } from '../config.js';

const KEY_FORWARD = new Set(['KeyW', 'ArrowUp']);
const KEY_BACKWARD = new Set(['KeyS', 'ArrowDown']);
const KEY_LEFT = new Set(['KeyA', 'ArrowLeft']);
const KEY_RIGHT = new Set(['KeyD', 'ArrowRight']);
const KEY_UP = new Set(['KeyE', 'Space']);
const KEY_DOWN = new Set(['KeyQ', 'ShiftLeft', 'ShiftRight']);
const KEY_BOOST = new Set(['ControlLeft', 'ControlRight']);

const DEG2RAD = Math.PI / 180;
const EARTH_M_PER_DEG = 111320; // metres per degree of latitude
const FOV_RAD = 0.6435011; // MapLibre default camera field of view

/**
 * @typedef {object} FlightHandle
 * @property {() => void} destroy
 */

/**
 * Install WASD flight controls + HUD on a MapLibre map.
 *
 * @param {import('maplibre-gl').Map} map
 * @returns {FlightHandle}
 */
export function installFlight(map) {
  if (!map || typeof map.jumpTo !== 'function') {
    return { destroy() {} };
  }

  /** @type {Set<string>} */
  const pressed = new Set();
  let speedMultiplier = 1.0;
  let rafId = 0;
  let running = false;
  let lastTime = performance.now();

  const hud = createHUD(map.getContainer());

  const isFlightKey = (code) =>
    KEY_FORWARD.has(code) ||
    KEY_BACKWARD.has(code) ||
    KEY_LEFT.has(code) ||
    KEY_RIGHT.has(code) ||
    KEY_UP.has(code) ||
    KEY_DOWN.has(code);

  // The frame loop only runs while keys are held — when idle we stop
  // requesting frames so the page can settle (cheaper, and lets headless
  // screenshots capture a stable frame). HUD position still tracks normal
  // map movement via the 'move' listener below.
  const startLoop = () => {
    if (running) return;
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  // ----- Keyboard -----------------------------------------------------
  const onKeyDown = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (isFlightKey(e.code)) {
      e.preventDefault();
      pressed.add(e.code);
      startLoop();
    } else {
      pressed.add(e.code); // modifiers (Ctrl) tracked but don't start the loop
    }
  };
  const onKeyUp = (e) => pressed.delete(e.code);
  const onBlur = () => pressed.clear();

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // Keep HUD coordinates fresh during normal (non-flight) map movement.
  const onMapMove = () => {
    if (!running) updateHUD(hud, map, speedMultiplier, false);
  };
  map.on('move', onMapMove);

  // ----- Wheel → speed multiplier (only while flying) -----------------
  const onWheel = (e) => {
    if (pressed.size === 0) return; // let MapLibre scroll-zoom work normally
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? 0.8 : 1.25;
    speedMultiplier = Math.max(0.1, Math.min(50, speedMultiplier * delta));
  };
  const canvas = map.getCanvas();
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });

  // ----- Frame loop (active only while flying) ------------------------
  function tick() {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp big gaps
    lastTime = now;

    const flying =
      anyPressed(pressed, KEY_FORWARD) ||
      anyPressed(pressed, KEY_BACKWARD) ||
      anyPressed(pressed, KEY_LEFT) ||
      anyPressed(pressed, KEY_RIGHT) ||
      anyPressed(pressed, KEY_UP) ||
      anyPressed(pressed, KEY_DOWN);

    if (!flying) {
      // No movement keys held — settle and stop the loop until next press.
      updateHUD(hud, map, speedMultiplier, false);
      running = false;
      return;
    }

    applyMovement(map, pressed, dt, speedMultiplier);
    updateHUD(hud, map, speedMultiplier, true);
    rafId = requestAnimationFrame(tick);
  }

  // Initial HUD readout.
  updateHUD(hud, map, speedMultiplier, false);

  return {
    destroy() {
      cancelAnimationFrame(rafId);
      running = false;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      map.off('move', onMapMove);
      canvas.removeEventListener('wheel', onWheel, { capture: true });
      hud.el.remove();
      pressed.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Movement.
// ---------------------------------------------------------------------------

function applyMovement(map, pressed, dt, speedMultiplier) {
  const center = map.getCenter();
  const lat = center.lat;
  const lng = center.lng;
  const zoom = map.getZoom();
  const bearing = map.getBearing();

  const boost = anyPressed(pressed, KEY_BOOST) ? WORLD3D.flight.boostFactor : 1;

  // Ground metres per pixel at this latitude / zoom — the master scale.
  const mPerPx = (156543.03392 * Math.cos(lat * DEG2RAD)) / Math.pow(2, zoom);
  const speed = mPerPx * WORLD3D.flight.basePxPerSec * speedMultiplier * boost; // m/s
  const dist = speed * dt; // metres this frame

  // Horizontal translation along / across the heading.
  let north = 0;
  let east = 0;
  const bRad = bearing * DEG2RAD;
  if (anyPressed(pressed, KEY_FORWARD)) {
    north += Math.cos(bRad) * dist;
    east += Math.sin(bRad) * dist;
  }
  if (anyPressed(pressed, KEY_BACKWARD)) {
    north -= Math.cos(bRad) * dist;
    east -= Math.sin(bRad) * dist;
  }
  if (anyPressed(pressed, KEY_RIGHT)) {
    north += Math.cos(bRad + Math.PI / 2) * dist;
    east += Math.sin(bRad + Math.PI / 2) * dist;
  }
  if (anyPressed(pressed, KEY_LEFT)) {
    north += Math.cos(bRad - Math.PI / 2) * dist;
    east += Math.sin(bRad - Math.PI / 2) * dist;
  }

  const next = { center: [lng, lat], zoom, bearing, pitch: map.getPitch() };
  if (north !== 0 || east !== 0) {
    const dLat = north / EARTH_M_PER_DEG;
    const cosLat = Math.max(0.01, Math.cos(lat * DEG2RAD));
    const dLng = east / (EARTH_M_PER_DEG * cosLat);
    next.center = [lng + dLng, lat + dLat];
  }

  // Vertical — change altitude by nudging zoom.
  const climb = WORLD3D.flight.climbZoomPerSec * speedMultiplier * boost * dt;
  if (anyPressed(pressed, KEY_UP)) next.zoom = zoom - climb; // ascend → zoom out
  if (anyPressed(pressed, KEY_DOWN)) next.zoom = zoom + climb; // descend → zoom in
  next.zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), next.zoom));

  map.jumpTo(next);
}

// ---------------------------------------------------------------------------
// HUD.
// ---------------------------------------------------------------------------

function createHUD(container) {
  const el = document.createElement('div');
  el.className = 'world3d-hud';
  el.style.opacity = '1';
  el.innerHTML = `
    <div class="world3d-hud-row">
      <span class="world3d-hud-label">ALT</span>
      <span class="world3d-hud-value" data-field="altitude">—</span>
    </div>
    <div class="world3d-hud-row">
      <span class="world3d-hud-label">SPD</span>
      <span class="world3d-hud-value" data-field="speed">×1.0</span>
    </div>
    <div class="world3d-hud-row">
      <span class="world3d-hud-label">POS</span>
      <span class="world3d-hud-value" data-field="coords">—</span>
    </div>
    <div class="world3d-hud-hint">WASD — полёт · Ctrl — ускорение · ПКМ — обзор · Колесо — скорость</div>
  `;
  container.appendChild(el);
  return {
    el,
    altitude: el.querySelector('[data-field="altitude"]'),
    speed: el.querySelector('[data-field="speed"]'),
    coords: el.querySelector('[data-field="coords"]'),
  };
}

function updateHUD(hud, map, speedMul, flying) {
  const center = map.getCenter();
  const lat = center.lat;
  const zoom = map.getZoom();
  const pitch = map.getPitch();

  // Estimate camera altitude above the centre point: distance along the
  // view ray to the focus, projected onto the vertical.
  const mPerPx = (156543.03392 * Math.cos(lat * DEG2RAD)) / Math.pow(2, zoom);
  const canvasH = map.getCanvas().clientHeight || 760;
  const camDist = ((canvasH / 2) * mPerPx) / Math.tan(FOV_RAD / 2);
  const altM = Math.max(0, camDist * Math.cos(pitch * DEG2RAD));

  hud.altitude.textContent =
    altM > 10_000 ? (altM / 1000).toFixed(1) + ' km' : Math.round(altM) + ' m';
  hud.speed.textContent = '×' + speedMul.toFixed(1);
  hud.coords.textContent = `${lat.toFixed(4)}°, ${center.lng.toFixed(4)}°`;

  // Subtle emphasis while actively flying.
  const targetOpacity = flying ? '1' : '0.72';
  if (hud.el.style.opacity !== targetOpacity) hud.el.style.opacity = targetOpacity;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function anyPressed(pressed, keySet) {
  for (const k of keySet) {
    if (pressed.has(k)) return true;
  }
  return false;
}
