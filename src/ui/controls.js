/**
 * UI controls — dock + popover panels.
 *
 * The redesigned shell promotes the map to a fullscreen canvas. All UI
 * surfaces float on top as small glass-morphism components:
 *
 *   • Brand chip (top-left)         — logo + product name
 *   • Floating dock (left edge)     — five icon buttons + theme toggle
 *   • Popover panels (next to dock) — one per dock button; small,
 *                                     animated, focus-trapped
 *   • HUD pill (bottom-left)        — FPS / Zoom / Tiles / coords
 *
 * Each dock icon toggles its panel via a tiny controller that handles
 * keyboard (Esc, Tab), outside-pointer dismissal, and scrim sync on
 * mobile bottom-sheet form. The same DOM is used at every breakpoint;
 * CSS swaps between popover and bottom-sheet visuals.
 *
 * Panel inventory:
 *   layers   — base layers (labels, POIs, 3D buildings)
 *   relief   — relief stack + exaggeration slider
 *   hypso    — hypsometric subsystem (ramp picker + stats + profile)
 *   places   — fly-to presets (cities + Carpathian peaks)
 *   settings — quality picker + tips + meta
 *
 * Theme toggle lives as a sun/moon button at the bottom of the dock.
 */

import { applyStyle } from '../map/createMap.js';
import { flyToPreset, setUserExaggeration } from '../map/interactions.js';
import { getProfileConfig } from '../device.js';
import { FEATURES, DEFAULT_THEME } from '../config.js';
import { mountHypsoUI } from './hypso/index.js';
import { loadUiPrefs, saveUiPrefs } from './store.js';

// ---------------------------------------------------------------------------
// Icon SVGs — Lucide-style line icons. Single-stroke, 1.75 width, rounded
// caps. Inlined as template strings so we keep the no-bundler footprint
// minimal and don't need a sprite sheet.
// ---------------------------------------------------------------------------

const ICONS = {
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L21 8 L12 13 L3 8 Z"/><path d="M3 17 L12 22 L21 17"/><path d="M3 12.5 L12 17.5 L21 12.5"/></svg>`,
  mountain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20 L9.5 9 L13 14.5 L17 7 L21 20 Z"/><circle cx="17" cy="5.4" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  waves: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7 Q 7.5 4 12 7 T 21 7"/><path d="M3 12 Q 7.5 9 12 12 T 21 12"/><path d="M3 17 Q 7.5 14 12 17 T 21 17"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22 S 5 14.5 5 9.5 a7 7 0 0 1 14 0 c0 5 -7 12.5 -7 12.5 z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="21.5" y2="12"/><line x1="5.1" y1="5.1" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="18.9" y2="5.1"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8 A9 9 0 1 1 11.2 3 a7 7 0 0 0 9.8 9.8 z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"/></svg>`,
  brand: `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M6 17 L13 23 L26 9" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // 7-dot "more" glyph used by the MapLibre-controls collapse anchor.
  // Single-stroke chevron pair so it reads as "reveal a stack".
  controlsChev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9 L12 14 L17 9"/><path d="M7 15 L12 20 L17 15" opacity="0.5"/></svg>`,
};

// ---------------------------------------------------------------------------
// MapLibre-native controls (top-right column) + collapse anchor.
//
// The MapLibre ScaleControl is intentionally OMITTED here: the redesigned
// shell installs a custom vertical scale beside the dock (see
// `installVerticalScale`), which avoids colliding with the HUD pill at
// bottom-left while keeping the whole composition on a single visual
// rhythm.
// ---------------------------------------------------------------------------

function installNativeControls(map, { caps }) {
  const ml = window.maplibregl;

  map.addControl(
    new ml.NavigationControl({
      visualizePitch: true,
      showZoom: true,
      showCompass: true,
    }),
    'top-right',
  );

  map.addControl(
    new ml.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showUserHeading: true,
      fitBoundsOptions: { maxZoom: 15 },
    }),
    'top-right',
  );

  map.addControl(new ml.AttributionControl({ compact: false }), 'bottom-right');

  map.addControl(new ml.FullscreenControl({}), 'top-right');

  // Inject the collapse anchor at the top of the top-right column.
  // Order matters — we want the anchor to render first so the cascade
  // of native controls reveals beneath it.
  installControlsToggle(map, { caps });
}

