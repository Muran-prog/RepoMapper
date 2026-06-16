/**
 * API client — communicates with the RepoMapper backend.
 *
 * Handles all server communication: sync, access control, export/import.
 * Implements automatic retries, offline queuing, and conflict resolution.
 *
 * The API base URL is determined at runtime:
 *   - Production: same origin (Vercel deployment)
 *   - Development: http://localhost:3000
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = (() => {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return `${window.location.protocol}//${host}:3000`;
  }
  return window.location.origin;
})();

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // ms
const SYNC_DEBOUNCE = 2000; // ms — debounce sync writes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _syncTimer = null;
let _pendingSync = null;
let _lastSyncTimestamp = 0;
let _clientIP = null;
let _listeners = new Set();
let _online = navigator.onLine;

// Track online status
window.addEventListener('online', () => {
  _online = true;
  _flushPendingSync();
});
window.addEventListener('offline', () => {
  _online = false;
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _fetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
  };
  const merged = { ...defaults, ...options };
  if (options.headers) {
    merged.headers = { ...defaults.headers, ...options.headers };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, merged);
      if (res.ok || res.status < 500) {
        return res;
      }
      // Server error — retry
      if (attempt < MAX_RETRIES) {
        await _sleep(RETRY_DELAY * (attempt + 1));
      }
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await _sleep(RETRY_DELAY * (attempt + 1));
    }
  }
  throw new Error(`API request failed after ${MAX_RETRIES} retries: ${path}`);
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _notify(event, data) {
  for (const fn of _listeners) {
    try {
      fn(event, data);
    } catch (e) {
      console.error('[api] Listener error:', e);
    }
  }
}

async function _flushPendingSync() {
  if (_pendingSync && _online) {
    const data = _pendingSync;
    _pendingSync = null;
    await saveToServer(data);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to sync events.
 * Events: 'sync:start', 'sync:done', 'sync:error', 'sync:conflict'
 */
export function onSyncEvent(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Get the client's IP as seen by the server.
 */
export async function getMyIP() {
  if (_clientIP) return _clientIP;
  try {
    const res = await _fetch('/api/health');
    const data = await res.json();
    _clientIP = data.ip;
    return _clientIP;
  } catch {
    return null;
  }
}

/**
 * Load ALL data from the server for the current IP.
 * Returns { data, shared, access, timestamp }.
 */
export async function loadFromServer() {
  try {
    _notify('sync:start', { direction: 'pull' });
    const res = await _fetch('/api/sync');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      _notify('sync:error', err);
      return null;
    }
    const payload = await res.json();
    _lastSyncTimestamp = payload.timestamp;
    _clientIP = payload.ip;
    _notify('sync:done', { direction: 'pull', payload });
    return payload;
  } catch (err) {
    console.error('[api] loadFromServer error:', err);
    _notify('sync:error', { message: err.message });
    return null;
  }
}

/**
 * Save data to the server (full replace).
 * Accepts { features, prefs, settings, contours }.
 */
export async function saveToServer(data) {
  if (!_online) {
    _pendingSync = data;
    return false;
  }

  try {
    _notify('sync:start', { direction: 'push' });
    const res = await _fetch('/api/sync', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const payload = await res.json();
    _lastSyncTimestamp = payload.timestamp;
    _notify('sync:done', { direction: 'push', payload });
    return payload.ok;
  } catch (err) {
    console.error('[api] saveToServer error:', err);
    _pendingSync = data;
    _notify('sync:error', { message: err.message });
    return false;
  }
}

/**
 * Debounced save — call this from the UI on every change.
 * Batches rapid updates into a single API call.
 */
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

/**
 * Merge data with existing server data.
 */
export async function mergeToServer(data) {
  try {
    const res = await _fetch('/api/sync', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return (await res.json()).ok;
  } catch (err) {
    console.error('[api] mergeToServer error:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/**
 * Get current access configuration.
 */
export async function getAccess() {
  try {
    const res = await _fetch('/api/access');
    return await res.json();
  } catch (err) {
    console.error('[api] getAccess error:', err);
    return null;
  }
}

/**
 * Add an IP to the shared list.
 */
export async function addSharedIP(ip) {
  try {
    const res = await _fetch('/api/access', {
      method: 'POST',
      body: JSON.stringify({ ip }),
    });
    return await res.json();
  } catch (err) {
    console.error('[api] addSharedIP error:', err);
    return null;
  }
}

/**
 * Remove an IP from the shared list.
 */
export async function removeSharedIP(ip) {
  try {
    const res = await _fetch('/api/access', {
      method: 'DELETE',
      body: JSON.stringify({ ip }),
    });
    return await res.json();
  } catch (err) {
    console.error('[api] removeSharedIP error:', err);
    return null;
  }
}

/**
 * Replace the entire shared IP list.
 */
export async function setSharedIPs(ips) {
  try {
    const res = await _fetch('/api/access', {
      method: 'PUT',
      body: JSON.stringify({ ips }),
    });
    return await res.json();
  } catch (err) {
    console.error('[api] setSharedIPs error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

/**
 * Export all data as a downloadable JSON file.
 */
export async function exportAllData() {
  try {
    const res = await _fetch('/api/export');
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
    console.error('[api] exportAllData error:', err);
    return false;
  }
}

/**
 * Import data from a JSON file.
 * @param {object} data — Parsed JSON from the export file
 * @param {string} mode — 'replace' or 'merge'
 */
export async function importAllData(data, mode = 'replace') {
  try {
    const res = await _fetch('/api/import', {
      method: 'POST',
      body: JSON.stringify({ ...data, mode }),
    });
    return await res.json();
  } catch (err) {
    console.error('[api] importAllData error:', err);
    return null;
  }
}

/**
 * Import data from a local File object.
 */
export function importFromFile(file, mode = 'replace') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const result = await importAllData(data, mode);
        resolve(result);
      } catch (err) {
        reject(new Error('Invalid JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// Auto-sync on page visibility change
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _online) {
      // Reload data when tab becomes visible
      loadFromServer().then((data) => {
        if (data) _notify('sync:refresh', data);
      });
    }
  });
}
