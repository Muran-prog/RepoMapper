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

import { loadFromServer, postSync, beaconSync, isOnline } from '../api/client.js';

// ---------------------------------------------------------------------------
// Routing — which kv keys map to which dedicated server field.
// Everything not listed here is folded into the opaque `settings.kv` blob.
// ---------------------------------------------------------------------------

const FEATURES_KEY = 'cart:draw:features:v1';
const DRAW_PREFS_KEY = 'cart:draw:prefs:v1';
const CONTOURS_KEY = 'cart:settlement-contours:v1';

/** The three keys that map to dedicated, full-replace server fields. */
const STRUCTURED_KEYS = new Set([FEATURES_KEY, DRAW_PREFS_KEY, CONTOURS_KEY]);

/** Debounce window before a batch of edits is pushed to the server. */
const FLUSH_DEBOUNCE_MS = 800;

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

// --- Dirty tracking -------------------------------------------------------
// We never push a full snapshot. Instead we track exactly which keys changed
// since the last successful save and send ONLY those. That is what keeps one
// device from clobbering another's untouched state: flipping a layer toggle
// pushes just that one settings key, never the drawings or contours.

/** kv keys with unsynced local changes. */
let _dirty = new Set();
/** Settings keys deleted locally and not yet removed on the server. */
let _removed = new Set();
/**
 * Keys whose last save was rejected by the server because the field was too
 * large (>4 MB). Retrying the identical payload can't help, so these are
 * parked here instead of left in `_dirty` (which would retry-spam). A fresh
 * edit to the key clears it from here and gives it another chance.
 */
let _blocked = new Set();

let _flushTimer = null;
let _inFlight = false;

/** Which server field a kv key maps to. */
function fieldForKey(key) {
  if (key === FEATURES_KEY) return 'features';
  if (key === DRAW_PREFS_KEY) return 'prefs';
  if (key === CONTOURS_KEY) return 'contours';
  return 'settings';
}

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
    _dirty.add(key);
    _removed.delete(key);
    _blocked.delete(key); // changed value → worth trying again
    scheduleFlush();
  },
  removeItem(key) {
    if (!(key in _kv)) return;
    delete _kv[key];
    if (STRUCTURED_KEYS.has(key)) {
      // A structured field cleared — push its (now default/empty) value.
      _dirty.add(key);
    } else {
      // A settings key deleted — tell the server to drop it.
      _dirty.delete(key);
      _removed.add(key);
    }
    scheduleFlush();
  },
  clear() {
    for (const key of Object.keys(_kv)) {
      if (STRUCTURED_KEYS.has(key)) _dirty.add(key);
      else _removed.add(key);
    }
    _kv = Object.create(null);
    scheduleFlush();
  },
};

// ---------------------------------------------------------------------------
// Snapshot ↔ server mapping
// ---------------------------------------------------------------------------

/**
 * Build a PARTIAL server payload from the given dirty / removed key sets —
 * only the structured fields that changed, plus a per-key settings patch and
 * a list of removed settings keys. Untouched fields are simply absent, so the
 * server never overwrites them.
 */
function buildPayload(dirty, removed) {
  const payload = {};

  if (dirty.has(FEATURES_KEY)) {
    payload.features = parseOr(_kv[FEATURES_KEY], { version: 1, features: [] });
  }
  if (dirty.has(DRAW_PREFS_KEY)) {
    const prefs = parseOr(_kv[DRAW_PREFS_KEY], null);
    if (prefs) payload.prefs = prefs;
  }
  if (dirty.has(CONTOURS_KEY)) {
    payload.contours = parseOr(_kv[CONTOURS_KEY], { version: 1, features: [] });
  }

  const patch = {};
  for (const key of dirty) {
    if (STRUCTURED_KEYS.has(key)) continue;
    if (_kv[key] !== undefined) patch[key] = _kv[key];
  }
  if (Object.keys(patch).length) payload.settingsPatch = patch;
  if (removed.size) payload.settingsRemove = [...removed];

  return payload;
}

/**
 * Populate `_kv` from a server `data` object (boot hydrate / remote apply).
 *
 * @param {object} data
 * @param {boolean} [preserveDirty=false] When applying a remote refresh, keep
 *   locally-changed-but-not-yet-saved keys instead of letting the server copy
 *   overwrite them (otherwise a focus-refresh could drop a pending edit).
 */
