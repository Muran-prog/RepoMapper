/**
 * Shared UI preferences — persistent state for floating shell elements.
 *
 * Mirrors the defensive load/save pattern from `src/ui/hypso/store.js`:
 * every read/write is wrapped so the app keeps running when storage is
 * disabled (Safari private mode, third-party-cookies blocked) or quota
 * is exhausted. All values are tightly scoped to the UI shell — the
 * map-level prefs (hypso ramp, strength, etc.) live in their own store
 * to keep the migration boundary clear.
 *
 * Schema (single key `cart:ui:prefs:v1`):
 *
 *   {
 *     "hudCollapsed":      boolean,   // bottom-left telemetry pill
 *     "controlsCollapsed": boolean    // top-right MapLibre cluster
 *   }
 *
 * Missing fields fall back to the per-device defaults that the caller
 * supplies — on touch / narrow viewports the chrome is collapsed by
 * default to reclaim screen real estate.
 *
 * @typedef {object} UiPrefs
 * @property {boolean} hudCollapsed
 * @property {boolean} controlsCollapsed
 */

const KEY = 'cart:ui:prefs:v1';

/** Probe localStorage availability without throwing. */
function ls() {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    // Touch to make sure access doesn't throw (Safari private mode).
    s.getItem(KEY);
    return s;
  } catch {
    return null;
  }
}

/**
 * Load persisted UI prefs. Defaults are applied for every missing
 * field so the returned object is always fully populated.
 *
 * @param {Partial<UiPrefs>} [defaults]
 * @returns {UiPrefs}
 */
export function loadUiPrefs(defaults = {}) {
  const fallback = {
    hudCollapsed: false,
    controlsCollapsed: false,
    ...defaults,
  };
  const storage = ls();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      hudCollapsed:
        typeof parsed.hudCollapsed === 'boolean' ? parsed.hudCollapsed : fallback.hudCollapsed,
      controlsCollapsed:
        typeof parsed.controlsCollapsed === 'boolean'
          ? parsed.controlsCollapsed
          : fallback.controlsCollapsed,
    };
  } catch {
    return fallback;
  }
}

/**
 * Patch a subset of UI prefs. Best-effort — quota errors and
 * serialisation failures are swallowed so the UI never crashes when
 * storage misbehaves.
 *
 * @param {Partial<UiPrefs>} patch
 */
export function saveUiPrefs(patch) {
  const storage = ls();
  if (!storage) return;
  try {
    const next = { ...loadUiPrefs(), ...patch };
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / serialise error — best-effort */
  }
}
