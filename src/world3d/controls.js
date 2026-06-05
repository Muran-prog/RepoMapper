/**
 * WASD Flight Controller for the Real World 3D mode.
 *
 * Implements a free-flight camera inspired by Google Earth and flight
 * simulators:
 *
 *   W / ↑      — fly forward along camera heading
 *   S / ↓      — fly backward
 *   A / ←      — strafe left
 *   D / →      — strafe right
 *   E / Space  — ascend
 *   Q / Shift  — descend
 *   Scroll     — adjust flight speed multiplier
 *
 * Mouse interaction is handled by CesiumJS's built-in controller:
 *   Left-drag   — orbit / look around
 *   Right-drag  — zoom
 *   Middle-drag — tilt
 *   Scroll      — zoom (overridden here for speed control when in
 *                 flight mode; CesiumJS scroll-zoom is restored when
 *                 no WASD keys are active)
 *
 * Speed adapts to altitude: close to the ground you move slowly (perfect
 * for inspecting buildings), at high altitude you traverse kilometres
 * per second (exploring at country scale). Holding Ctrl boosts speed ×5.
 *
 * The controller hooks into `scene.preUpdate` so movement is frame-rate
 * independent and runs at the native render loop frequency.
 */

// ---------------------------------------------------------------------------
// Key bindings — uppercase key names. Checked via event.code.
// ---------------------------------------------------------------------------

const KEY_FORWARD = new Set(['KeyW', 'ArrowUp']);
const KEY_BACKWARD = new Set(['KeyS', 'ArrowDown']);
const KEY_LEFT = new Set(['KeyA', 'ArrowLeft']);
const KEY_RIGHT = new Set(['KeyD', 'ArrowRight']);
const KEY_UP = new Set(['KeyE', 'Space']);
const KEY_DOWN = new Set(['KeyQ', 'ShiftLeft', 'ShiftRight']);
const KEY_BOOST = new Set(['ControlLeft', 'ControlRight']);

// ---------------------------------------------------------------------------
// Flight controller.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FlightControlHandle
 * @property {() => void} destroy  Remove all listeners and stop the loop.
 */

/**
 * Install the WASD flight controller on a Cesium viewer.
 *
 * @param {Cesium.Viewer} viewer
 * @returns {FlightControlHandle}
 */
export function installFlightControls(viewer) {
  const Cesium = window.Cesium;
  if (!Cesium || !viewer || viewer.isDestroyed()) {
    return { destroy() {} };
  }

  const scene = viewer.scene;
  const camera = viewer.camera;
  const canvas = viewer.canvas;

  // Track pressed keys.
  /** @type {Set<string>} */
  const pressed = new Set();

  // Speed multiplier the user can adjust with scroll.
  let speedMultiplier = 1.0;

  // ----- HUD overlay ---------------------------------------------------
  const hud = createHUD(viewer.container);

  // ----- Keyboard listeners -------------------------------------------

  const onKeyDown = (e) => {
    // Don't capture when an input/textarea is focused.
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    pressed.add(e.code);
  };

  const onKeyUp = (e) => {
    pressed.delete(e.code);
  };

  // On blur, release all keys to avoid ghost movement.
  const onBlur = () => pressed.clear();

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ----- Scroll → speed adjustment ------------------------------------
  const onWheel = (e) => {
    // Only hijack scroll when the user is actively flying (WASD pressed).
    if (pressed.size === 0) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.8 : 1.25;
    speedMultiplier = Math.max(0.1, Math.min(50, speedMultiplier * delta));
    updateHUD(hud, camera, speedMultiplier);
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ----- Pre-update loop (tied to render frame) -----------------------
  let lastTime = performance.now();

  const onPreUpdate = () => {
    const now = performance.now();
    const dt = (now - lastTime) / 1000; // seconds
    lastTime = now;

    if (pressed.size === 0) {
      if (hud.el.style.opacity !== '0') hud.el.style.opacity = '0';
      return;
    }

    // Show HUD when flying.
    if (hud.el.style.opacity !== '1') hud.el.style.opacity = '1';

    // Determine movement direction flags.
    const forward = anyPressed(pressed, KEY_FORWARD);
    const backward = anyPressed(pressed, KEY_BACKWARD);
    const left = anyPressed(pressed, KEY_LEFT);
    const right = anyPressed(pressed, KEY_RIGHT);
    const up = anyPressed(pressed, KEY_UP);
    const down = anyPressed(pressed, KEY_DOWN);
    const boost = anyPressed(pressed, KEY_BOOST);

    // Adaptive speed based on altitude. At 100 m above ground: ~10 m/s
    // at multiplier 1; at 100 km: ~10 km/s. Linear interpolation in log
    // space gives natural feel across the entire altitude range.
    const height = getAltitude(Cesium, camera);
    const baseSpeed = Math.max(height * 0.1, 1); // 10% of altitude, min 1 m/s
    const speed = baseSpeed * speedMultiplier * (boost ? 5 : 1);
    const move = speed * dt;

    // Apply movement in camera-local space.
    if (forward) camera.moveForward(move);
    if (backward) camera.moveBackward(move);
    if (left) camera.moveLeft(move);
    if (right) camera.moveRight(move);
    if (up) camera.moveUp(move);
    if (down) camera.moveDown(move);

    updateHUD(hud, camera, speedMultiplier);
  };

  const removePreUpdate = scene.preUpdate.addEventListener(onPreUpdate);

  // ----- Cleanup handle -----------------------------------------------
  return {
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('wheel', onWheel);
      removePreUpdate();
      hud.el.remove();
      pressed.clear();
    },
  };
}

