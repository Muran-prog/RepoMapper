/**
 * Bootstrap.
 *
 * Wires device detection, the rendering pipeline (createMap), interaction
 * tuning, UI controls, the perf monitor, and the HUD. Everything else is
 * concerned with its own domain — this file only orchestrates the lifecycle.
 */

import { createMap } from './map/createMap.js';
import { installInteractionTuning } from './map/interactions.js';
import { mountControls } from './ui/controls.js';
import { mountHUD } from './ui/hud.js';
import { createPerfMonitor } from './perf/monitor.js';
import { detectCaps, deriveProfile, watchViewport } from './device.js';
import { FEATURES } from './config.js';
import { ensureAuthenticated, installAuthWatcher } from './ui/auth-gate.js';
import { initAccountState, flushPending } from './state/account-store.js';

async function boot() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app container missing from DOM');

  // ----- Authentication gate -------------------------------------------
  // The map cannot be used without an account. Block here until the user
  // is logged in; the map is not even created before this resolves.
  root.dataset.state = 'auth';
  const user = await ensureAuthenticated();
  window.__cart_user = user;

  // Re-show the gate if the session expires mid-session. We flush any
  // queued edits with the restored session, then reload for a clean,
  // fully-synchronised state — no edits are lost.
  installAuthWatcher(async () => {
    try { await flushPending(); } catch {}
    window.location.reload();
  });

  // ----- Account state -------------------------------------------------
  // The server is the single source of truth for every persisted setting,
  // preference, drawing and contour. Load the whole account snapshot ONCE,
  // here, before the map or any UI is built — so every synchronous helper
  // read below (map mode, draw features, hypso ramps, layer toggles…) sees
  // the hydrated, account-correct values. No localStorage in steady state.
  await initAccountState();

  // Mark the app as booting so CSS can render the splash overlay.
  root.dataset.state = 'booting';

  // ----- Device detection ----------------------------------------------
  const caps = detectCaps();
  const profile = deriveProfile(caps);

  // Stamp data-attributes on <html> so CSS can use them as selectors.
  applyDeviceAttributes(caps, profile);

  // ----- DOM refs ------------------------------------------------------
  const mapEl = document.getElementById('map');
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const hudRoot = document.getElementById('hud');

  // ----- Map -----------------------------------------------------------
  let map;
  try {
    map = await createMap(mapEl, { caps, profile });
  } catch (err) {
    showFatal(root, err);
    throw err;
  }

  installInteractionTuning(map, { caps });
  mountControls(map, sidebar, scrim, { caps, profile });

  if (FEATURES.hud) {
    const perf = createPerfMonitor(map);
    perf.start();
    mountHUD(map, perf, hudRoot, { caps });
  }

  // ----- Responsive listeners -----------------------------------------
  // Reflect orientation / viewport changes on <html> so CSS can react. We
  // never re-derive the *performance* profile (RAM/CPU don't change), but
  // we do want the layout media-query data to stay current for JS too.
  watchViewport((newCaps) => applyDeviceAttributes(newCaps, profile));

  // ----- First-paint signal -------------------------------------------
  map.once('idle', () => {
    root.dataset.state = 'ready';
  });

  // Resize the map after a brief delay to settle iOS Safari URL-bar
  // collapse, which otherwise leaves a black strip at the bottom.
  setTimeout(() => map.resize(), 100);
  window.addEventListener('orientationchange', () =>
    setTimeout(() => map.resize(), 200),
  );

  // Expose for ad-hoc console exploration during development.
  window.__cart = { map, caps, profile };
}

/**
 * Stamp device attributes on the document element so CSS can use them as
 * selectors (`[data-touch=1]`, `[data-narrow=1]`, etc.).
 */
function applyDeviceAttributes(caps, profile) {
  const html = document.documentElement;
  html.dataset.touch = caps.isTouch ? '1' : '0';
  html.dataset.hover = caps.hasHover ? '1' : '0';
  html.dataset.narrow = caps.narrow ? '1' : '0';
  html.dataset.landscape = caps.landscape ? '1' : '0';
  html.dataset.reduceMotion = caps.prefersReducedMotion ? '1' : '0';
  html.dataset.profile = profile;
  html.dataset.pointer = caps.isCoarse ? 'coarse' : 'fine';
}

function showFatal(root, err) {
  root.dataset.state = 'error';
  const msg = (err && err.message) || String(err);
  const fatal = document.createElement('div');
  fatal.className = 'fatal';
  fatal.innerHTML = `
    <h1>Не удалось инициализировать карту</h1>
    <pre>${msg}</pre>
    <p>Проверьте сеть: запросы к тайлам/источникам/глифам должны достигать
       <code>tiles.openfreemap.org</code>.</p>
  `;
  root.appendChild(fatal);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
