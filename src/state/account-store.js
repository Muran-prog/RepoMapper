/**
 * Account state store — the single source of truth for ALL persisted
 * client state.
 *
 * Background
 * ----------
 * The app used to scatter its persistence across ~16 `localStorage` keys,
 * with a monkey-patched `localStorage.setItem` write-bus and a synchronous
 * `_applyingServer` guard duct-taping a subset of that state up to the
 * account backend. The result was fragile: feature toggles, accordion /
 * sidebar layout, custom hypso ramps and more were never synced, and the
 * dual engine ↔ localStorage ↔ server state raced on every edit.
 *
 * This module replaces all of that with one rule: **the server is the only
 * source of truth.** At boot we load the account's data ONCE, hydrate an
 * in-memory key→string map (`_kv`) that mirrors the old localStorage API,
 * and every subsequent read/write goes through that in-memory map. Any
 * write schedules a debounced push of the full snapshot to the server.
 * There is no localStorage anywhere in the steady state — it is read exactly
 * once, at first boot, to migrate any pre-existing local data up to the
 * account (after which those legacy keys are deleted).
 *
 * Server data model (unchanged): `{ features, prefs, settings, contours }`.
 *   • features  ← cart:draw:features:v1        (GeoJSON FeatureCollection)
 *   • prefs     ← cart:draw:prefs:v1           (draw tool prefs)
 *   • contours  ← cart:settlement-contours:v1  (GeoJSON FeatureCollection)
 *   • settings  ← { kv: { <every other cart:* key>: <stored string> } }
 *
 * The helper modules (ui/store.js, draw/store.js, ui/hypso/store.js,
 * ui/accordion.js, ui/controls.js, draw/settlement-contours.js) all read and
 * write through the `kv` shim exported here instead of `window.localStorage`,
 * so their public APIs are unchanged — only the persistence target moved.
 */

import { loadFromServer, saveToServer, debouncedSave } from '../api/client.js';

// ---------------------------------------------------------------------------
// Routing — which kv keys map to which dedicated server field.
// Everything not listed here is folded into the opaque `settings.kv` blob.
// ---------------------------------------------------------------------------

const FEATURES_KEY = 'cart:draw:features:v1';
const DRAW_PREFS_KEY = 'cart:draw:prefs:v1';
const CONTOURS_KEY = 'cart:settlement-contours:v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Record<string,string>} in-memory mirror of the old localStorage. */
let _kv = Object.create(null);

/** True once initAccountState() has resolved. */
let _ready = false;

/**
 * Suspends persistence while we are populating `_kv` from the server (boot
 * hydrate) or applying a remote refresh. Without this, hydrating would echo
 * the just-loaded data straight back to the server, and applying a remote
 * refresh would treat the engines' resulting `change` events as local edits.
 * A counter (not a boolean) so nested suspensions compose safely.
 */
