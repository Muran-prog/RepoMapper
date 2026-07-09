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
 *     "controlsCollapsed": boolean,   // top-right MapLibre cluster
 *     "scaleCollapsed":    boolean    // left-edge map-scale control
 *   }
 *
 * The map-mode preference (`cart` | `standard` | `satellite`) lives in
 * its OWN top-level account-store key (`cart:map-mode`) per the brief.
 * That key is read/written through `loadMapMode()` / `saveMapMode()`
 * below so the mode switcher and createMap() touch the same source of
 * truth without tripping over the older `cart:ui:prefs:v1` schema.
 *
 * Missing fields fall back to the per-device defaults that the caller
 * supplies — on touch / narrow viewports the chrome is collapsed by
 * default to reclaim screen real estate.
 *
 * @typedef {object} UiPrefs
 * @property {boolean} hudCollapsed
 * @property {boolean} controlsCollapsed
 * @property {boolean} scaleCollapsed
 */

import {
  FEATURES,
  DEFAULT_THEME,
  MAP_MODES,
  DEFAULT_MAP_MODE,
  MAP_MODE_STORAGE_KEY,
} from '../config.js';
import { kv } from '../state/account-store.js';

const KEY = 'cart:ui:prefs:v1';
const CONTROL_PREFS_KEY = 'cart:ui:controls:v1';
const CONTROL_THEMES = ['light', 'dark'];
const CONTROL_QUALITY_CHOICES = ['auto', 'high', 'low'];

export const CONTROL_LAYER_FEATURE_KEYS = Object.freeze([
  'labels',
  'pois',
  'buildings3D',
  'hillshade',
  'terrain3D',
  'contours',
  'hypsometricTint',
  'bathymetry',
  'textureShading',
  'skyViewFactor',
  'worldcoverTint',
  'canopyHeightTint',
  'forestLeafType',
  'forestCover',
  'swampCover',
  'forestCities',
  'forestWaterAccent',
  'forestRoadsBold',
  'forestRoadsOrange',
  'slopeWarning',
  'ridgeOverlay',
  'carpathian',
  'carpathianTrails',
  'hazardousTerrain',
  'settlementOutline',
  'settlementContoursTop',
  'roadsOrangeBold',
  'grid',
]);

const CONTROL_LAYER_FEATURE_KEY_SET = new Set(CONTROL_LAYER_FEATURE_KEYS);

// Legacy per-feature keys that already exist in account data. The aggregate
// controls blob wins, but these keep existing accounts from losing settings.
const LEGACY_LAYER_PREF_KEYS = Object.freeze({
  worldcoverTint: 'cart:features:worldcoverTint',
  canopyHeightTint: 'cart:features:canopyHeightTint',
  forestLeafType: 'cart:features:forestLeafType',
  forestCover: 'cart:features:forestCover',
  forestCities: 'cart:features:forestCities',
  forestWaterAccent: 'cart:features:forestWaterAccent',
  forestRoadsBold: 'cart:features:forestRoadsBold',
  forestRoadsOrange: 'cart:features:forestRoadsOrange',
  hazardousTerrain: 'cart:features:hazardousTerrain',
  carpathianTrails: 'cart:features:carpathianTrails',
  roadsOrangeBold: 'cart:features:roadsOrangeBold',
  grid: 'cart:features:grid',
});

/**
 * Persistence handle. Backed by the account store (server-synced, in-memory)
 * rather than localStorage — see src/state/account-store.js. Kept as a tiny
 * accessor so the load/save code below stays unchanged.
 */
