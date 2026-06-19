/**
 * API client — talks to the account-based RepoMapper backend.
 *
 * Everything is keyed to the logged-in account via an HttpOnly session
 * cookie (sent automatically with `credentials: 'include'`). There is no
 * IP anywhere. All endpoints are same-origin on the Vercel deployment.
 *
 * Responsibilities:
 *   • auth        — register / login / logout / me / change password
 *   • sync        — load / save / merge the account's data
 *   • export/import
 *   • resilience  — retries, offline queue, debounced writes
 *   • events      — sync:* and auth:* notifications for the UI
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = (() => {
  if (typeof window === 'undefined') return '';
  // The API is always served from the same origin as the app (Vercel).
  return window.location.origin;
})();

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // ms
const SYNC_DEBOUNCE = 800; // ms

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _syncTimer = null;
let _pendingSync = null;
let _lastSyncTimestamp = 0;
let _currentUser = null;
let _syncListeners = new Set();
let _authListeners = new Set();
let _online = typeof navigator !== 'undefined' ? navigator.onLine : true;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { _online = true; _flushPendingSync(); });
  window.addEventListener('offline', () => { _online = false; _notifySync('sync:offline', {}); });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _notifySync(event, data) {
  for (const fn of _syncListeners) { try { fn(event, data); } catch (e) { console.error('[api] sync listener', e); } }
}
function _notifyAuth(event, data) {
  for (const fn of _authListeners) { try { fn(event, data); } catch (e) { console.error('[api] auth listener', e); } }
}

async function _fetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const defaults = { headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  const merged = { ...defaults, ...options, credentials: 'include' };
  merged.headers = { ...defaults.headers, ...(options.headers || {}) };

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, merged);
      // 401 means the session is gone — surface it immediately (no retry).
      if (res.status === 401) {
        _currentUser = null;
        _notifyAuth('auth:required', { path });
        return res;
      }
      if (res.ok || res.status < 500) return res;
      if (attempt < MAX_RETRIES) await _sleep(RETRY_DELAY * (attempt + 1));
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_RETRIES) throw err;
      await _sleep(RETRY_DELAY * (attempt + 1));
    }
  }
  throw lastErr || new Error(`API request failed: ${path}`);
}

async function _flushPendingSync() {
  if (_pendingSync && _online) {
    const data = _pendingSync;
    _pendingSync = null;
    await saveToServer(data);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Subscribe to sync events: sync:start | sync:done | sync:error | sync:offline | sync:refresh */
export function onSyncEvent(fn) { _syncListeners.add(fn); return () => _syncListeners.delete(fn); }

/** Subscribe to auth events: auth:required | auth:login | auth:logout */
export function onAuthEvent(fn) { _authListeners.add(fn); return () => _authListeners.delete(fn); }

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function getCurrentUser() { return _currentUser; }

async function _authCall(path, payload) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: 'Сеть недоступна. Проверьте подключение.' };
  }
  let body = {};
  try { body = await res.json(); } catch {}
  if (res.ok && body.ok) {
    _currentUser = body.user || null;
    return { ok: true, user: _currentUser };
  }
  return { ok: false, status: res.status, error: body.error || `Ошибка (${res.status})` };
}

export function register(username, password) {
  return _authCall('/api/auth/register', { username, password });
}

export function login(username, password) {
  return _authCall('/api/auth/login', { username, password });
}

export async function changePassword(currentPassword, newPassword) {
  return _authCall('/api/auth/password', { currentPassword, newPassword });
}

export async function logout(everywhere = false) {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ everywhere }),
    });
  } catch {}
  _currentUser = null;
  _notifyAuth('auth:logout', {});
  return true;
}

/** Returns the current user object, or null if not authenticated. */
export async function fetchMe() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) { _currentUser = null; return null; }
    const body = await res.json();
    _currentUser = body.user || null;
    return _currentUser;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Load ALL data for the logged-in account. Returns the payload or null. */
export async function loadFromServer() {
  try {
    _notifySync('sync:start', { direction: 'pull' });
    const res = await _fetch('/api/sync');
    if (res.status === 401) { _notifySync('sync:error', { status: 401 }); return null; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      _notifySync('sync:error', err);
      return null;
    }
    const payload = await res.json();
    _lastSyncTimestamp = payload.timestamp;
    if (payload.user) _currentUser = payload.user;
    _notifySync('sync:done', { direction: 'pull', payload });
    return payload;
  } catch (err) {
    console.error('[api] loadFromServer:', err);
    _notifySync('sync:error', { message: err.message });
    return null;
  }
}