/**
 * Inject a glass-style anchor button at the top of the top-right MapLibre
 * column. Toggling it collapses the native controls down to just the
 * anchor; expanding plays a cascade reveal animation driven entirely by
 * CSS transition delays (no JS frame loop).
 *
 * Persistence: state survives reload via `src/ui/store.js`. The default
 * is collapsed on touch / narrow viewports so the chrome doesn't crowd
 * the canvas on phones.
 */
function installControlsToggle(map, { caps } = {}) {
  const container = map.getContainer();
  const topRight = container.querySelector('.maplibregl-ctrl-top-right');
  if (!topRight) return;

  // Mark the column so CSS can target its children for the cascade.
  topRight.classList.add('maplibregl-ctrl-stack');

  const defaultCollapsed = !!(caps?.isTouch || caps?.narrow);
  const prefs = loadUiPrefs({ controlsCollapsed: defaultCollapsed });
  let collapsed = prefs.controlsCollapsed;

  // The anchor itself is a MapLibre-styled "ctrl-group" so it inherits
  // the same glass/blur/border treatment as the native cells next to it.
  const anchor = document.createElement('div');
  anchor.className = 'maplibregl-ctrl maplibregl-ctrl-group ctrl-anchor';
  anchor.innerHTML = `
    <button type="button"
            class="ctrl-anchor-btn"
            data-ctl="controls-toggle"
            aria-controls="maplibregl-ctrl-top-right"
            aria-expanded="${collapsed ? 'false' : 'true'}"
            aria-label="${collapsed ? 'Розгорнути контролі' : 'Згорнути контролі'}"
            title="${collapsed ? 'Розгорнути' : 'Згорнути'}">
      ${ICONS.controlsChev}
    </button>
  `;
  topRight.prepend(anchor);

  const setCollapsed = (next, { persist = true } = {}) => {
    collapsed = !!next;
    topRight.dataset.collapsed = collapsed ? 'true' : 'false';
    const btn = anchor.querySelector('button');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute(
        'aria-label',
        collapsed ? 'Розгорнути контролі' : 'Згорнути контролі',
      );
      btn.setAttribute('title', collapsed ? 'Розгорнути' : 'Згорнути');
    }
    if (persist) saveUiPrefs({ controlsCollapsed: collapsed });
  };
  setCollapsed(collapsed, { persist: false });

  anchor.querySelector('button').addEventListener('click', () => {
    setCollapsed(!collapsed);
  });
}

/**
 * Custom vertical scale — a thin glass card with a small bar, mono-spaced
 * label and live MapLibre updates. Anchored under the dock so the
 * left-edge stays a single visual stripe (dock → scale) instead of two
 * unrelated islands like the MapLibre default.
 *
 * The bar uses MapLibre's "nice number" rounding so the label reads as a
 * clean 1/2/3/5/10×10ⁿ distance even as the user zooms.
 */
function installVerticalScale(map, scaleHost) {
  if (!scaleHost) return () => {};
  scaleHost.classList.add('cart-scale-host');
  scaleHost.innerHTML = `
    <div class="cart-scale" role="img" aria-label="Масштаб карти">
      <span class="cart-scale-label" data-ctl="scale-label">—</span>
      <div class="cart-scale-bar" aria-hidden="true">
        <span class="cart-scale-fill" data-ctl="scale-fill"></span>
        <span class="cart-scale-tick" data-pos="0"></span>
        <span class="cart-scale-tick" data-pos="100"></span>
      </div>
    </div>
  `;
  const label = scaleHost.querySelector('[data-ctl="scale-label"]');
  const fill = scaleHost.querySelector('[data-ctl="scale-fill"]');

  // Bar height in CSS pixels. Anything below ~36 px would feel meagre;
  // anything above ~80 px starts fighting the dock for vertical space.
  const BAR_PX = 56;

  /** Round a metres value to the nearest "map-friendly" number. Mirrors
   *  MapLibre's internal scale implementation. */
  const getRoundNum = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const pow10 = Math.pow(10, String(Math.floor(n)).length - 1);
    let d = n / pow10;
    if (d >= 10) d = 10;
    else if (d >= 5) d = 5;
    else if (d >= 3) d = 3;
    else if (d >= 2) d = 2;
    else if (d >= 1) d = 1;
    else d = 0.5;
    return pow10 * d;
  };

  const formatDistance = (m) => {
    if (m >= 1000) {
      const km = m / 1000;
      const display = km >= 10 ? Math.round(km) : km.toFixed(1).replace(/\.0$/, '');
      return `${display} км`;
    }
    return `${Math.round(m)} м`;
  };

  const update = () => {
    const canvas = map.getCanvas();
    const h = canvas?.clientHeight ?? 0;
    if (h <= 0) return;
    const cx = (canvas?.clientWidth ?? 0) / 2;
    let metresPerBar;
    try {
      const top = map.unproject([cx, Math.max(0, h - BAR_PX)]);
      const bottom = map.unproject([cx, h]);
      metresPerBar = bottom.distanceTo(top);
    } catch {
      metresPerBar = 0;
    }
    if (!Number.isFinite(metresPerBar) || metresPerBar <= 0) {
      label.textContent = '—';
      if (fill) fill.style.height = '0px';
      return;
    }
    const round = getRoundNum(metresPerBar);
    const ratio = Math.min(1, round / metresPerBar);
    label.textContent = formatDistance(round);
    if (fill) fill.style.height = `${(BAR_PX * ratio).toFixed(1)}px`;
  };

  map.on('move', update);
  map.on('zoom', update);
  map.on('resize', update);
  if (map.loaded?.()) update();
  else map.once('load', update);
  // Always run once now — if the map is already idle by the time we
  // hook up, the listener above wouldn't fire until the next move.
  requestAnimationFrame(update);

  return () => {
    map.off('move', update);
    map.off('zoom', update);
    map.off('resize', update);
  };
}

