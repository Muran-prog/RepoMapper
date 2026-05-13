/**
 * Ramp picker UI — the user-facing entry to the hypsometric subsystem.
 *
 * Sits in the sidebar's "Relief" section and renders four controls:
 *
 *   • Active ramp     — radio-grouped list with a colour preview, a
 *                       colourblind-safe badge, and an editor-open
 *                       button per custom ramp.
 *   • Strength        — 0..1.5 slider, instant via `applyHypsoStrength`.
 *   • Bathymetry      — checkbox, instant via `applyHypsoBathymetry`.
 *   • High contrast   — checkbox; we re-emit the ramp expression with
 *                       a luminance-pumping transform applied.
 *
 * Every interaction routes through `style/hypso/runtime.js`, which
 * mutates the live MapLibre style via setPaintProperty — never a full
 * style rebuild. That keeps ramp / strength changes instant.
 *
 * Persistence
 * -----------
 * Every user-driven change is mirrored to localStorage via
 * `store.js::savePrefs` so a reload picks up the same choice. Custom
 * ramps live under a separate key (HYPSO.storageKey).
 *
 * Accessibility
 * -------------
 *   • Each ramp is a real <input type="radio"> so screen-readers and
 *     keyboard users get the expected semantics.
 *   • Colourblind-safe entries carry a <span aria-label> badge for
 *     screen-reader announcement.
 *   • `prefers-contrast: more` users get the high-contrast toggle
 *     auto-flipped on at boot (caller decides).
 */

import {
  RAMPS,
  listRampIds,
  getRamp,
  rampToCssGradient,
  applyHypsoRamp,
  applyHypsoStrength,
  applyHypsoBathymetry,
  applyHypsoHighContrast,
} from '../../style/hypso/index.js';
import { loadPrefs, savePrefs } from './store.js';
import { HYPSO } from '../../config.js';

/**
 * @typedef {object} PickerMountOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement}    host            Container to render into.
 * @property {boolean}        [showEditor]    Mount an "Edit…" button per
 *                                            custom ramp + "+ new" entry.
 * @property {function():void} [onOpenEditor] Click handler for the
 *                                            editor-open buttons.
 * @property {boolean}        [showBathymetry] Default true.
 * @property {boolean}        [showStrength]   Default true.
 * @property {boolean}        [highContrastDefault]
 */

/**
 * Mount the picker UI into `host`. Returns an object exposing imperative
 * controls so other modules can re-render after external state changes.
 *
 * @param {PickerMountOpts} opts
 */