/** Save a full snapshot to the server (replace). */
export async function saveToServer(data) {
  if (!_online) { _pendingSync = data; _notifySync('sync:offline', {}); return false; }
  try {
    _notifySync('sync:start', { direction: 'push' });
    const res = await _fetch('/api/sync', { method: 'POST', body: JSON.stringify(data) });
    if (res.status === 401) { _pendingSync = data; _notifySync('sync:error', { status: 401 }); return false; }
    const payload = await res.json();
    _lastSyncTimestamp = payload.timestamp;
    _notifySync('sync:done', { direction: 'push', payload });
    return !!payload.ok;
  } catch (err) {
    console.error('[api] saveToServer:', err);
    _pendingSync = data;
    _notifySync('sync:error', { message: err.message });
    return false;
  }
}

/** Debounced save — call on every change; batches rapid updates. */
export function debouncedSave(data) {
  _pendingSync = data;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    _syncTimer = null;
    if (_pendingSync) {
      const d = _pendingSync;
      _pendingSync = null;
      await saveToServer(d);
    }
  }, SYNC_DEBOUNCE);
}

/** Flush any pending debounced write immediately (e.g. before unload). */
export async function flushNow() {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  if (_pendingSync) {
    const d = _pendingSync; _pendingSync = null;
    return await saveToServer(d);
  }
  return true;
}

/**
 * Flush the pending write on page unload — RELIABLY.
 *
 * A normal `fetch()` started from `pagehide` / `beforeunload` / a hidden
 * `visibilitychange` is routinely cancelled when the browser tears the page
 * down, so the last edit before closing a tab could silently never reach the
 * server. `navigator.sendBeacon()` is the platform primitive made for exactly
 * this: the request is handed to the browser and guaranteed to be sent even
 * after the page is gone. It is POST-only and same-origin here, so the session
 * cookie rides along automatically and no CORS preflight is involved.
 *
 * Falls back to `fetch(..., { keepalive: true })` (also unload-survivable)
 * when sendBeacon is unavailable or refuses the payload (e.g. size cap).
 */
export function flushBeacon() {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  if (!_pendingSync) return true;
  const data = _pendingSync;
  const url = `${API_BASE}/api/sync`;
  const body = JSON.stringify(data);

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) { _pendingSync = null; return true; }
    }
  } catch { /* fall through to keepalive fetch */ }

  // sendBeacon unavailable or rejected the payload — try a keepalive fetch,
  // which is also allowed to outlive the document.
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body,
      keepalive: true,
    });
    _pendingSync = null;
    return true;
  } catch {
    return false;
  }
}

/** Merge data with existing server data (union features by id). */
export async function mergeToServer(data) {
  try {
    const res = await _fetch('/api/sync', { method: 'PUT', body: JSON.stringify(data) });
    if (!res.ok) return false;
    return (await res.json()).ok;
  } catch (err) {
    console.error('[api] mergeToServer:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

export async function exportAllData() {
  try {
    const res = await _fetch('/api/export');
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `repomapper-export-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error('[api] exportAllData:', err);
    return false;
  }
}

export async function importAllData(data, mode = 'replace') {
  try {
    const res = await _fetch('/api/import', { method: 'POST', body: JSON.stringify({ ...data, mode }) });
    return await res.json();
  } catch (err) {
    console.error('[api] importAllData:', err);
    return null;
  }
}

export function importFromFile(file, mode = 'replace') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        resolve(await importAllData(data, mode));
      } catch {
        reject(new Error('Некорректный JSON-файл'));
      }
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// Auto-refresh on tab focus (keeps devices in sync)
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // The user is switching away (other tab / app / closing the tab) — this
      // is the LAST reliable moment to persist, so use the beacon transport
      // that survives page teardown. `hidden` fires before `pagehide` on a
      // real close, so this is the primary save-on-exit path.
      flushBeacon();
    } else if (document.visibilityState === 'visible' && _online && _currentUser) {
      loadFromServer().then((data) => { if (data) _notifySync('sync:refresh', data); });
    }
  });
  // Backstops for the actual unload, both using the unload-survivable beacon.
  window.addEventListener('pagehide', () => { flushBeacon(); });
  window.addEventListener('beforeunload', () => { flushBeacon(); });
}
