/**
 * UI controls: navigation, scale, attribution, geolocate, theme switcher,
 * quality picker, base-layer toggles, RELIEF toggles + exaggeration slider,
 * city + Carpathian-peak fly-to presets, and a mobile bottom-sheet.
 *
 * On desktop the sidebar is a permanent left rail. On phones and small
 * tablets it collapses into a bottom-sheet with a drag handle that toggles
 * between a peek state (header + handle visible) and an expanded state
 * (everything visible). Layout is driven by CSS; this module only owns
 * the toggle state, the click handlers, and the style-rebuild plumbing.
 */

import { applyStyle } from '../map/createMap.js';
import { flyToPreset, setUserExaggeration } from '../map/interactions.js';
import { getProfileConfig } from '../device.js';
import { FEATURES, DEFAULT_THEME } from '../config.js';

// ---------------------------------------------------------------------------
// MapLibre-native controls (top-right column, scale + attribution on the
// bottom). On touch devices we slightly increase visual prominence via CSS.
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

  map.addControl(
    new ml.ScaleControl({ maxWidth: 140, unit: 'metric' }),
    'bottom-left',
  );

  map.addControl(
    new ml.AttributionControl({ compact: true }),
    'bottom-right',
  );

  if (!isTouch) {
    map.addControl(new ml.FullscreenControl({}), 'top-right');
  }
}

// ---------------------------------------------------------------------------
// Sidebar contents.
//
// The structure is the same across desktop / mobile — CSS decides whether
// it's a left rail or a bottom-sheet.
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
        <h3 class="side-h">Relief</h3>
        <div class="rows">
          <label class="row"><input type="checkbox" data-ctl="hillshade"        checked> <span>Hillshade</span></label>
          <label class="row"><input type="checkbox" data-ctl="terrain3D"        checked> <span>3D terrain</span></label>
          <label class="row"><input type="checkbox" data-ctl="contours"         checked> <span>Contours</span></label>
          <label class="row"><input type="checkbox" data-ctl="hypsometricTint"> <span>Hypsometric tint</span></label>
          <label class="row"><input type="checkbox" data-ctl="textureShading"> <span>Texture shading</span></label>
          <label class="row"><input type="checkbox" data-ctl="ridgeOverlay"> <span>Ridge overlay</span></label>
          <label class="row"><input type="checkbox" data-ctl="carpathian"> <span>Carpathian detail</span></label>
        </div>
        <div class="slider-row">
          <label class="slider-label" for="exaggeration">Exaggeration <span data-ctl="exaggeration-readout">1.0×</span></label>
          <input
            id="exaggeration"
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value="1"
            data-ctl="exaggeration"
          />
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
        <p class="side-h carpathian-h">Carpathian peaks</p>
        <div class="presets" data-ctl="presets">
          <button data-preset="hoverla"   type="button">Говерла 2061</button>
          <button data-preset="pip_ivan"  type="button">Піп Іван 2028</button>
          <button data-preset="petros"    type="button">Петрос 2020</button>
          <button data-preset="svydovets" type="button">Свидовець</button>
          <button data-preset="chornohora" type="button">Чорногора</button>
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
// Sheet (mobile) toggle.
// ---------------------------------------------------------------------------

function installSheetToggle(sidebar, scrim, caps) {
  const handle = sidebar.querySelector('[data-ctl=sheet-handle]');

  const setState = (state) => {
    sidebar.dataset.state = state;
    if (scrim) scrim.dataset.visible = state === 'expanded' ? '1' : '0';
  };

  setState(caps?.narrow ? 'peek' : 'expanded');

  const toggle = () =>
    setState(sidebar.dataset.state === 'expanded' ? 'peek' : 'expanded');

  handle?.addEventListener('click', toggle);
  scrim?.addEventListener('click', () => setState('peek'));

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
 * @param {HTMLElement}    sidebar
 * @param {HTMLElement|null} scrim
 * @param {object} ctx
 * @param {DeviceCaps} ctx.caps
 * @param {string} ctx.profile
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
      hillshade: FEATURES.hillshade,
      terrain3D: FEATURES.terrain3D,
      contours: FEATURES.contours,
      hypsometricTint: FEATURES.hypsometricTint,
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
  /**
   * Bind a checkbox to a key in state.layerFeatures. The data-ctl value
   * is the checkbox attribute; key is the FEATURES dict key. Defaults to
   * data-ctl name when key isn't passed.
   */
  const wireToggle = (selector, key = selector) => {
    const el = sidebar.querySelector(`[data-ctl=${selector}]`);
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
  wireToggle('textureShading');
  wireToggle('ridgeOverlay');
  wireToggle('carpathian');

  // ----- Exaggeration slider -------------------------------------------
  // Live-updates the user-side multiplier without rebuilding the style;
  // setUserExaggeration() pushes the new value to interactions.js which
  // re-applies setTerrain() immediately.
  const slider = sidebar.querySelector('[data-ctl=exaggeration]');
  const readout = sidebar.querySelector('[data-ctl=exaggeration-readout]');
  if (slider) {
    const update = () => {
      const v = Number(slider.value);
      if (readout) readout.textContent = `${v.toFixed(1)}×`;
      setUserExaggeration(map, v);
    };
    slider.addEventListener('input', update);
    update();
  }

  // ----- Preset buttons ------------------------------------------------
  const presetButtons = sidebar.querySelectorAll('[data-ctl=presets] [data-preset]');
  presetButtons.forEach((b) =>
    b.addEventListener('click', () => {
      flyToPreset(map, b.dataset.preset, {
        reduceMotion: !!caps?.prefersReducedMotion,
      });
      if (caps?.narrow) sidebar.dataset.state = 'peek';
    }),
  );

  // ----- Reflect detected profile on the UI ----------------------------
  sidebar.dataset.detectedProfile = state.detectedProfile;
  document.documentElement.dataset.theme = state.theme;

  return state;
}
