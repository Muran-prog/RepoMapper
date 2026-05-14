/**
 * Map-mode switcher — segmented control with three options:
 *
 *   • Cart       — premium composition (default)
 *   • Standard   — third-party "Google-Maps-like" style fetched as a
 *                  ready-made MapLibre style JSON
 *   • Satellite  — Esri World Imagery raster + thin OMT label overlay
 *
 * The control implements the WAI-ARIA radiogroup pattern:
 *
 *   role="radiogroup"  on the wrapper
 *   role="radio"       on each segment
 *   aria-checked       reflects active selection
 *   tabindex           the active segment gets 0, others -1 (roving)
 *   ←/→ arrow keys     move selection through the radios
 *   Home / End         jump to first / last
 *   Space / Enter      activate the focused radio (already-selected
 *                      segments are no-ops so the user can't
 *                      double-trigger an expensive style swap)
 *
 * Visual rhythm matches the rest of the floating shell — `--glass-bg`
 * surface, `--hairline` divider between segments, `--float-radius`
 * outer corner. CSS lives in `styles/dock.css` next to the brand chip
 * so the mode-switcher (which mounts beside the chip) inherits the
 * same family.
 *
 * Pure DOM helper, no MapLibre globals — `mountModeSwitcher` takes a
 * setter function that the host wires to `applyMapMode`. Persistence is
 * the host's responsibility (we just reflect the active id in the UI),
 * so the switcher itself can be unit-tested without touching storage.
 */

import {
  MAP_MODES,
  MAP_MODE_LABELS,
  MAP_MODE_HINTS,
} from '../config.js';

/**
 * @typedef {object} ModeSwitcherHandle
 * @property {(id: 'cart'|'standard'|'satellite') => void} setActive
 *           Programmatically change the selected segment without
 *           firing the change callback.
 * @property {() => void} destroy
 *           Tear down listeners + DOM. Idempotent.
 */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host        Container element. Existing
 *                                       contents will be replaced.
 * @param {string}     opts.activeMode   Initial selection.
 * @param {(mode: string) => void} opts.onChange
 *                                       Called when the user picks a
 *                                       NEW mode (no-op for re-clicks
 *                                       on the active segment).
 * @returns {ModeSwitcherHandle}
 */
export function mountModeSwitcher({ host, activeMode, onChange }) {
  if (!host) return { setActive: () => {}, destroy: () => {} };

  // Single root so the radiogroup semantics live on a known node.
  const group = document.createElement('div');
  group.className = 'mode-switcher seg seg-3';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Режим карти');

  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();

  for (const id of MAP_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-switcher-btn';
    btn.dataset.mode = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', id === activeMode ? 'true' : 'false');
    btn.tabIndex = id === activeMode ? 0 : -1;
    btn.title = MAP_MODE_HINTS[id] ?? MAP_MODE_LABELS[id];
    btn.setAttribute('aria-label', MAP_MODE_HINTS[id] ?? MAP_MODE_LABELS[id]);
    btn.textContent = MAP_MODE_LABELS[id];
    buttons.set(id, btn);
    group.appendChild(btn);
  }

  let current = activeMode;

  /**
   * Reflect the active id on every button. When `silent` is true the
   * onChange callback is skipped — used by the public `setActive`
   * helper so the host can call it during re-syncs without echoing
   * the change back.
   */
  const select = (id, { silent = false, focus = false } = {}) => {
    if (!MAP_MODES.includes(id)) return;
    if (id === current && !focus) return;
    current = id;
    for (const [btnId, btn] of buttons) {
      const active = btnId === id;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
      btn.classList.toggle('on', active);
    }
    if (focus) {
      try {
        buttons.get(id)?.focus({ preventScroll: true });
      } catch {
        /* focus may fail on hidden trees; ignore */
      }
    }
    if (!silent) onChange?.(id);
  };

  // Click handling — straightforward, plus a safety check that a stale
  // button event doesn't try to set an unknown mode.
  const onClick = (e) => {
    const btn = e.target?.closest?.('[data-mode]');
    if (!btn || !group.contains(btn)) return;
    const id = btn.dataset.mode;
    if (!id) return;
    select(id);
  };

  // Keyboard navigation — roving tabindex pattern.
  const onKey = (e) => {
    const orderedIds = [...buttons.keys()];
    const currentIdx = orderedIds.indexOf(current);
    let nextIdx = currentIdx;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (currentIdx + 1) % orderedIds.length;
        e.preventDefault();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (currentIdx - 1 + orderedIds.length) % orderedIds.length;
        e.preventDefault();
        break;
      case 'Home':
        nextIdx = 0;
        e.preventDefault();
        break;
      case 'End':
        nextIdx = orderedIds.length - 1;
        e.preventDefault();
        break;
      case ' ':
      case 'Enter': {
        // Activate the focused button. If it's already current it's a
        // no-op, which is what the brief asks for.
        const focused = document.activeElement;
        const focusedBtn = focused instanceof HTMLElement
          ? focused.closest?.('[data-mode]')
          : null;
        if (focusedBtn && group.contains(focusedBtn)) {
          e.preventDefault();
          select(focusedBtn.dataset.mode);
        }
        return;
      }
      default:
        return;
    }
    select(orderedIds[nextIdx], { focus: true });
  };

  group.addEventListener('click', onClick);
  group.addEventListener('keydown', onKey);

  host.innerHTML = '';
  host.appendChild(group);

  return {
    setActive(id) {
      select(id, { silent: true });
    },
    destroy() {
      group.removeEventListener('click', onClick);
      group.removeEventListener('keydown', onKey);
      if (group.parentNode === host) host.removeChild(group);
      buttons.clear();
    },
  };
}