// ---------------------------------------------------------------------------
// Render helpers — one function per panel + one for the dock + chip.
//
// Each panel render produces innerHTML for a `<section class="panel">`
// that the dock controller will toggle via the `data-open` attribute.
// ---------------------------------------------------------------------------

function renderChip(host) {
  host.innerHTML = `
    <div class="chip" role="presentation">
      <span class="chip-logo">${ICONS.brand}</span>
      <span><strong>Cart</strong></span>
      <span class="chip-sub">· Україна</span>
    </div>
  `;
}

function renderDock(host) {
  host.classList.add('dock');
  host.setAttribute('role', 'toolbar');
  host.setAttribute('aria-label', 'Інструменти карти');
  host.innerHTML = `
    <header class="dock-brand">
      <button class="dock-logo" type="button" data-ctl="home" title="До центру України" aria-label="Fly to centre of Ukraine">${ICONS.brand}</button>
    </header>
    <nav class="dock-nav" aria-label="Панелі">
      <button class="dock-btn" type="button" data-panel="layers"   data-tip="Шари"        aria-label="Шари"        aria-expanded="false">${ICONS.layers}</button>
      <button class="dock-btn" type="button" data-panel="relief"   data-tip="Рельєф"      aria-label="Рельєф"      aria-expanded="false">${ICONS.mountain}</button>
      <button class="dock-btn" type="button" data-panel="hypso"    data-tip="Гіпсометрія" aria-label="Гіпсометрія" aria-expanded="false">${ICONS.waves}</button>
      <button class="dock-btn" type="button" data-panel="places"   data-tip="Місця"       aria-label="Місця"       aria-expanded="false">${ICONS.pin}</button>
      <button class="dock-btn" type="button" data-panel="settings" data-tip="Налаштування" aria-label="Налаштування" aria-expanded="false">${ICONS.sliders}</button>
    </nav>
    <footer class="dock-foot">
      <button class="dock-btn theme-toggle" type="button" data-ctl="theme-toggle" data-tip="Тема" aria-label="Перемкнути тему">${ICONS.moon}</button>
    </footer>
  `;
}

function panelShell(id, title, iconKey, body) {
  return `
    <section
      class="panel"
      data-panel-id="${id}"
      data-open="false"
      role="dialog"
      aria-modal="false"
      aria-label="${title}"
      aria-hidden="true"
    >
      <header class="panel-head">
        <div class="panel-title">${ICONS[iconKey]}<span>${title}</span></div>
        <button class="panel-close" type="button" aria-label="Закрити панель" data-ctl="close-panel">${ICONS.close}</button>
      </header>
      <div class="panel-body">${body}</div>
    </section>
  `;
}