function hydrateFromServer(data, preserveDirty = false) {
  if (!data || typeof data !== 'object') return;
  const skip = (key) => preserveDirty && (_dirty.has(key) || _removed.has(key));

  if (data.features && Array.isArray(data.features.features) && !skip(FEATURES_KEY)) {
    _kv[FEATURES_KEY] = JSON.stringify(data.features);
  }
  if (data.prefs && typeof data.prefs === 'object' && !skip(DRAW_PREFS_KEY)) {
    _kv[DRAW_PREFS_KEY] = JSON.stringify(data.prefs);
  }
  if (data.contours && typeof data.contours === 'object' && !skip(CONTOURS_KEY)) {
    _kv[CONTOURS_KEY] = JSON.stringify(data.contours);
  }

  const settings = data.settings;
  if (settings && typeof settings === 'object') {
    if (settings.kv && typeof settings.kv === 'object') {
      // New format — a flat map of cart:* keys → stored strings.
      for (const [k, v] of Object.entries(settings.kv)) {
        if (typeof v === 'string' && !skip(k)) _kv[k] = v;
      }
    } else {
      // Legacy format — { uiPrefs, mapMode, hypsoPrefs }. Map it forward so
      // existing accounts keep their settings on first load after upgrade.
      if (settings.uiPrefs && !skip('cart:ui:prefs:v1')) _kv['cart:ui:prefs:v1'] = JSON.stringify(settings.uiPrefs);
      if (typeof settings.mapMode === 'string' && !skip('cart:map-mode')) _kv['cart:map-mode'] = settings.mapMode;
      if (settings.hypsoPrefs && !skip('cart:hypso:prefs:v1')) _kv['cart:hypso:prefs:v1'] = JSON.stringify(settings.hypsoPrefs);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence — debounced, partial, success-aware.
// ---------------------------------------------------------------------------

function scheduleFlush() {
  if (_suspend > 0 || !_ready) return;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { _flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
}

/**
 * Push the current dirty set to the server. Clears only the keys that were
 * actually confirmed saved — anything changed mid-flight stays dirty and is
 * picked up by the next flush. Never runs two pushes at once.
 */
async function flush() {
  if (_suspend > 0 || !_ready || _inFlight) return;
  if (!_dirty.size && !_removed.size) return;
  if (!isOnline()) return; // wait for the 'online' event to retry

  _inFlight = true;
  const sentDirty = new Set(_dirty);
  const sentRemoved = new Set(_removed);
  let res = { ok: false };
  try {
    res = await postSync(buildPayload(sentDirty, sentRemoved));
  } catch {
    res = { ok: false };
  }
  _inFlight = false;

  if (res.ok) {
    // Fields the server refused because they were too large (>4 MB).
    const rejectedFields = new Set((res.rejected || []).map((r) => r.field));
    for (const k of sentDirty) {
      _dirty.delete(k);
      // If its field was rejected, park it (don't retry the same oversized
      // payload) until the user changes that key again.
      if (rejectedFields.has(fieldForKey(k))) _blocked.add(k);
    }
    // Removals only shrink the blob, so they never hit the size cap.
    for (const k of sentRemoved) _removed.delete(k);
  } else if (res.tooLarge) {
    // Whole-body 413 — no per-field info. Park everything we tried to send so
    // we don't retry-spam an oversized payload; a fresh edit un-blocks a key.
    // Removals are tiny, so keep them to retry on their own.
    for (const k of sentDirty) { _dirty.delete(k); _blocked.add(k); }
  }

  // New edits arrived during the push, or it failed (network) — try again.
  // Blocked keys are no longer in _dirty, so this won't spin on oversize data.
  if (_dirty.size || _removed.size) scheduleFlush();
}

/** Force an immediate flush and await it (used by the re-auth path). */
export async function flushPending() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await flush();
  return !_dirty.size && !_removed.size;
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
        _dirty.add(key);
        imported = true;
      }
    } else if (!(key in _kv)) {
      _kv[key] = val;
      _dirty.add(key);
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
      if (val != null && !(key in _kv)) { _kv[key] = val; _dirty.add(key); }
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
  installLifecycle();

  // If migration pulled in legacy local data, push it now (the migrated keys
  // were marked dirty) so the account reflects it immediately.
  if (needsPersist) {
    try { await flush(); } catch { /* will retry on next edit / online */ }
  }

  return true;
}

/** Has the account state finished its initial load? */
export function isAccountStateReady() {
  return _ready;
}

// ---------------------------------------------------------------------------
// Lifecycle — reconnect retry + reliable save-on-exit. Installed once, after
// the first successful init, so these only ever fire for a ready store.
// ---------------------------------------------------------------------------

let _lifecycleInstalled = false;

function installLifecycle() {
  if (_lifecycleInstalled || typeof window === 'undefined') return;
  _lifecycleInstalled = true;

  // Came back online — retry whatever is still dirty.
  window.addEventListener('online', () => { scheduleFlush(); });

  // Save-on-exit. A hidden tab is the last reliable moment before a close, so
  // beacon the pending dirty set then (beacon survives page teardown). pagehide
  // / beforeunload are backstops. We do NOT clear the dirty set here: if the
  // tab is merely being backgrounded the next flush is harmless, and if it is
  // truly closing it no longer matters.
  const beaconNow = () => {
    if (!_dirty.size && !_removed.size) return;
    beaconSync(buildPayload(_dirty, _removed));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconNow();
  });
  window.addEventListener('pagehide', beaconNow);
  window.addEventListener('beforeunload', beaconNow);
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
    // preserveDirty: never let an incoming refresh overwrite a key the user
    // has changed locally but we haven't managed to save yet.
    hydrateFromServer(data, true);

    // Only push a field into its live engine if we didn't just preserve a
    // local pending edit for it (otherwise we'd revert the user's own change).
    if (!_dirty.has(FEATURES_KEY)) {
      const feats = parseOr(_kv[FEATURES_KEY], null);
      if (feats?.features && drawEngine?.importGeoJSON) {
        try {
          drawEngine.importGeoJSON({ type: 'FeatureCollection', features: feats.features });
        } catch (e) { console.error('[account-store] apply features:', e); }
      }
    }

    if (!_dirty.has(DRAW_PREFS_KEY)) {
      const prefs = parseOr(_kv[DRAW_PREFS_KEY], null);
      if (prefs && drawEngine?.setPrefs) {
        try { drawEngine.setPrefs(prefs); } catch (e) { console.error('[account-store] apply prefs:', e); }
      }
    }

    if (!_dirty.has(CONTOURS_KEY)) {
      const contours = parseOr(_kv[CONTOURS_KEY], null);
      if (contours && contourEngine?.replaceAll) {
        try { contourEngine.replaceAll(contours.features || contours); }
        catch (e) { console.error('[account-store] apply contours:', e); }
      }
    }
  } finally {
    _suspend--;
  }
}
