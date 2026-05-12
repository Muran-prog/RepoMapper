/**
 * Device capability detection and performance profiles.
 *
 * Cart adapts its rendering, label density and gesture handling based on
 * what the user's device can comfortably do. This module is the single
 * source of truth for those decisions:
 *
 *   detectCaps()        → snapshot of relevant browser capabilities
 *   deriveProfile(caps) → 'high' | 'medium' | 'low'
 *   getProfileConfig()  → rendering & density knobs for the given profile
 *   getTouchTuning()    → MapLibre constructor flags tuned for touch UX
 *   watchViewport()     → fire callback on responsive media-query changes
 *
 * Nothing here mutates the DOM or the map — consumers pull values and
 * decide what to do with them. That keeps the layering clean: device →
 * style/createMap/UI consume → render.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DeviceCaps
 * @property {boolean} isTouch              True if the device reports touch points.
 * @property {boolean} isCoarse             matchMedia(pointer: coarse).
 * @property {boolean} hasFinePointer       matchMedia(pointer: fine).
 * @property {boolean} hasHover             matchMedia(hover: hover).
 * @property {number}  dpr                  devicePixelRatio, clamped to [1, 3].
 * @property {number|null} memory           navigator.deviceMemory (GB) if exposed.
 * @property {number|null} cores            navigator.hardwareConcurrency.
 * @property {string|null}  connection      'slow-2g'|'2g'|'3g'|'4g'|... if exposed.
 * @property {boolean} saveData             True if the user requested data savings.
 * @property {boolean} prefersReducedMotion Honour OS-level reduce-motion.
 * @property {boolean} narrow               matchMedia(max-width: 720px).
 * @property {boolean} landscape            matchMedia(orientation: landscape).
 * @property {number}  viewportWidth        Current innerWidth (px).
 * @property {number}  viewportHeight       Current innerHeight (px).
 */

