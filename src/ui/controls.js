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
};

// ---------------------------------------------------------------------------
// MapLibre-native controls (top-right column, scale + attribution).
// ---------------------------------------------------------------------------

function installNativeControls(map, { isTouch }) {
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

  map.addControl(new ml.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

  if (!isTouch) {
    map.addControl(new ml.FullscreenControl({}), 'top-right');
  }
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
    return { button, panel };
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
  installNativeControls(map, { isTouch: !!caps?.isTouch });

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

  // Build the dock host (the sidebar element) + the panels container.
  // The panels live as a sibling node so their absolute positioning is
  // unaffected by the dock's flex layout.
  sidebar.className = '';
  sidebar.innerHTML = '';
  const dockHost = document.createElement('div');
  dockHost.className = 'dock-root';
  const panelsHost = document.createElement('div');
  panelsHost.className = 'panels-root';
  sidebar.appendChild(dockHost);
  sidebar.appendChild(panelsHost);

  renderDock(dockHost);
  renderPanels(panelsHost);

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