let _suspend = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseOr(str, fallback) {
  if (typeof str !== 'string') return fallback;
  try {
    const v = JSON.parse(str);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Number of features encoded in a stored `{version,features}` blob string. */
function featuresCount(str) {
  const o = parseOr(str, null);
  return Array.isArray(o?.features) ? o.features.length : 0;
}

// ---------------------------------------------------------------------------
// The kv shim — a synchronous, localStorage-compatible facade backed by `_kv`.
// Every helper that used `window.localStorage` now uses this instead.
// ---------------------------------------------------------------------------

export const kv = {
  getItem(key) {
    const v = _kv[key];
    return v === undefined ? null : v;
  },
  setItem(key, value) {
    const next = String(value);
    if (_kv[key] === next) return; // no-op write → no needless server push
    _kv[key] = next;
    schedulePersist();
  },
  removeItem(key) {
    if (!(key in _kv)) return;
    delete _kv[key];
    schedulePersist();
  },
  clear() {
    _kv = Object.create(null);
    schedulePersist();
  },
};

// ---------------------------------------------------------------------------
// Snapshot ↔ server mapping
// ---------------------------------------------------------------------------

/** Build the full server snapshot from the current in-memory kv. */
function buildSnapshot() {
  const settingsKv = {};
  for (const key of Object.keys(_kv)) {
    if (key === FEATURES_KEY || key === DRAW_PREFS_KEY || key === CONTOURS_KEY) continue;
    settingsKv[key] = _kv[key];
  }
  return {
    features: parseOr(_kv[FEATURES_KEY], { version: 1, features: [] }),
    prefs: parseOr(_kv[DRAW_PREFS_KEY], null),
    contours: parseOr(_kv[CONTOURS_KEY], null),
    settings: { kv: settingsKv },
  };
}

/** Populate `_kv` from a server `data` object (boot hydrate / remote apply). */
function hydrateFromServer(data) {
  if (!data || typeof data !== 'object') return;

  if (data.features && Array.isArray(data.features.features)) {
    _kv[FEATURES_KEY] = JSON.stringify(data.features);
  }
  if (data.prefs && typeof data.prefs === 'object') {
    _kv[DRAW_PREFS_KEY] = JSON.stringify(data.prefs);
  }
  if (data.contours && typeof data.contours === 'object') {
    _kv[CONTOURS_KEY] = JSON.stringify(data.contours);
  }

  const settings = data.settings;
  if (settings && typeof settings === 'object') {
    if (settings.kv && typeof settings.kv === 'object') {
      // New format — a flat map of cart:* keys → stored strings.
      for (const [k, v] of Object.entries(settings.kv)) {
        if (typeof v === 'string') _kv[k] = v;
      }
    } else {
      // Legacy format — { uiPrefs, mapMode, hypsoPrefs }. Map it forward so
      // existing accounts keep their settings on first load after upgrade.
      if (settings.uiPrefs) _kv['cart:ui:prefs:v1'] = JSON.stringify(settings.uiPrefs);
      if (typeof settings.mapMode === 'string') _kv['cart:map-mode'] = settings.mapMode;
      if (settings.hypsoPrefs) _kv['cart:hypso:prefs:v1'] = JSON.stringify(settings.hypsoPrefs);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function schedulePersist() {
  if (_suspend > 0 || !_ready) return;
  debouncedSave(buildSnapshot());
}

/** Force an immediate (non-debounced) push of the current snapshot. */
export async function persistNow() {
  if (_suspend > 0) return false;
  return saveToServer(buildSnapshot());
}

// ---------------------------------------------------------------------------
// One-time localStorage migration
// ---------------------------------------------------------------------------

function rawLocalStorage() {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    void s.length; // touch — throws in Safari private mode
    return s;
  } catch {
    return null;
  }
}

function listCartKeys(ls) {
  const keys = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('cart:')) keys.push(k);
    }
  } catch { /* ignore */ }
  return keys;
}

/**
 * Migrate any pre-existing localStorage data into the account, then delete
 * the legacy keys so localStorage is never read again. Server data wins;
 * local data only fills genuine gaps (so we never clobber newer account
 * state with a stale device copy). Returns true if anything was imported.
 */
function migrateAndClearLocalStorage() {
  const ls = rawLocalStorage();
  if (!ls) return false;
  const keys = listCartKeys(ls);
  if (!keys.length) return false;

  let imported = false;
  for (const key of keys) {
    let val;
    try { val = ls.getItem(key); } catch { continue; }
    if (val == null) continue;

    if (key === FEATURES_KEY || key === CONTOURS_KEY) {
      // Only import drawings/contours if the account currently has none.
      if (featuresCount(_kv[key]) === 0 && featuresCount(val) > 0) {
        _kv[key] = val;
        imported = true;
      }
    } else if (!(key in _kv)) {
      _kv[key] = val;
      imported = true;
    }
  }

  // Account is now the source of truth — purge the legacy keys.
  for (const key of keys) { try { ls.removeItem(key); } catch { /* ignore */ } }
  return imported;
}

/**
 * Offline fallback: the server was unreachable at boot, so seed `_kv` from
 * whatever is in localStorage (read-only — we do NOT delete it, since we
 * couldn't confirm it reached the server). A later successful boot will run
 * the real migrate-and-clear path.
 */
function seedFromLocalStorageReadOnly() {
  const ls = rawLocalStorage();
  if (!ls) return;
  for (const key of listCartKeys(ls)) {
    try {
      const val = ls.getItem(key);
      if (val != null && !(key in _kv)) _kv[key] = val;
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Load the account's full state from the server into memory. MUST be awaited
 * during boot, after authentication and BEFORE the map / UI are built, so
 * every synchronous helper read (`loadMapMode()`, the draw engine's
 * `loadFeatures()`, etc.) sees the hydrated, account-correct values.
 */
export async function initAccountState() {
  let payload = null;
  try {
    payload = await loadFromServer();
  } catch {
    payload = null;
  }

  _suspend++;
  let needsPersist = false;
  try {
    if (payload && payload.data) {
      hydrateFromServer(payload.data);
      // Server reached → safe to migrate legacy local data up and wipe it.
      needsPersist = migrateAndClearLocalStorage();
    } else {
      // Server unreachable — keep working from local data this session.
      seedFromLocalStorageReadOnly();
    }
  } finally {
    _suspend--;
  }

  _ready = true;

  // If migration pulled in legacy local data, push the merged snapshot now
  // so the account reflects it immediately (don't wait for the next edit).
  if (needsPersist) {
    try { await persistNow(); } catch { /* will retry on next edit */ }
  }

  return true;
}

/** Has the account state finished its initial load? */
export function isAccountStateReady() {
  return _ready;
}

// ---------------------------------------------------------------------------
// Remote refresh / import re-apply
// ---------------------------------------------------------------------------

/**
 * Apply an authoritative server payload to the in-memory store AND to the
 * live engines, so a multi-device refresh (tab focus), a manual refresh, or
 * a fresh import shows up immediately without a reload. Runs under the
 * persistence-suspend guard so the engines' resulting `change` events don't
 * echo the same data straight back to the server.
 *
 * @param {object} payload   The object returned by loadFromServer (has `.data`).
 * @param {object} [engines] { drawEngine, contourEngine }
 */
export function applyRemote(payload, { drawEngine, contourEngine } = {}) {
  const data = payload?.data;
  if (!data) return;

  _suspend++;
  try {
    hydrateFromServer(data);

    const feats = parseOr(_kv[FEATURES_KEY], null);
    if (feats?.features && drawEngine?.importGeoJSON) {
      try {
        drawEngine.importGeoJSON({ type: 'FeatureCollection', features: feats.features });
      } catch (e) { console.error('[account-store] apply features:', e); }
    }

    const prefs = parseOr(_kv[DRAW_PREFS_KEY], null);
    if (prefs && drawEngine?.setPrefs) {
      try { drawEngine.setPrefs(prefs); } catch (e) { console.error('[account-store] apply prefs:', e); }
    }

    const contours = parseOr(_kv[CONTOURS_KEY], null);
    if (contours && contourEngine?.replaceAll) {
      try { contourEngine.replaceAll(contours.features || contours); }
      catch (e) { console.error('[account-store] apply contours:', e); }
    }
  } finally {
    _suspend--;
  }
}
