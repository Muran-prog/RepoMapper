/**
 * UI controls: navigation, scale, attribution, geolocate, theme switcher,
 * quality picker, layer toggles, city presets, and a mobile bottom-sheet.
 *
 * On desktop the sidebar is a permanent left rail. On phones and small
 * tablets it collapses into a bottom-sheet with a drag handle that toggles
 * between a peek state (header + handle visible) and an expanded state
 * (everything visible). Layout is driven by CSS; this module only owns the
 * toggle state, the click handlers, and the style-rebuild plumbing.
 */

import { applyStyle } from '../map/createMap.js';
import { flyToPreset } from '../map/interactions.js';
import { getProfileConfig, deriveProfile } from '../device.js';
import { FEATURES, DEFAULT_THEME } from '../config.js';

// ---------------------------------------------------------------------------
// MapLibre-native controls (top-right column, scale + attribution on the
// bottom). On touch devices we slightly increase visual prominence via CSS.
// ---------------------------------------------------------------------------

function installNativeControls(map, { isTouch }) {
  const ml = window.maplibregl;

  // Navigation: zoom + compass + pitch. The compass disappears at bearing 0
  // by default on touch, which is fine.
  map.addControl(
    new ml.NavigationControl({
      visualizePitch: true,
      showZoom: true,
      showCompass: true,
    }),
    'top-right',
  );

  // Geolocate is critical on mobile — the whole point of a phone map is
  // "where am I". Track and show the heading arrow when available.
  map.addControl(
    new ml.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showUserHeading: true,
      fitBoundsOptions: { maxZoom: 15 },
    }),
    'top-right',
  );

  map.addControl(
    new ml.ScaleControl({ maxWidth: 140, unit: 'metric' }),
    'bottom-left',
  );

  map.addControl(
    new ml.AttributionControl({ compact: true }),
    'bottom-right',
  );

  // Fullscreen is desktop-affordance; on iOS Safari it does nothing useful
  // when the page is already in the home-screen web-app shell, so we still
  // expose it but accept that it's a no-op there.
  if (!isTouch) {
    map.addControl(new ml.FullscreenControl({}), 'top-right');
  }
}

// ---------------------------------------------------------------------------
// Sidebar contents. The structure is the same across desktop / mobile —
// only CSS decides whether it's a left rail or a bottom sheet.
// ---------------------------------------------------------------------------