function ls() {
  return kv;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readControlPrefsRaw() {
  const storage = ls();
  if (!storage) return {};
  try {
    const raw = storage.getItem(CONTROL_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadLegacyBoolPref(key) {
  const storage = ls();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function clampExaggeration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0.5, Math.min(2, n));
}

function sanitiseStoredControlPrefs(stored) {
  const next = {};
  if (CONTROL_THEMES.includes(stored.theme)) next.theme = stored.theme;
  if (CONTROL_QUALITY_CHOICES.includes(stored.qualityChoice)) {
    next.qualityChoice = stored.qualityChoice;
  }
  const exaggeration = clampExaggeration(stored.exaggeration);
  if (exaggeration != null) next.exaggeration = exaggeration;

  const storedFeatures = isPlainObject(stored.layerFeatures) ? stored.layerFeatures : {};
  const layerFeatures = {};
  for (const key of CONTROL_LAYER_FEATURE_KEYS) {
    if (typeof storedFeatures[key] === 'boolean') layerFeatures[key] = storedFeatures[key];
  }
  if (Object.keys(layerFeatures).length) next.layerFeatures = layerFeatures;
  return next;
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
    scaleCollapsed: false,
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
      scaleCollapsed:
        typeof parsed.scaleCollapsed === 'boolean'
          ? parsed.scaleCollapsed
          : fallback.scaleCollapsed,
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

// ---------------------------------------------------------------------------
// Map-mode preference — separate top-level key per the brief.
// ---------------------------------------------------------------------------

/**
 * Read the persisted map-mode choice. Falls back to `DEFAULT_MAP_MODE`
 * when storage is unavailable or the saved value isn't one of the
 * known modes (covers stale or hand-edited keys).
 *
 * @returns {'cart'|'standard'|'satellite'}
 */
export function loadMapMode() {
  const storage = ls();
  if (!storage) return DEFAULT_MAP_MODE;
  try {
    const raw = storage.getItem(MAP_MODE_STORAGE_KEY);
    if (typeof raw !== 'string') return DEFAULT_MAP_MODE;
    if (!MAP_MODES.includes(raw)) {
      storage.removeItem(MAP_MODE_STORAGE_KEY);
      return DEFAULT_MAP_MODE;
    }
    return raw;
  } catch {
    return DEFAULT_MAP_MODE;
  }
}

/**
 * Persist the user's map-mode choice. Best-effort — storage failures
 * (Safari private mode, quota) are swallowed so the UI never crashes.
 *
 * @param {'cart'|'standard'|'satellite'} mode
 */
export function saveMapMode(mode) {
  if (!MAP_MODES.includes(mode)) return;
  const storage = ls();
  if (!storage) return;
  try {
    storage.setItem(MAP_MODE_STORAGE_KEY, mode);
  } catch {
    /* quota / serialise error — best-effort */
  }
}

// ---------------------------------------------------------------------------
// Main controls preferences — theme, quality, exaggeration and layer toggles.
// ---------------------------------------------------------------------------

/**
 * Load all user-facing control preferences. The returned object is fully
 * populated so boot can pass it straight into createMap(), while writes stay
 * sparse so merely changing the theme does not freeze every feature default.
 */
export function loadControlPrefs(featureDefaults = FEATURES) {
  const defaults = isPlainObject(featureDefaults) ? featureDefaults : FEATURES;
  const stored = readControlPrefsRaw();
  const storedFeatures = isPlainObject(stored.layerFeatures) ? stored.layerFeatures : {};
  const layerFeatures = {};

  for (const key of CONTROL_LAYER_FEATURE_KEYS) {
    if (typeof storedFeatures[key] === 'boolean') {
      layerFeatures[key] = storedFeatures[key];
      continue;
    }
    const legacyKey = LEGACY_LAYER_PREF_KEYS[key];
    if (legacyKey) {
      const legacy = loadLegacyBoolPref(legacyKey);
      if (typeof legacy === 'boolean') {
        layerFeatures[key] = legacy;
        continue;
      }
    }
    const defaultValue = Object.prototype.hasOwnProperty.call(defaults, key)
      ? defaults[key]
      : FEATURES[key];
    layerFeatures[key] = !!defaultValue;
  }

  return {
    theme: CONTROL_THEMES.includes(stored.theme) ? stored.theme : DEFAULT_THEME,
    qualityChoice: CONTROL_QUALITY_CHOICES.includes(stored.qualityChoice)
      ? stored.qualityChoice
      : 'auto',
    exaggeration: clampExaggeration(stored.exaggeration) ?? 1,
    layerFeatures,
  };
}

/** Persist a sparse patch of control preferences. */
export function saveControlPrefs(patch = {}) {
  const storage = ls();
  if (!storage) return;
  try {
    const next = sanitiseStoredControlPrefs(readControlPrefsRaw());

    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      if (CONTROL_THEMES.includes(patch.theme)) next.theme = patch.theme;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'qualityChoice')) {
      if (CONTROL_QUALITY_CHOICES.includes(patch.qualityChoice)) {
        next.qualityChoice = patch.qualityChoice;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'exaggeration')) {
      const exaggeration = clampExaggeration(patch.exaggeration);
      if (exaggeration != null) next.exaggeration = exaggeration;
    }
    if (isPlainObject(patch.layerFeatures)) {
      const layerFeatures = isPlainObject(next.layerFeatures)
        ? { ...next.layerFeatures }
        : {};
      for (const [key, value] of Object.entries(patch.layerFeatures)) {
        if (CONTROL_LAYER_FEATURE_KEY_SET.has(key) && typeof value === 'boolean') {
          layerFeatures[key] = value;
        }
      }
      if (Object.keys(layerFeatures).length) next.layerFeatures = layerFeatures;
    }

    storage.setItem(CONTROL_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* quota / serialise error — best-effort */
  }
}

/** Persist one layer toggle and mirror old per-feature keys when they exist. */
export function saveLayerFeaturePref(key, value) {
  if (!CONTROL_LAYER_FEATURE_KEY_SET.has(key)) return;
  const bool = !!value;
  saveControlPrefs({ layerFeatures: { [key]: bool } });

  const legacyKey = LEGACY_LAYER_PREF_KEYS[key];
  if (!legacyKey) return;
  try {
    kv.setItem(legacyKey, bool ? '1' : '0');
  } catch {
    /* best-effort */
  }
}