export function mountHypsoPicker(opts) {
  const {
    map,
    host,
    showEditor = false,
    onOpenEditor,
    showBathymetry = true,
    showStrength = true,
    highContrastDefault = false,
  } = opts;
  if (!host) return { refresh: () => {}, unmount: () => {} };

  const prefs = loadPrefs();

  host.innerHTML = `
    <div class="panel-group hypso-picker" data-ctl="hypso">
      <h4 class="panel-group-title">Active ramp</h4>
      <ul class="hypso-list" data-ctl="hypso-list" role="radiogroup" aria-label="Active hypsometric ramp"></ul>
    </div>
    <div class="panel-group">
      <h4 class="panel-group-title">Tint options</h4>
      <div class="rows">
        ${
          showBathymetry
            ? `<label class="row hypso-row"><span>Bathymetry (Black + Azov)</span><input type="checkbox" data-ctl="hypso-bathymetry"></label>`
            : ''
        }
        <label class="row hypso-row"><span>High contrast</span><input type="checkbox" data-ctl="hypso-contrast"></label>
      </div>
      ${
        showStrength
          ? `<div class="slider-row">
              <label class="slider-label" for="hypso-strength">
                <span>Strength</span>
                <span data-ctl="hypso-strength-readout">1.0×</span>
              </label>
              <input id="hypso-strength" type="range" min="0" max="1.5" step="0.05" value="1" data-ctl="hypso-strength">
            </div>`
          : ''
      }
    </div>
  `;

  const refs = {
    list: host.querySelector('[data-ctl=hypso-list]'),
    bathy: host.querySelector('[data-ctl=hypso-bathymetry]'),
    contrast: host.querySelector('[data-ctl=hypso-contrast]'),
    strength: host.querySelector('[data-ctl=hypso-strength]'),
    strengthRO: host.querySelector('[data-ctl=hypso-strength-readout]'),
  };

  if (refs.bathy) refs.bathy.checked = !!prefs.bathymetry;
  if (refs.contrast) refs.contrast.checked = !!(prefs.highContrast || highContrastDefault);
  if (refs.strength) {
    refs.strength.value = String(prefs.strength);
    refs.strengthRO.textContent = formatStrength(prefs.strength);
    updateSliderFill(refs.strength);
  }

  const renderList = () => {
    const ids = listRampIds();
    refs.list.innerHTML = ids.map((id) => renderRampRow(id, prefs.rampId)).join('');
    refs.list.querySelectorAll('input[type=radio]').forEach((el) => {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        prefs.rampId = el.value;
        applyHypsoRamp(map, prefs.rampId);
        savePrefs({ rampId: prefs.rampId });
        // Re-render so the active-state highlight updates.
        renderList();
      });
    });
    if (showEditor && onOpenEditor) {
      refs.list.querySelectorAll('[data-ctl=hypso-edit]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          onOpenEditor(el.dataset.rampId);
        });
      });
    }
  };
  renderList();

  // Sync the picker UI to external state changes — the autoregion
  // heuristic, the live editor's "save" flow, and any console-level
  // `applyHypsoRamp` call dispatch `cart:hypso` events with the new
  // state. If we don't listen, the radio buttons drift from the live
  // ramp and the user sees "ramp change isn't sticking". The
  // bathy/contrast/strength toggles get the same treatment so their
  // UI stays in lock-step too.
  const onExternalHypso = (e) => {
    const detail = e?.detail;
    if (!detail) return;
    let dirty = false;
    if (typeof detail.rampId === 'string' && detail.rampId !== prefs.rampId) {
      prefs.rampId = detail.rampId;
      dirty = true;
    }
    if (refs.bathy && typeof detail.bathymetry === 'boolean' && refs.bathy.checked !== detail.bathymetry) {
      refs.bathy.checked = detail.bathymetry;
    }
    if (refs.contrast && typeof detail.highContrast === 'boolean' && refs.contrast.checked !== detail.highContrast) {
      refs.contrast.checked = detail.highContrast;
    }
    if (refs.strength && typeof detail.strength === 'number' && Number(refs.strength.value) !== detail.strength) {
      refs.strength.value = String(detail.strength);
      if (refs.strengthRO) refs.strengthRO.textContent = formatStrength(detail.strength);
    }
    if (dirty) renderList();
  };
  window.addEventListener('cart:hypso', onExternalHypso);

  refs.bathy?.addEventListener('change', () => {
    applyHypsoBathymetry(map, refs.bathy.checked);
    savePrefs({ bathymetry: refs.bathy.checked });
  });

  refs.contrast?.addEventListener('change', () => {
    applyHypsoHighContrast(map, refs.contrast.checked);
    savePrefs({ highContrast: refs.contrast.checked });
  });

  if (refs.strength) {
    refs.strength.addEventListener('input', () => {
      const v = Number(refs.strength.value);
      refs.strengthRO.textContent = formatStrength(v);
      applyHypsoStrength(map, v);
      savePrefs({ strength: v });
      updateSliderFill(refs.strength);
    });
  }

  return {
    refresh: renderList,
    setActiveRamp(id) {
      prefs.rampId = id;
      renderList();
    },
    unmount() {
      window.removeEventListener('cart:hypso', onExternalHypso);
      host.innerHTML = '';
    },
  };
}

/**
 * Render a single ramp row (radio + preview swatch + badge + edit).
 * Pure HTML string — wiring is added after innerHTML assignment.
 */
function renderRampRow(rampId, activeId) {
  const r = getRamp(rampId);
  const isBuiltIn = !!RAMPS[rampId];
  const gradient = rampToCssGradient(rampId, 'light');
  const checked = rampId === activeId ? 'checked' : '';
  const cbBadge = r.colorblindSafe
    ? `<span class="hypso-badge" aria-label="Colourblind-safe palette">CB-safe</span>`
    : '';
  const editBtn = !isBuiltIn
    ? `<button class="hypso-edit" data-ctl="hypso-edit" data-ramp-id="${escAttr(rampId)}" type="button" aria-label="Edit ramp">✎</button>`
    : '';
  return `
    <li class="hypso-item" data-active="${checked ? '1' : '0'}">
      <label class="hypso-label">
        <input type="radio" name="hypso-ramp" value="${escAttr(rampId)}" ${checked}>
        <span class="hypso-preview" style="background:${escAttr(gradient)};" aria-hidden="true"></span>
        <span class="hypso-text">
          <span class="hypso-name">${escHtml(r.name)} ${cbBadge}</span>
          <span class="hypso-summary">${escHtml(r.summary || '')}</span>
        </span>
        ${editBtn}
      </label>
    </li>
  `;
}

function formatStrength(v) {
  return `${Number(v).toFixed(2)}×`;
}

/** Update the slider's CSS --fill custom property so the track shows
 *  filled progress up to the thumb. Mirrors the helper in controls.js. */
function updateSliderFill(slider) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const v = Number(slider.value);
  const pct = ((v - min) / (max - min)) * 100;
  slider.style.setProperty('--fill', `${pct}%`);
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
function escAttr(s) {
  return String(s).replace(/["&<>]/g, (c) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