/** @returns {DeviceCaps} */
export function detectCaps() {
  if (typeof window === 'undefined') {
    // Server-side / Node smoke test fallback: assume desktop.
    return {
      isTouch: false,
      isCoarse: false,
      hasFinePointer: true,
      hasHover: true,
      dpr: 1,
      memory: 8,
      cores: 8,
      connection: '4g',
      saveData: false,
      prefersReducedMotion: false,
      narrow: false,
      landscape: true,
      viewportWidth: 1920,
      viewportHeight: 1080,
    };
  }

  const m = (q) => window.matchMedia(q).matches;
  const conn = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;

  return {
    isTouch: 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0,
    isCoarse: m('(pointer: coarse)'),
    hasFinePointer: m('(pointer: fine)'),
    hasHover: m('(hover: hover)'),
    dpr: Math.min(window.devicePixelRatio || 1, 3),
    memory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    connection: conn?.effectiveType ?? null,
    saveData: !!conn?.saveData,
    prefersReducedMotion: m('(prefers-reduced-motion: reduce)'),
    narrow: m('(max-width: 720px)'),
    landscape: m('(orientation: landscape)'),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

// ---------------------------------------------------------------------------
// Profile derivation
// ---------------------------------------------------------------------------

/**
 * Map capabilities to a coarse performance bucket.
 *
 * Scoring tries to be conservative: when a signal is missing we assume the
 * mid-case so a Firefox iPad doesn't get the same treatment as a low-end
 * Android. Save-Data and 2G connections immediately downgrade to `'low'`.
 *
 * @param {DeviceCaps} caps
 * @returns {'high'|'medium'|'low'}
 */
export function deriveProfile(caps) {
  if (!caps) return 'medium';
  if (caps.saveData) return 'low';
  if (caps.connection === '2g' || caps.connection === 'slow-2g') return 'low';

  let score = 0;

  // RAM
  if (caps.memory != null) {
    if (caps.memory >= 8) score += 2;
    else if (caps.memory >= 4) score += 1;
    else if (caps.memory <= 2) score -= 2;
  } else if (!caps.isTouch) {
    score += 1; // unknown + desktop → assume okay
  }

  // CPU
  if (caps.cores != null) {
    if (caps.cores >= 8) score += 2;
    else if (caps.cores >= 4) score += 1;
    else if (caps.cores <= 2) score -= 1;
  }

  // Network
  if (caps.connection === '4g' || caps.connection === '5g') score += 1;
  else if (caps.connection === '3g') score -= 1;

  // Form factor
  if (caps.hasHover && caps.hasFinePointer) score += 1; // desktop bonus
  if (caps.narrow) score -= 1; // small physical viewport often == weaker GPU

  // Pixel density tax (rendering 3x is expensive on weak GPUs)
  if (caps.dpr >= 3) score -= 1;

  if (score >= 4) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Per-profile configuration. Higher profiles spend more on visual fidelity
// (cache, fade-in, antialias, 3D, label density); lower profiles bias for
// frame rate and memory.
// ---------------------------------------------------------------------------

const PROFILE_DEFAULTS = Object.freeze({
  high: Object.freeze({
    maxTileCacheSize: 512,
    fadeDuration: 220,
    antialias: true,
    refreshExpiredTiles: true,
    // Style toggles
    buildings3D: true,
    labelDensity: 1.0,
    placeRankCutoff: 12,
    poiRankCutoff: 6,
    poiDotRankCutoff: 8,
    textPaddingMul: 1.0,
    poiSizeMul: 1.0,
    enableNeighbourhoods: true,
    enableHamlets: true,
    enableSuburbs: true,
    // Interaction
    flyToSpeed: 1.4,
  }),
  medium: Object.freeze({
    maxTileCacheSize: 256,
    fadeDuration: 160,
    antialias: true,
    refreshExpiredTiles: true,
    buildings3D: true,
    labelDensity: 0.85,
    placeRankCutoff: 10,
    poiRankCutoff: 5,
    poiDotRankCutoff: 7,
    textPaddingMul: 1.15,
    poiSizeMul: 1.1,
    enableNeighbourhoods: true,
    enableHamlets: true,
    enableSuburbs: true,
    flyToSpeed: 1.3,
  }),
  low: Object.freeze({
    maxTileCacheSize: 128,
    fadeDuration: 100,
    antialias: false,
    refreshExpiredTiles: false,
    buildings3D: false,
    labelDensity: 0.65,
    placeRankCutoff: 7,
    poiRankCutoff: 4,
    poiDotRankCutoff: 6,
    textPaddingMul: 1.35,
    poiSizeMul: 1.2,
    enableNeighbourhoods: false,
    enableHamlets: false,
    enableSuburbs: true,
    flyToSpeed: 1.1,
  }),
});

/**
 * @param {'high'|'medium'|'low'} profile
 * @returns {object} A copy of the profile config (mutable by callers).
 */
export function getProfileConfig(profile) {
  return { ...PROFILE_DEFAULTS[profile] ?? PROFILE_DEFAULTS.medium };
}

// ---------------------------------------------------------------------------
// MapLibre touch tuning. Returns the subset of Map constructor options that
// should be overridden when the user is on a touch device.
// ---------------------------------------------------------------------------

/**
 * @param {DeviceCaps} caps
 * @returns {object|null} Partial Map options, or null on non-touch devices.
 */
export function getTouchTuning(caps) {
  if (!caps?.isTouch) return null;
  return {
    // Single-finger pan, two-finger pinch-zoom / rotate, two-finger drag pitch
    boxZoom: false,             // mouse-only feature
    keyboard: false,            // mobile keyboards take screen real estate
    dragRotate: !caps.narrow,   // on small phones, rotating mid-pan is annoying
    pitchWithRotate: !caps.narrow,
    touchZoomRotate: true,
    touchPitch: true,
    // We're a full-screen app, not embedded in a scrolling document —
    // single-finger pan should work without a two-finger requirement.
    cooperativeGestures: false,
    doubleClickZoom: true,
  };
}

// ---------------------------------------------------------------------------
// Responsive viewport watching. The UI needs to know when the user rotates
// the device or resizes the window, so it can re-render layout pieces.
// ---------------------------------------------------------------------------

/**
 * Invoke `callback(newCaps)` when the viewport changes shape in a way that
 * matters for layout (narrow/wide breakpoint, orientation, plain resize).
 *
 * Returns an unsubscribe function.
 *
 * @param {(caps: DeviceCaps) => void} callback
 */
export function watchViewport(callback) {
  if (typeof window === 'undefined') return () => {};

  const mqs = [
    window.matchMedia('(max-width: 720px)'),
    window.matchMedia('(max-width: 1024px)'),
    window.matchMedia('(orientation: landscape)'),
    window.matchMedia('(hover: hover)'),
    window.matchMedia('(pointer: coarse)'),
  ];

  let raf = 0;
  const handler = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => callback(detectCaps()));
  };

  for (const mq of mqs) mq.addEventListener?.('change', handler);
  window.addEventListener('resize', handler, { passive: true });
  window.addEventListener('orientationchange', handler, { passive: true });

  return () => {
    for (const mq of mqs) mq.removeEventListener?.('change', handler);
    window.removeEventListener('resize', handler);
    window.removeEventListener('orientationchange', handler);
    cancelAnimationFrame(raf);
  };
}
