/**
 * Hypso picker / editor — localStorage persistence layer.
 *
 * Persists two flavours of state:
 *
 *   • User preferences  — last picked ramp id, strength, bathymetry,
 *                          high-contrast, mode override. Single key
 *                          'cart:hypso:prefs:v1'.
 *
 *   • Custom ramps      — user-authored ramp definitions, keyed by id.
 *                          Stored under HYPSO.storageKey from the
 *                          frozen config. Built-in ramps are NEVER
 *                          persisted here — they are tokens/palettes,
 *                          not user state.
 *
 * Layout (custom ramps blob):
 *
 *   {
 *     "version": 1,
 *     "ramps": {
 *       "my-pastel": {
 *         "id": "my-pastel",
 *         "name": "My pastel",
 *         "summary": "...",
 *         "colorblindSafe": false,
 *         "region": "global",
 *         "light": [[-1000, "#abc"], ...],
 *         "dark":  [[-1000, "#abc"], ...]
 *       }
 *     }
 *   }
 *
 * Both reads/writes are defensive: storage can be disabled (Safari
 * private mode, third-party-cookies blocked), quota-exceeded, or just
 * absent (Node tests). Every method returns sensibly on failure.
 *
 * Versioning
 * ----------
 * The 'version' field gates migrations. Bumping the version forces a
 * one-shot clearing of older entries to avoid mixing schemas; the
 * user's data is dropped, but no app code path crashes. The brief is
 * explicit: custom ramps are localStorage-only, never server-side, so
 * loss is acceptable.
 *
 * @typedef {object} CustomRamp
 * @property {string} id
 * @property {string} name
 * @property {string} [summary]
 * @property {string} [region]
 * @property {boolean} [colorblindSafe]
 * @property {Array<[number, string]>} light
 * @property {Array<[number, string]>} dark
 *
 * @typedef {object} HypsoPrefs
 * @property {string}  rampId
 * @property {number}  strength
 * @property {boolean} bathymetry
 * @property {boolean} highContrast
 * @property {'native'|'raster'|'off'|'auto'} [mode]
 * @property {boolean} [legendCollapsed]   Collapsed state of the canvas legend.
 */

import { HYPSO } from '../../config.js';

const PREFS_KEY = 'cart:hypso:prefs:v1';
const CUSTOM_VERSION = 1;

function ls() {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    // Touch to make sure access doesn't throw (Safari private mode).
    s.getItem(PREFS_KEY);
    return s;
  } catch {
    return null;
  }
}

/**
 * Load persisted user preferences. Missing fields fall back to the
 * frozen HYPSO defaults. Never throws.
 *
 * @returns {HypsoPrefs}
 */
export function loadPrefs() {
  const defaults = {
    rampId: HYPSO.defaultRampId,
    strength: HYPSO.defaultStrength,
    bathymetry: HYPSO.bathymetryDefault,
    highContrast: HYPSO.highContrastDefault,
    mode: 'auto',
    legendCollapsed: false,
  };
  const storage = ls();
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      rampId: typeof parsed.rampId === 'string' ? parsed.rampId : defaults.rampId,
      strength: clampStrength(parsed.strength) ?? defaults.strength,
      bathymetry: typeof parsed.bathymetry === 'boolean' ? parsed.bathymetry : defaults.bathymetry,
      highContrast: typeof parsed.highContrast === 'boolean' ? parsed.highContrast : defaults.highContrast,
      mode: ['native', 'raster', 'off', 'auto'].includes(parsed.mode) ? parsed.mode : defaults.mode,
      legendCollapsed: typeof parsed.legendCollapsed === 'boolean' ? parsed.legendCollapsed : defaults.legendCollapsed,
    };
  } catch {
    return defaults;
  }
}

/**
 * Persist user preferences. Best-effort — quota errors are swallowed.
 *
 * @param {Partial<HypsoPrefs>} patch Merged with the persisted blob.
 */
export function savePrefs(patch) {
  const storage = ls();
  if (!storage) return;
  try {
    const next = { ...loadPrefs(), ...patch };
    storage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* quota / serialise error — best-effort */
  }
}

/**
 * Load all custom ramps from localStorage. Returns an empty object
 * when none are configured or the blob is malformed.
 *
 * @returns {Record<string, CustomRamp>}
 */
export function loadCustomRamps() {
  const storage = ls();
  if (!storage) return {};
  try {
    const raw = storage.getItem(HYPSO.storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.version !== CUSTOM_VERSION) {
      // Schema mismatch — drop it and start fresh on next save.
      return {};
    }
    if (!parsed.ramps || typeof parsed.ramps !== 'object') return {};
    return parsed.ramps;
  } catch {
    return {};
  }
}

/**
 * Replace the entire custom-ramp blob. Returns true on success.
 *
 * @param {Record<string, CustomRamp>} ramps
 * @returns {boolean}
 */
export function saveCustomRamps(ramps) {
  const storage = ls();
  if (!storage) return false;
  try {
    storage.setItem(
      HYPSO.storageKey,
      JSON.stringify({ version: CUSTOM_VERSION, ramps }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a single custom ramp.
 *
 * @param {CustomRamp} ramp
 * @returns {boolean}
 */
export function upsertCustomRamp(ramp) {
  const all = loadCustomRamps();
  all[ramp.id] = ramp;
  return saveCustomRamps(all);
}

/**
 * Remove a single custom ramp by id.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function deleteCustomRamp(id) {
  const all = loadCustomRamps();
  if (!(id in all)) return false;
  delete all[id];
  return saveCustomRamps(all);
}

/**
 * Validate a candidate custom ramp object. Used by the import flow to
 * reject malformed JSON before it lands in storage. Returns a string
 * error message or null on success.
 *
 * @param {any} candidate
 * @returns {string|null}
 */
export function validateCustomRamp(candidate) {
  if (!candidate || typeof candidate !== 'object') return 'not an object';
  if (typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(candidate.id)) {
    return 'id must be a slug ([a-zA-Z0-9_-]+)';
  }
  if (typeof candidate.name !== 'string') return 'name must be a string';
  if (!isStopsArray(candidate.light)) return 'light must be an array of [elev, "#rrggbb"]';
  if (!isStopsArray(candidate.dark)) return 'dark must be an array of [elev, "#rrggbb"]';
  return null;
}

function isStopsArray(v) {
  if (!Array.isArray(v) || v.length < 2) return false;
  for (const stop of v) {
    if (!Array.isArray(stop) || stop.length !== 2) return false;
    if (typeof stop[0] !== 'number' || !Number.isFinite(stop[0])) return false;
    if (typeof stop[1] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(stop[1])) return false;
  }
  return true;
}

function clampStrength(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1.5, v));
}