function renderLayersPanelBody() {
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Display</h4>
      <div class="rows">
        <label class="row"><span>Labels</span><input type="checkbox" data-ctl="labels" checked></label>
        <label class="row"><span>Points of interest</span><input type="checkbox" data-ctl="pois" checked></label>
        <label class="row"><span>3D buildings</span><input type="checkbox" data-ctl="b3d" checked></label>
      </div>
    </div>
    <p class="panel-meta">Toggle the visual layers rendered on top of the base map. Changes
    apply instantly without re-fetching tiles.</p>
  `;
}

function renderReliefPanelBody() {
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Layers</h4>
      <div class="rows">
        <label class="row"><span>Hillshade</span><input type="checkbox" data-ctl="hillshade" checked></label>
        <label class="row"><span>3D terrain</span><input type="checkbox" data-ctl="terrain3D" checked></label>
        <label class="row"><span>Contours</span><input type="checkbox" data-ctl="contours" checked></label>
        <label class="row"><span>Hypsometric tint</span><input type="checkbox" data-ctl="hypsometricTint"></label>
        <label class="row"><span>Bathymetry</span><input type="checkbox" data-ctl="bathymetry"></label>
        <label class="row"><span>Texture shading</span><input type="checkbox" data-ctl="textureShading"></label>
        <label class="row"><span>Ridge overlay</span><input type="checkbox" data-ctl="ridgeOverlay"></label>
        <label class="row"><span>Carpathian detail</span><input type="checkbox" data-ctl="carpathian"></label>
      </div>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Vertical exaggeration</h4>
      <div class="slider-row">
        <label class="slider-label" for="exaggeration">
          <span>0.5× – 2×</span>
          <span data-ctl="exaggeration-readout">1.0×</span>
        </label>
        <input
          id="exaggeration"
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value="1"
          data-ctl="exaggeration"
          aria-label="Vertical exaggeration"
        />
      </div>
    </div>
  `;
}

function renderHypsoPanelBody() {
  return `
    <!-- Hypsometric subsystem mount point. mountHypsoUI() renders
         the ramp picker, strength slider, bathymetry + high-contrast
         toggles into this slot. -->
    <div data-ctl="hypso-picker"></div>

    <div class="panel-group" data-ctl="hypso-profile-launcher" hidden>
      <button class="btn-block" type="button" data-ctl="open-profile">
        <span>Намалювати профіль висот</span>
      </button>
    </div>

    <div class="panel-group hypso-stats" data-ctl="hypso-stats" hidden>
      <span><span class="hypso-stat-label">min</span><span data-ctl="hypso-stat-min">— м</span></span>
      <span><span class="hypso-stat-label">mean</span><span data-ctl="hypso-stat-mean">— м</span></span>
      <span><span class="hypso-stat-label">max</span><span data-ctl="hypso-stat-max">— м</span></span>
      <span><span class="hypso-stat-label">region</span><span data-ctl="hypso-stat-region">—</span></span>
    </div>
  `;
}

