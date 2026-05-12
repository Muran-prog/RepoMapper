/**
 * Hypsometric UI — mount point + barrel.
 *
 * Single entry point for the rest of the codebase to wire the picker,
 * editor, legend, viewport stats and profile mode into a host page.
 *
 * Order of operations on mount:
 *
 *   1. Load custom ramps from localStorage and register them with the
 *      hypso style module so the picker can list them.
 *   2. Apply persisted user preferences (active ramp, strength,
 *      bathymetry, high-contrast) to the live map via runtime.js.
 *   3. Render the picker into its host element.
 *   4. Optionally render the legend (showLegend), install the auto-
 *      region heuristic (autoRegion), and wire the elevation profile
 *      button.
 *   5. Return a teardown function the caller can invoke during HMR
 *      or when the app re-mounts on theme/profile changes.
 *
 * Profile-aware mounting
 * ----------------------
 * The caller threads through device profile flags (enableHypsoEditor,
 * enableHypsoLegend, etc.) so a 'low' profile gets just the picker
 * (and even that can be made read-only if needed). 'High' gets the
 * full stack including the live editor and profile drawing mode.
 *
 * @see ../../device.js  for the per-profile defaults
 * @see ../../style/hypso  for the underlying ramp/expression/runtime layer
 */

import {
  applyHypsoRamp,
  applyHypsoStrength,
  applyHypsoBathymetry,
  applyHypsoHighContrast,
  registerCustomRamps,
} from '../../style/hypso/index.js';
import { loadCustomRamps, loadPrefs } from './store.js';
import { mountHypsoPicker } from './picker.js';
import { mountHypsoEditor } from './editor.js';
import { mountHypsoLegend } from './legend.js';
import { mountHypsoProfile } from './profile.js';
import { installAutoRegion } from './autoregion.js';

/**
 * @typedef {object} HypsoUIOpts
 * @property {maplibregl.Map} map
 * @property {HTMLElement}    pickerHost
 * @property {HTMLElement}    [legendHost]
 * @property {HTMLElement}    [editorHost]
 * @property {HTMLElement}    [profileHost]
 * @property {object}         [profile]            Device profile config.
 * @property {object}         [caps]               Device caps.
 * @property {'light'|'dark'} [theme]
 * @property {boolean}        [showEditor]
 * @property {boolean}        [showLegend]
 * @property {boolean}        [showStats]
 * @property {boolean}        [showProfile]
 * @property {boolean}        [autoRegion]
 * @property {function(import('./autoregion.js').ElevStats):void} [onStats]
 */

/**
 * Mount the hypso UI bundle. Returns an unmount function.
 *
 * @param {HypsoUIOpts} opts
 */
export function mountHypsoUI(opts) {
  const {
    map,
    pickerHost,
    legendHost,
    editorHost,
    profileHost,
    profile = {},
    caps = {},
    theme = 'light',
    showEditor = !!profile.enableHypsoEditor,
    showLegend = !!profile.enableHypsoLegend,
    showStats = !!profile.enableHypsoStats,
    showProfile = !!profile.enableHypsoProfile,
    autoRegion = !!profile.enableHypsoAutoRegion,
    onStats,
  } = opts;

  // 1. Hydrate custom ramps + user prefs.
  registerCustomRamps(loadCustomRamps());
  const prefs = loadPrefs();

  // 2. Apply persisted preferences to the live map. Order matters:
  //    bathymetry first (changes the ramp expression), then ramp (so
  //    the expression is correct), then strength (separate paint prop),
  //    then high-contrast (also re-emits ramp expression).
  applyHypsoBathymetry(map, prefs.bathymetry);
  if (caps.prefersContrastMore) {
    applyHypsoHighContrast(map, true);
  } else {
    applyHypsoHighContrast(map, prefs.highContrast);
  }
  applyHypsoRamp(map, prefs.rampId, { dispatch: false });
  applyHypsoStrength(map, prefs.strength, { dispatch: false });

  // 3. Picker.
  let activeEditor = null;
  const picker = mountHypsoPicker({
    map,
    host: pickerHost,
    showEditor,
    highContrastDefault: !!caps.prefersContrastMore,
    onOpenEditor: showEditor
      ? (rampId) => {
          if (!editorHost) return;
          activeEditor?.unmount?.();
          activeEditor = mountHypsoEditor({
            map,
            host: editorHost,
            rampId: rampId ?? prefs.rampId,
            theme,
            onClose: () => {
              activeEditor?.unmount?.();
              activeEditor = null;
              picker.refresh();
            },
            onSaved: () => {
              picker.refresh();
            },
          });
        }
      : undefined,
  });

  // 4. Legend.
  //
  //    First-run UX: collapsed by default on narrow viewports + touch
  //    pointers so the legend doesn't eat half the screen on phones.
  //    Once the user toggles it, the prefs.legendCollapsed bit is
  //    persisted in localStorage and overrides this default for every
  //    subsequent reload.
  let legend = null;
  if (showLegend && legendHost) {
    legend = mountHypsoLegend({
      map,
      host: legendHost,
      showCursor: !caps.isCoarse,
      defaultCollapsed: !!(caps.narrow || caps.isCoarse),
    });
  }

  // 5. Auto-region + viewport stats.
  let stopAutoRegion = null;
  if (autoRegion || showStats) {
    stopAutoRegion = installAutoRegion({
      map,
      autoPick: autoRegion,
      stats: showStats,
      onStats,
    });
  }

  // 6. Profile drawing mode. Mounted lazily — we just expose a launcher.
  //
  //    Accessibility: the brief explicitly disables the drawing-mode
  //    profile under prefers-reduced-motion (mouse-following animations
  //    + click-to-place flow can be vestibularly stressful). We keep
  //    the launcher available but no-op the open call so calling code
  //    doesn't have to special-case it.
  let activeProfile = null;
  const profileAllowed = showProfile && !caps.prefersReducedMotion;
  const openProfile = () => {
    if (!profileAllowed || !profileHost) return;
    activeProfile?.unmount?.();
    activeProfile = mountHypsoProfile({
      map,
      host: profileHost,
      reduceMotion: !!caps.prefersReducedMotion,
      onExit: () => {
        activeProfile = null;
      },
    });
  };

  return {
    openProfile,
    unmount() {
      activeEditor?.unmount?.();
      activeProfile?.unmount?.();
      legend?.unmount?.();
      picker?.unmount?.();
      stopAutoRegion?.();
    },
  };
}

export { mountHypsoPicker } from './picker.js';
export { mountHypsoEditor } from './editor.js';
export { mountHypsoLegend } from './legend.js';
export { mountHypsoProfile } from './profile.js';
export { installAutoRegion } from './autoregion.js';
export {
  loadPrefs,
  savePrefs,
  loadCustomRamps,
  saveCustomRamps,
  upsertCustomRamp,
  deleteCustomRamp,
  validateCustomRamp,
  hasPersistedRampPref,
} from './store.js';