function renderSidebar(root) {
  root.innerHTML = `
    <button class="sheet-handle" type="button" aria-label="Toggle controls panel" data-ctl="sheet-handle">
      <span class="sheet-handle-bar"></span>
    </button>

    <div class="side-scroll">
      <header class="side-header">
        <div class="side-title">
          <span class="dot"></span>
          <span>Cart · Україна</span>
        </div>
        <p class="side-sub">Vector cartography · OpenMapTiles · MapLibre GL</p>
      </header>

      <section class="side-section">
        <h3 class="side-h">Theme</h3>
        <div class="seg" role="tablist" data-ctl="theme">
          <button data-value="light" role="tab" type="button">Light</button>
          <button data-value="dark"  role="tab" type="button">Dark</button>
        </div>
      </section>

      <section class="side-section">
        <h3 class="side-h">Quality</h3>
        <div class="seg seg-3" role="tablist" data-ctl="quality">
          <button data-value="auto" role="tab" type="button">Auto</button>
          <button data-value="high" role="tab" type="button">High</button>
          <button data-value="low"  role="tab" type="button">Eco</button>
        </div>
      </section>

      <section class="side-section">
        <h3 class="side-h">Layers</h3>
        <div class="rows">
          <label class="row"><input type="checkbox" data-ctl="labels"   checked> <span>Labels</span></label>
          <label class="row"><input type="checkbox" data-ctl="pois"     checked> <span>Points of interest</span></label>
          <label class="row"><input type="checkbox" data-ctl="b3d"      checked> <span>3D buildings</span></label>
        </div>
      </section>

      <section class="side-section">
        <h3 class="side-h">Quick fly-to</h3>
        <div class="presets" data-ctl="presets">
          <button data-preset="ukraine"     type="button">Україна</button>
          <button data-preset="kyiv"        type="button">Київ</button>
          <button data-preset="lviv"        type="button">Львів</button>
          <button data-preset="odesa"       type="button">Одеса</button>
          <button data-preset="kharkiv"     type="button">Харків</button>
          <button data-preset="carpathians" type="button">Карпати</button>
        </div>
      </section>

      <section class="side-section side-meta">
        <h3 class="side-h">Tips</h3>
        <ul class="tips" data-pointer="fine">
          <li><kbd>Scroll</kbd> — zoom</li>
          <li><kbd>Shift</kbd> + drag — rotate / tilt</li>
          <li><kbd>Ctrl</kbd> + click — fly to point</li>
          <li><kbd>Shift</kbd> + dbl-click — zoom out</li>
        </ul>
        <ul class="tips" data-pointer="coarse">
          <li>Pinch — zoom</li>
          <li>Two-finger drag — tilt</li>
          <li>Two-finger rotate — rotate</li>
          <li>Double-tap — zoom in</li>
        </ul>
      </section>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sheet (mobile) toggle. The CSS handles the visuals — we only flip the
// data-state attribute.
// ---------------------------------------------------------------------------

function installSheetToggle(sidebar, scrim, caps) {
  const handle = sidebar.querySelector('[data-ctl=sheet-handle]');

  const setState = (state) => {
    sidebar.dataset.state = state;
    if (scrim) scrim.dataset.visible = state === 'expanded' ? '1' : '0';
  };

  // Default state depends on form factor.
  setState(caps?.narrow ? 'peek' : 'expanded');

  const toggle = () =>
    setState(sidebar.dataset.state === 'expanded' ? 'peek' : 'expanded');

  handle?.addEventListener('click', toggle);
  scrim?.addEventListener('click', () => setState('peek'));

  // Escape collapses the sheet for keyboard users.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.dataset.state === 'expanded' && caps?.narrow) {
      setState('peek');
    }
  });

  return { setState };
}

// ---------------------------------------------------------------------------
// Wire-up.
// ---------------------------------------------------------------------------

/**
 * @param {maplibregl.Map} map
 * @param {HTMLElement}    sidebar  The aside element.
 * @param {HTMLElement|null} scrim  Optional backdrop element.
 * @param {object} ctx
 * @param {DeviceCaps} ctx.caps    Device capabilities.
 * @param {string} ctx.profile     Auto-derived profile.
 */
export function mountControls(map, sidebar, scrim, { caps, profile } = {}) {
  installNativeControls(map, { isTouch: !!caps?.isTouch });
  renderSidebar(sidebar);
  installSheetToggle(sidebar, scrim, caps);

  // ----- State the user can toggle -------------------------------------
  const state = {
    theme: DEFAULT_THEME,
    qualityChoice: 'auto', // 'auto' | 'high' | 'low'
    detectedProfile: profile ?? 'medium',
    layerFeatures: {
      labels: FEATURES.labels,
      pois: FEATURES.pois,
      buildings3D: FEATURES.buildings3D,
    },
  };

  const effectiveProfile = () =>
    state.qualityChoice === 'auto' ? state.detectedProfile : state.qualityChoice;

  const rebuildStyle = async () => {
    const profileName = effectiveProfile();
    await applyStyle(map, {
      theme: state.theme,
      profile: profileName,
      profileConfig: getProfileConfig(profileName),
      featureOverrides: state.layerFeatures,
    });
  };

  // ----- Theme segmented control ---------------------------------------
  const themeBtns = sidebar.querySelectorAll('[data-ctl=theme] button');
  const syncTheme = () => {
    themeBtns.forEach((b) => b.classList.toggle('on', b.dataset.value === state.theme));
    document.documentElement.dataset.theme = state.theme;
  };
  syncTheme();
  themeBtns.forEach((b) =>
    b.addEventListener('click', async () => {
      if (state.theme === b.dataset.value) return;
      state.theme = b.dataset.value;
      syncTheme();
      await rebuildStyle();
    }),
  );

  // ----- Quality segmented control -------------------------------------
  const qualBtns = sidebar.querySelectorAll('[data-ctl=quality] button');
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
  const wireToggle = (selector, key) => {
    const el = sidebar.querySelector(`[data-ctl=${selector}]`);
    el.checked = state.layerFeatures[key];
    el.addEventListener('change', async () => {
      state.layerFeatures[key] = el.checked;
      await rebuildStyle();
    });
  };
  wireToggle('labels', 'labels');
  wireToggle('pois', 'pois');
  wireToggle('b3d', 'buildings3D');

  // ----- Preset buttons ------------------------------------------------
  const presetButtons = sidebar.querySelectorAll('[data-ctl=presets] [data-preset]');
  presetButtons.forEach((b) =>
    b.addEventListener('click', () => {
      flyToPreset(map, b.dataset.preset, {
        reduceMotion: !!caps?.prefersReducedMotion,
      });
      // On mobile, collapse the sheet so the user sees the map.
      if (caps?.narrow) sidebar.dataset.state = 'peek';
    }),
  );

  // ----- Reflect detected profile on the UI ----------------------------
  // The dataset attribute lets CSS show a quiet badge ("auto · low" on
  // weak devices) without us having to rerender the sidebar.
  sidebar.dataset.detectedProfile = state.detectedProfile;
  document.documentElement.dataset.theme = state.theme;

  return state;
}