function renderPlacesPanelBody() {
  const city = (id, label, sub) => `
    <button data-preset="${id}" type="button">
      <span class="dot"></span>
      <span>
        <strong>${label}</strong>
        ${sub ? `<small>${sub}</small>` : ''}
      </span>
    </button>
  `;
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Україна</h4>
      <div class="presets" data-ctl="presets">
        ${city('ukraine',     'Україна',  'overview')}
        ${city('kyiv',        'Київ',     'столиця')}
        ${city('lviv',        'Львів',    '')}
        ${city('odesa',       'Одеса',    '')}
        ${city('kharkiv',     'Харків',   '')}
        ${city('carpathians', 'Карпати',  'регіон')}
      </div>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Carpathian peaks</h4>
      <div class="presets" data-ctl="presets">
        ${city('hoverla',    'Говерла',   '2061 м')}
        ${city('pip_ivan',   'Піп Іван',  '2028 м')}
        ${city('petros',     'Петрос',    '2020 м')}
        ${city('svydovets',  'Свидовець', 'хребет')}
        ${city('chornohora', 'Чорногора', 'хребет')}
      </div>
    </div>
  `;
}

function renderSettingsPanelBody() {
  return `
    <div class="panel-group">
      <h4 class="panel-group-title">Quality</h4>
      <div class="seg seg-3" role="tablist" data-ctl="quality">
        <button data-value="auto" role="tab" type="button">Auto</button>
        <button data-value="high" role="tab" type="button">High</button>
        <button data-value="low"  role="tab" type="button">Eco</button>
      </div>
      <p class="panel-meta">Auto reads device memory, CPU and connection to balance fidelity with frame rate. Switch to Eco on slower devices, High for the full visual treatment.</p>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Shortcuts</h4>
      <ul class="tips" data-pointer="fine">
        <li><kbd>Scroll</kbd> Zoom in / out</li>
        <li><kbd>Drag</kbd> Pan the map</li>
        <li><kbd>Shift</kbd>+<kbd>Drag</kbd> Rotate &amp; tilt</li>
        <li><kbd>Ctrl</kbd>+<kbd>Click</kbd> Fly to point</li>
        <li><kbd>Esc</kbd> Close active panel</li>
      </ul>
      <ul class="tips" data-pointer="coarse">
        <li><kbd>Pinch</kbd> Zoom</li>
        <li><kbd>2 fingers</kbd> Tilt &amp; rotate</li>
        <li><kbd>Double-tap</kbd> Zoom in</li>
        <li><kbd>Tap outside</kbd> Close panel</li>
      </ul>
    </div>
    <p class="panel-meta">Cart — vector cartography on MapLibre GL JS. Tile data © OpenMapTiles + OpenStreetMap contributors.</p>
  `;
}

function renderPanels(host) {
  host.innerHTML = `
    ${panelShell('layers',   'Шари',         'layers',   renderLayersPanelBody())}
    ${panelShell('relief',   'Рельєф',       'mountain', renderReliefPanelBody())}
    ${panelShell('hypso',    'Гіпсометрія',  'waves',    renderHypsoPanelBody())}
    ${panelShell('places',   'Місця',        'pin',      renderPlacesPanelBody())}
    ${panelShell('settings', 'Налаштування', 'sliders',  renderSettingsPanelBody())}
  `;
}

// ---------------------------------------------------------------------------
// Dock controller — toggles panels, handles outside-click + keyboard.
// ---------------------------------------------------------------------------

class DockController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.dock       Element holding the icon buttons.
   * @param {HTMLElement} opts.panelsHost Element that wraps every <section.panel>.
   * @param {HTMLElement|null} opts.scrim Backdrop element for mobile sheet.
   * @param {object} opts.caps            Device capabilities.
   */
  constructor({ dock, panelsHost, scrim, caps }) {
    this.dock = dock;
    this.panelsHost = panelsHost;
    this.scrim = scrim;
    this.caps = caps;
    this.entries = new Map();
    this.activeId = null;
    this.mqMobile = window.matchMedia('(max-width: 540px)');
  }

  register(id) {
    const button = this.dock.querySelector(`.dock-btn[data-panel="${id}"]`);
    const panel = this.panelsHost.querySelector(`.panel[data-panel-id="${id}"]`);
    if (!button || !panel) return null;
    this.entries.set(id, { button, panel });

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle(id);
    });
    panel.querySelector('[data-ctl="close-panel"]')?.addEventListener('click', () => {
      this.close();
    });
    this.installDragHandle(panel);
    return { button, panel };
  }

  /**
   * Wire the mobile bottom-sheet drag-to-close gesture.
   *
   * On touch viewports the panel reads as a bottom-sheet: the user can
   * pull it down by its head / drag handle to dismiss. We use Pointer
   * Events (with `setPointerCapture`) so the gesture survives the
   * pointer leaving the head element, and we close on either:
   *   – downward distance > 25 % of the panel height, OR
   *   – downward velocity > 0.5 px/ms (an inertial flick).
   *
   * If neither threshold is met we spring the panel back to the open
   * position. While dragging we disable transitions (manual translate)
   * and re-enable them on release so the spring-back animates.
   */
  installDragHandle(panel) {
    const head = panel.querySelector('.panel-head');
    if (!head) return;

    let pointerId = null;
    let startY = 0;
    let startTime = 0;
    let dragY = 0;
    let lastY = 0;
    let lastT = 0;
    let dragging = false;

    const reset = () => {
      panel.style.transition = '';
      panel.style.transform = '';
      panel.removeAttribute('data-dragging');
      dragging = false;
      pointerId = null;
      dragY = 0;
    };

    const onDown = (e) => {
      // Only engage on mobile bottom-sheet form, and only the drag
      // handle area (avoid hijacking the close-button hitbox).
      if (!this.mqMobile.matches) return;
      if (e.target.closest('[data-ctl="close-panel"]')) return;
      if (panel.dataset.open !== 'true') return;
      pointerId = e.pointerId;
      startY = e.clientY;
      lastY = e.clientY;
      startTime = e.timeStamp;
      lastT = e.timeStamp;
      dragY = 0;
      dragging = true;
      panel.dataset.dragging = '1';
      panel.style.transition = 'none';
      try {
        head.setPointerCapture(pointerId);
      } catch {
        /* setPointerCapture can throw on stale ids — fall through */
      }
    };

    const onMove = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      // Allow only downward motion. Apply a soft rubber-band when the
      // user drags upward so the gesture still feels responsive.
      const raw = e.clientY - startY;
      dragY = raw > 0 ? raw : raw / 4;
      panel.style.transform = `translateY(${dragY}px)`;
      lastY = e.clientY;
      lastT = e.timeStamp;
    };

    const onUp = (e) => {
      if (!dragging || (e.pointerId != null && e.pointerId !== pointerId)) return;
      try {
        head.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      const distance = dragY;
      const dt = Math.max(1, e.timeStamp - lastT);
      // velocity in px/ms over the last sample window
      const velocity = dt > 0 ? (e.clientY - lastY) / dt : 0;
      const threshold = panel.offsetHeight * 0.25;
      reset();
      if (distance > threshold || velocity > 0.5) {
        this.close();
      }
    };

    head.addEventListener('pointerdown', onDown);
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
    head.addEventListener('pointercancel', onUp);
  }

  open(id) {
    if (this.activeId === id) return;
    if (this.activeId) this.close({ silent: true });
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.panel.dataset.open = 'true';
    entry.panel.setAttribute('aria-hidden', 'false');
    entry.button.dataset.active = 'true';
    entry.button.setAttribute('aria-expanded', 'true');
    this.activeId = id;
    if (this.scrim && this.mqMobile.matches) {
      this.scrim.dataset.visible = '1';
    }
    // Defer focus so the CSS transition has a paint to settle in.
    requestAnimationFrame(() => {
      const focusable = entry.panel.querySelector(
        'input:not([type=hidden]):not([disabled]), select, [tabindex]:not([tabindex="-1"]), .panel-close',
      );
      try {
        focusable?.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    });
  }

  close({ silent = false } = {}) {
    if (!this.activeId) return;
    const entry = this.entries.get(this.activeId);
    if (entry) {
      entry.panel.dataset.open = 'false';
      entry.panel.setAttribute('aria-hidden', 'true');
      entry.button.dataset.active = 'false';
      entry.button.setAttribute('aria-expanded', 'false');
      if (!silent) {
        try {
          entry.button.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    }
    if (this.scrim) this.scrim.dataset.visible = '0';
    this.activeId = null;
  }

  toggle(id) {
    if (this.activeId === id) this.close();
    else this.open(id);
  }

  /** Wire global handlers — Esc, outside-pointer, scrim, route changes. */
  install() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.activeId) {
        e.preventDefault();
        this.close();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.activeId) return;
      const entry = this.entries.get(this.activeId);
      if (!entry) return;
      const target = e.target;
      if (entry.panel.contains(target)) return;
      if (this.dock.contains(target)) return;
      this.close();
    }, true);
    this.scrim?.addEventListener('click', () => this.close());
    // Map clicks should close the panel on mobile (revealing the map).
    if (this.mqMobile.matches) {
      const mapEl = document.getElementById('map');
      mapEl?.addEventListener('pointerdown', () => {
        if (this.activeId) this.close();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------

/**
 * @param {maplibregl.Map} map
 * @param {HTMLElement}    sidebar       Host for the dock + panels.
 * @param {HTMLElement|null} scrim
 * @param {object} ctx
 * @param {DeviceCaps} ctx.caps
 * @param {string} ctx.profile
 */
export function mountControls(map, sidebar, scrim, { caps, profile } = {}) {
  installNativeControls(map, { caps });

  // Ensure / create the chip host. We append into #canvas so it sits in
  // the same stacking context as the map.
  const mapEl = document.getElementById('map');
  const canvas = mapEl?.parentElement || document.getElementById('app');
  let chipHost = document.getElementById('chip-host');
  if (!chipHost) {
    chipHost = document.createElement('div');
    chipHost.id = 'chip-host';
    chipHost.className = 'chip-host';
    canvas?.appendChild(chipHost);
  }
  renderChip(chipHost);

  // Build the dock host (the sidebar element) + the panels container +
  // the vertical scale host. The dock-root + scale share a left-edge
  // column visually; the panels live as a sibling node so their
  // absolute positioning is unaffected by the dock's flex layout.
  sidebar.className = '';
  sidebar.innerHTML = '';
  const dockHost = document.createElement('div');
  dockHost.className = 'dock-root';
  const panelsHost = document.createElement('div');
  panelsHost.className = 'panels-root';
  const scaleHost = document.createElement('div');
  scaleHost.className = 'cart-scale-host';
  sidebar.appendChild(dockHost);
  sidebar.appendChild(panelsHost);
  sidebar.appendChild(scaleHost);

  renderDock(dockHost);
  renderPanels(panelsHost);
  installVerticalScale(map, scaleHost);

  // ----- State the user can toggle -------------------------------------
  const state = {
    theme: DEFAULT_THEME,
    qualityChoice: 'auto',
    detectedProfile: profile ?? 'medium',
    layerFeatures: {
      labels: FEATURES.labels,
      pois: FEATURES.pois,
      buildings3D: FEATURES.buildings3D,
      hillshade: FEATURES.hillshade,
      terrain3D: FEATURES.terrain3D,
      contours: FEATURES.contours,
      hypsometricTint: FEATURES.hypsometricTint,
      bathymetry: FEATURES.bathymetry,
      textureShading: FEATURES.textureShading,
      ridgeOverlay: FEATURES.ridgeOverlay,
      carpathian: FEATURES.carpathian,
    },
  };
  const effectiveProfile = () =>
    state.qualityChoice === 'auto' ? state.detectedProfile : state.qualityChoice;

  const rebuildStyle = async () => {
    const profileName = effectiveProfile();
    await applyStyle(map, {
      theme: state.theme,
      profile: profileName,
      profileConfig: getProfileConfig(profileName, caps),
      featureOverrides: state.layerFeatures,
    });
  };

  // ----- Dock controller -----------------------------------------------
  const controller = new DockController({
    dock: dockHost,
    panelsHost,
    scrim,
    caps,
  });
  ['layers', 'relief', 'hypso', 'places', 'settings'].forEach((id) =>
    controller.register(id),
  );
  controller.install();

  // ----- Theme toggle (sun ↔ moon at the bottom of the dock) ----------
  const themeBtn = dockHost.querySelector('[data-ctl="theme-toggle"]');
  const syncTheme = () => {
    document.documentElement.dataset.theme = state.theme;
    if (themeBtn) {
      themeBtn.innerHTML = state.theme === 'dark' ? ICONS.sun : ICONS.moon;
      themeBtn.setAttribute(
        'data-tip',
        state.theme === 'dark' ? 'Світла тема' : 'Темна тема',
      );
      themeBtn.setAttribute(
        'aria-label',
        state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      );
    }
  };
  syncTheme();
  themeBtn?.addEventListener('click', async () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    syncTheme();
    await rebuildStyle();
  });

  // ----- Home button (fly to Ukraine centroid) ------------------------
  const homeBtn = dockHost.querySelector('[data-ctl="home"]');
  homeBtn?.addEventListener('click', () => {
    flyToPreset(map, 'ukraine', {
      reduceMotion: !!caps?.prefersReducedMotion,
    });
    if (caps?.narrow) controller.close();
  });

  // ----- Quality picker (in the Settings panel) -----------------------
  const qualBtns = panelsHost.querySelectorAll('[data-ctl=quality] button');
  const syncQuality = () => {
    qualBtns.forEach((b) =>
      b.classList.toggle('on', b.dataset.value === state.qualityChoice),
    );
  };
  syncQuality();
  qualBtns.forEach((b) =>
    b.addEventListener('click', async () => {
      if (state.qualityChoice === b.dataset.value) return;
      state.qualityChoice = b.dataset.value;
      syncQuality();
      await rebuildStyle();
    }),
  );

  // ----- Layer toggles -------------------------------------------------
  const wireToggle = (selector, key = selector) => {
    const el = panelsHost.querySelector(`[data-ctl=${selector}]`);
    if (!el) return;
    el.checked = !!state.layerFeatures[key];
    el.addEventListener('change', async () => {
      state.layerFeatures[key] = el.checked;
      await rebuildStyle();
    });
  };
  wireToggle('labels');
  wireToggle('pois');
  wireToggle('b3d', 'buildings3D');
  wireToggle('hillshade');
  wireToggle('terrain3D');
  wireToggle('contours');
  wireToggle('hypsometricTint');
  wireToggle('bathymetry');
  wireToggle('textureShading');
  wireToggle('ridgeOverlay');
  wireToggle('carpathian');

  // ----- Exaggeration slider ------------------------------------------
  const slider = panelsHost.querySelector('[data-ctl=exaggeration]');
  const readout = panelsHost.querySelector('[data-ctl=exaggeration-readout]');
  if (slider) {
    const updateFill = () => {
      const min = Number(slider.min);
      const max = Number(slider.max);
      const v = Number(slider.value);
      const pct = ((v - min) / (max - min)) * 100;
      slider.style.setProperty('--fill', `${pct}%`);
    };
    const update = () => {
      const v = Number(slider.value);
      if (readout) readout.textContent = `${v.toFixed(1)}×`;
      setUserExaggeration(map, v);
      updateFill();
    };
    slider.addEventListener('input', update);
    update();
  }

  // ----- Preset buttons (Places panel) --------------------------------
  const presetButtons = panelsHost.querySelectorAll('[data-ctl=presets] [data-preset]');
  presetButtons.forEach((b) =>
    b.addEventListener('click', () => {
      flyToPreset(map, b.dataset.preset, {
        reduceMotion: !!caps?.prefersReducedMotion,
      });
      // On narrow screens, close the panel so the map is visible.
      if (caps?.narrow || controller.mqMobile.matches) {
        controller.close();
      }
    }),
  );

  // ----- Hypso subsystem ----------------------------------------------
  installHypsoUI(map, panelsHost, { caps, profile: effectiveProfile() });

  // Listen for cart:hypso events on the tint toggle so when external
  // code flips bathymetry, our Relief checkbox follows.
  window.addEventListener('cart:hypso', (e) => {
    if (!e?.detail) return;
    if (typeof e.detail.bathymetry === 'boolean') {
      const el = panelsHost.querySelector('[data-ctl=bathymetry]');
      if (el && el.checked !== e.detail.bathymetry) el.checked = e.detail.bathymetry;
    }
  });

  // Reflect detected profile on the UI.
  sidebar.dataset.detectedProfile = state.detectedProfile;

  return state;
}

/**
 * Mount the hypso UI bundle into the panels-root. Manages its own
 * teardown when the style is rebuilt (theme/quality swap).
 */
function installHypsoUI(map, panelsHost, { caps, profile } = {}) {
  const pickerHost = panelsHost.querySelector('[data-ctl=hypso-picker]');
  if (!pickerHost) return;
  const profileLauncher = panelsHost.querySelector('[data-ctl=hypso-profile-launcher]');
  const profileLauncherBtn = panelsHost.querySelector('[data-ctl=open-profile]');
  const statsHost = panelsHost.querySelector('[data-ctl=hypso-stats]');
  const statRefs = {
    min: panelsHost.querySelector('[data-ctl=hypso-stat-min]'),
    mean: panelsHost.querySelector('[data-ctl=hypso-stat-mean]'),
    max: panelsHost.querySelector('[data-ctl=hypso-stat-max]'),
    region: panelsHost.querySelector('[data-ctl=hypso-stat-region]'),
  };

  // Free-floating overlay hosts for legend, editor, and profile drawer.
  const mapEl = map.getContainer();
  const ensureFloat = (id) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      mapEl.parentElement?.appendChild(el);
    }
    return el;
  };
  const legendHost = ensureFloat('hypso-legend-host');
  const editorHost = ensureFloat('hypso-editor-host');
  const profileHost = ensureFloat('hypso-profile-host');

  const profileConfig = getProfileConfig(profile, caps);

  if (statsHost) statsHost.hidden = !profileConfig.enableHypsoStats;
  const profileEnabled = profileConfig.enableHypsoProfile && !caps?.prefersReducedMotion;
  if (profileLauncher) profileLauncher.hidden = !profileEnabled;

  const handle = mountHypsoUI({
    map,
    pickerHost,
    legendHost: profileConfig.enableHypsoLegend ? legendHost : null,
    editorHost: profileConfig.enableHypsoEditor ? editorHost : null,
    profileHost,
    profile: profileConfig,
    caps,
    theme: document.documentElement.dataset.theme || DEFAULT_THEME,
    showEditor: profileConfig.enableHypsoEditor,
    showLegend: profileConfig.enableHypsoLegend,
    showStats: profileConfig.enableHypsoStats,
    showProfile: profileConfig.enableHypsoProfile,
    autoRegion: profileConfig.enableHypsoAutoRegion,
    onStats: profileConfig.enableHypsoStats
      ? (stats) => {
          if (!statRefs.min) return;
          statRefs.min.textContent = stats.min == null ? '— м' : `${Math.round(stats.min)} м`;
          statRefs.mean.textContent = stats.mean == null ? '— м' : `${Math.round(stats.mean)} м`;
          statRefs.max.textContent = stats.max == null ? '— м' : `${Math.round(stats.max)} м`;
          statRefs.region.textContent = stats.region;
        }
      : undefined,
  });

  if (profileLauncherBtn && profileEnabled) {
    profileLauncherBtn.addEventListener('click', () => handle.openProfile());
  }

  if (typeof window !== 'undefined') {
    window.__cart_hypso = handle;
  }
}
