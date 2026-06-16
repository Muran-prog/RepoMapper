/**
 * Same-tab localStorage write bus.
 *
 * Why this exists
 * ---------------
 * The native `storage` DOM event fires ONLY in *other* documents of the same
 * origin — never in the document that performed the write (per the HTML
 * Storage spec). That makes it useless for the most common case in this app:
 * the CURRENT tab changes a setting, a preference, or hand-draws a settlement
 * contour and we need to push that change to the server. Relying on `storage`
 * meant those writes were persisted locally but NEVER synced — the root cause
 * of "the manual contour is gone after logging in elsewhere".
 *
 * Fix: wrap `localStorage.setItem` / `removeItem` so every `cart:*` write also
 * dispatches a same-tab `cart:local-write` CustomEvent that the sync layer
 * listens to (alongside the native cross-tab `storage` event). The wrapper is
 * installed exactly once and is a no-op everywhere it can't run safely.
 */

let _installed = false;

/**
 * Install the same-tab write bus. Idempotent and defensive: it never throws,
 * always calls through to the original implementation, and only emits for
 * `cart:*` keys written to `window.localStorage` (sessionStorage is ignored).
 */
export function installLocalWriteBus() {
  if (_installed) return;
  if (typeof window === 'undefined') return;

  let proto;
  try {
    // Storage.prototype is the shared implementation behind window.localStorage.
    proto = typeof Storage !== 'undefined' ? Storage.prototype : null;
    if (!proto || typeof proto.setItem !== 'function') return;
    // Touch localStorage to surface "disabled storage" (Safari private mode)
    // before we patch anything — if it throws we simply don't install.
    void window.localStorage;
  } catch {
    return;
  }

  _installed = true;

  const emit = (key, value) => {
    try {
      if (typeof key !== 'string' || !key.startsWith('cart:')) return;
      window.dispatchEvent(new CustomEvent('cart:local-write', { detail: { key, value } }));
    } catch {
      /* dispatch must never break a storage write */
    }
  };

  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  const origClear = proto.clear;

  proto.setItem = function setItem(key, value) {
    const r = origSet.apply(this, arguments);
    try { if (this === window.localStorage) emit(key, value); } catch {}
    return r;
  };

  proto.removeItem = function removeItem(key) {
    const r = origRemove.apply(this, arguments);
    try { if (this === window.localStorage) emit(key, null); } catch {}
    return r;
  };

  proto.clear = function clear() {
    const r = origClear.apply(this, arguments);
    try {
      if (this === window.localStorage) {
        // A blanket clear can affect any cart:* key — signal a generic change.
        window.dispatchEvent(new CustomEvent('cart:local-write', { detail: { key: 'cart:*', value: null } }));
      }
    } catch {}
    return r;
  };
}
