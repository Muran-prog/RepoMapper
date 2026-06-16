/**
 * Blob storage layer — Vercel Blob via the public REST API.
 *
 * Why Blob instead of Edge Config?
 *   Edge Config is a read-optimised configuration store with a small total
 *   size budget and restrictive write limits. It is the wrong tool for
 *   write-heavy, potentially large per-user map data (drawings, contours).
 *   Vercel Blob is strongly consistent, durable object storage with no
 *   small size cap and no restrictive write-rate limit — exactly what an
 *   accounts system that "must never lose data" needs.
 *
 * Security model:
 *   Vercel Blob objects are served from a public, per-store hostname. We
 *   never store data at a guessable path:
 *     - credentials live at  auth/{HMAC(SESSION_SECRET, username)}.json
 *     - user data lives at    u/{random-256-bit userId}/data.json
 *   Both paths are effectively unguessable capability URLs, so nothing is
 *   publicly enumerable. The read/write token is server-only (env var).
 *
 * Freshness:
 *   Objects are written with Cache-Control max-age=0 and read with a
 *   cache-busting query param + no-store, guaranteeing read-after-write
 *   consistency (verified empirically). This is essential for cross-device
 *   sync to "restore perfectly".
 *
 * All env vars are read lazily to avoid serverless module-eval timing
 * issues.
 */

const API = 'https://blob.vercel-storage.com';
const API_VERSION = '7';

function token() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  return t;
}

let _baseUrl = null;

/** Derive the public read hostname from the RW token (vercel_blob_rw_{storeId}_{secret}). */
export function blobBaseUrl() {
  if (_baseUrl) return _baseUrl;
  const parts = token().split('_'); // ['vercel','blob','rw',storeId,secret...]
  const storeId = parts[3] || '';
  if (!storeId) throw new Error('Cannot derive blob store id from token');
  _baseUrl = `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/`;
  return _baseUrl;
}

function cleanPath(pathname) {
  return String(pathname || '').replace(/^\/+/, '');
}

/** Public URL for a given pathname (with a cache-buster appended). */
export function publicUrl(pathname, bust = true) {
  const u = blobBaseUrl() + cleanPath(pathname);
  return bust ? `${u}?ts=${Date.now()}` : u;
}

/** Write a JSON object to a deterministic pathname. Returns blob metadata. */
export async function putJSON(pathname, obj, { cacheSeconds = 0 } = {}) {
  const res = await fetch(`${API}/${cleanPath(pathname)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token()}`,
      'x-api-version': API_VERSION,
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-cache-control-max-age': String(cacheSeconds),
    },
    body: JSON.stringify(obj),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`blob put ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a JSON object by pathname. Returns undefined for 404.
 *
 * Newly-created blob paths take ~300ms to populate the read CDN, while
 * overwrites are instantly fresh. `retries` handles a read that races a
 * just-created object: it ONLY adds latency on a miss (an existing object
 * hits on the first try), so the hot path stays fast.
 */
export async function getJSON(pathname, { retries = 0, retryDelay = 250 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(publicUrl(pathname), { cache: 'no-store' });
    if (res.status === 404) {
      if (attempt < retries) { await sleep(retryDelay); continue; }
      return undefined;
    }
    if (!res.ok) {
      if (attempt < retries) { await sleep(retryDelay); continue; }
      throw new Error(`blob get ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

/** Cheap existence check by pathname. */
export async function existsBlob(pathname) {
  const res = await fetch(publicUrl(pathname), { method: 'GET', cache: 'no-store' });
  return res.ok;
}

/** Delete one or more pathnames. */
export async function delBlob(pathnames) {
  const list = Array.isArray(pathnames) ? pathnames : [pathnames];
  const urls = list.map((p) => publicUrl(p, false));
  const res = await fetch(`${API}/delete`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'x-api-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ urls }),
  });
  return res.ok;
}

/** List blobs under a prefix (admin/diagnostics). */
export async function listBlobs(prefix = '', limit = 1000) {
  const url = `${API}?prefix=${encodeURIComponent(prefix)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token()}`, 'x-api-version': API_VERSION },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`blob list ${res.status}`);
  return await res.json();
}

/** Connectivity probe for /api/health. */
export async function blobPing() {
  await listBlobs('__healthcheck__/', 1);
  return true;
}
