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
    <section class="side-section hypso-picker" data-ctl="hypso">
      <h3 class="side-h">Hypsometric ramp</h3>
      <ul class="hypso-list" data-ctl="hypso-list" role="radiogroup" aria-label="Active hypsometric ramp"></ul>
      ${
        showBathymetry
          ? `<label class="row hypso-row"><input type="checkbox" data-ctl="hypso-bathymetry"> <span>Bathymetry (Black + Azov)</span></label>`
          : ''
      }
      <label class="row hypso-row"><input type="checkbox" data-ctl="hypso-contrast"> <span>High contrast</span></label>
      ${
        showStrength
          ? `<div class="slider-row">
              <label class="slider-label" for="hypso-strength">Strength <span data-ctl="hypso-strength-readout">1.0×</span></label>
              <input id="hypso-strength" type="range" min="0" max="1.5" step="0.05" value="1" data-ctl="hypso-strength">
            </div>`
          : ''
      }
    </section>
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
    });
  }

  return {
    refresh: renderList,
    setActiveRamp(id) {
      prefs.rampId = id;
      renderList();
    },
    unmount() {
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

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
function escAttr(s) {
  return String(s).replace(/["&<>]/g, (c) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