/**
 * Convenience wrapper — removes flight controls if the handle exists.
 *
 * @param {FlightControlHandle | null} handle
 */
export function removeFlightControls(handle) {
  if (handle?.destroy) handle.destroy();
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Check whether any key in a set is currently pressed.
 *
 * @param {Set<string>} pressed
 * @param {Set<string>} keySet
 * @returns {boolean}
 */
function anyPressed(pressed, keySet) {
  for (const k of keySet) {
    if (pressed.has(k)) return true;
  }
  return false;
}

/**
 * Get the camera's altitude above the WGS84 ellipsoid in metres.
 *
 * @param {typeof Cesium} Cesium
 * @param {Cesium.Camera} camera
 * @returns {number}
 */
function getAltitude(Cesium, camera) {
  const carto = camera.positionCartographic;
  return carto ? Math.max(carto.height, 0) : 1000;
}

// ---------------------------------------------------------------------------
// Flight HUD — small overlay showing altitude, speed, coordinates.
// ---------------------------------------------------------------------------

/**
 * Create a minimal flight-info HUD anchored to the bottom-right.
 *
 * @param {HTMLElement} container
 * @returns {{ el: HTMLElement, altitude: HTMLElement, speed: HTMLElement, coords: HTMLElement }}
 */
function createHUD(container) {
  const el = document.createElement('div');
  el.className = 'world3d-hud';
  el.style.opacity = '0';
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
    <div class="world3d-hud-hint">WASD — полёт · Ctrl — ускорение · Колесо — скорость</div>
  `;
  container.appendChild(el);
  return {
    el,
    altitude: el.querySelector('[data-field="altitude"]'),
    speed: el.querySelector('[data-field="speed"]'),
    coords: el.querySelector('[data-field="coords"]'),
  };
}

/**
 * Update HUD readouts. Called every frame when flying.
 */
function updateHUD(hud, camera, speedMul) {
  const Cesium = window.Cesium;
  if (!Cesium) return;

  const carto = camera.positionCartographic;
  if (!carto) return;

  const altM = carto.height;
  hud.altitude.textContent =
    altM > 10_000
      ? (altM / 1000).toFixed(1) + ' km'
      : Math.round(altM) + ' m';

  hud.speed.textContent = '×' + speedMul.toFixed(1);

  const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(4);
  const lng = Cesium.Math.toDegrees(carto.longitude).toFixed(4);
  hud.coords.textContent = `${lat}°, ${lng}°`;
}
