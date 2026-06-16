/**
 * Data layer — account-based storage on Vercel Blob.
 *
 * There is no IP anywhere in this system. Every byte of user data is keyed
 * by a stable, random account id (`userId`) that is created once at
 * registration and never changes, so a user sees the exact same data on
 * every device and browser after logging in.
 *
 * Blob layout:
 *   auth/{HMAC(SESSION_SECRET,'authpath:'+username)}.json   — credential record
 *   u/{userId}/data.json                                    — all user data
 *
 * Credential record (schemaVersion 1):
 *   { schemaVersion, userId, username, displayName, pw{algo,N,r,p,keylen,salt,hash},
 *     tokenVersion, failedAttempts, firstFailedAt, lockedUntil,
 *     createdAt, updatedAt, lastLoginAt }
 *
 * Data record (schemaVersion 1):
 *   { schemaVersion, userId, features{version,features[]}, prefs, settings,
 *     contours, createdAt, updatedAt }
 */

import crypto from 'node:crypto';
import { getJSON, putJSON, existsBlob, delBlob, listBlobs } from './blob.js';
import { getSessionPayload } from './auth.js';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Identity & path derivation
// ---------------------------------------------------------------------------

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not configured');
  return s;
}

/** Normalise a username for case-insensitive uniqueness. */
export function normUsername(u) {
  return String(u == null ? '' : u).trim().toLowerCase();
}

/** Unguessable credential path derived from the (normalised) username. */
export function authPath(username) {
  const h = crypto
    .createHmac('sha256', secret())
    .update('authpath:' + normUsername(username))
    .digest('hex');
  return `auth/${h}.json`;
}

/** Path for a user's data blob. */
export function dataPath(userId) {
  return `u/${userId}/data.json`;
}

/** Fresh, unguessable 192-bit account id. */
export function newUserId() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars
}

// ---------------------------------------------------------------------------
// Credential records
// ---------------------------------------------------------------------------

export async function getCred(username) {
  // retry-on-miss covers the ~300ms propagation window right after a fresh
  // registration; for an existing account this hits on the first try.
  const rec = await getJSON(authPath(username), { retries: 4, retryDelay: 250 });
  return rec ? migrateCred(rec) : undefined;
}

export async function credExists(username) {
  return existsBlob(authPath(username));
}

export async function saveCred(rec) {
  rec.schemaVersion = SCHEMA_VERSION;
  rec.updatedAt = Date.now();
  await putJSON(authPath(rec.username), rec, { cacheSeconds: 0 });
  return rec;
}

/** First-write of a brand-new credential record. */
export async function createCred({ username, displayName, pw }) {
  const now = Date.now();
  const rec = {
    schemaVersion: SCHEMA_VERSION,
    userId: newUserId(),
    username: normUsername(username),
    displayName: String(displayName || username).trim().slice(0, 64),
    pw,
    tokenVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await putJSON(authPath(rec.username), rec, { cacheSeconds: 0 });
  return rec;
}

/** Forward-compatible credential migration. */
function migrateCred(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  let v = rec.schemaVersion || 0;
  // v0 -> v1: ensure required fields exist.
  if (v < 1) {
    rec.tokenVersion = rec.tokenVersion || 1;
    rec.displayName = rec.displayName || rec.username;
    rec.createdAt = rec.createdAt || Date.now();
    v = 1;
  }
  rec.schemaVersion = SCHEMA_VERSION;
  return rec;
}

// ---------------------------------------------------------------------------
// Brute-force throttling — strongly-consistent, RMW-free.
//
// Each failed login writes a unique marker blob; the count is read with the
// authenticated list API (strongly consistent), so the throttle is reliable
// despite the eventual consistency of public blob reads. A counter on a
// single key would be unreliable under rapid attempts.
// ---------------------------------------------------------------------------

function failPrefix(username) {
  const h = crypto.createHmac('sha256', secret()).update('faillog:' + normUsername(username)).digest('hex');
  return `fails/${h}/`;
}

export async function recordLoginFailure(username) {
  const now = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  try {
    await putJSON(`${failPrefix(username)}${now}-${rand}.json`, { at: now }, { cacheSeconds: 0 });
  } catch { /* throttling is best-effort; never block login on a write error */ }
}

/** Count recent failures within the window; opportunistically purge stale ones. */
export async function loginFailureCount(username, windowMs) {
  const prefix = failPrefix(username);
  let blobs;
  try {
    blobs = (await listBlobs(prefix, 1000)).blobs || [];
  } catch {
    return 0;
  }
  const now = Date.now();
  let count = 0;
  const stale = [];
  for (const b of blobs) {
    const m = /\/(\d+)-[0-9a-f]+\.json$/.exec(b.pathname);
    const ts = m ? Number(m[1]) : 0;
    if (ts && now - ts <= windowMs) count++;
    else stale.push(b.pathname);
  }
  if (stale.length) { try { await delBlob(stale); } catch {} }
  return count;
}

export async function clearLoginFailures(username) {
  try {
    const blobs = (await listBlobs(failPrefix(username), 1000)).blobs || [];
    const paths = blobs.map((b) => b.pathname);
    if (paths.length) await delBlob(paths);
  } catch {}
}

// ---------------------------------------------------------------------------
// User data records
// ---------------------------------------------------------------------------

export function emptyData(userId) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    userId,
    features: { version: 1, features: [] },
    prefs: null,
    settings: null,
    contours: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getUserData(userId) {
  // The data blob is created at registration, so for a real account it
  // always exists; retry-on-miss only fires during the brief post-create
  // propagation window and never penalises the hot path.
  const rec = await getJSON(dataPath(userId), { retries: 4, retryDelay: 250 });
  if (!rec) return emptyData(userId);
  return migrateData(rec, userId);
}

export async function saveUserData(userId, rec) {
  rec.schemaVersion = SCHEMA_VERSION;
  rec.userId = userId;
  rec.updatedAt = Date.now();
  await putJSON(dataPath(userId), rec, { cacheSeconds: 0 });
  return rec;
}

export async function deleteUserData(userId) {
  return delBlob(dataPath(userId));
}

/** Forward-compatible data migration. */
function migrateData(rec, userId) {
  if (!rec || typeof rec !== 'object') return emptyData(userId);
  let v = rec.schemaVersion || 0;
  if (v < 1) {
    rec.features = rec.features && Array.isArray(rec.features.features)
      ? rec.features
      : { version: 1, features: [] };
    rec.prefs = rec.prefs ?? null;
    rec.settings = rec.settings ?? null;
    rec.contours = rec.contours ?? null;
    rec.createdAt = rec.createdAt || Date.now();
    v = 1;
  }
  rec.schemaVersion = SCHEMA_VERSION;
  rec.userId = userId;
  if (!rec.features || !Array.isArray(rec.features.features)) {
    rec.features = { version: 1, features: [] };
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Sanitisers — defensive validation of untrusted client payloads
// ---------------------------------------------------------------------------

export function sanitiseFeatures(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.features) ? raw.features : [];
  return arr.filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (f.type !== 'Feature') return false;
    if (!f.geometry || typeof f.geometry !== 'object') return false;
    if (typeof f.geometry.type !== 'string') return false;
    return true;
  });
}

export function sanitisePrefs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const defaults = {
    tool: 'select', connectionMode: 'sequence', shapeType: 'circle',
    shapeSides: 6, shapeSize: 100, eraserSize: 30, color: '#c66809',
    fill: '#c66809', weight: 3, opacity: 0.95, geodesic: true,
    labels: true, snap: true, measure: false,
  };
  const result = {};
  for (const [k, def] of Object.entries(defaults)) {
    result[k] = typeof raw[k] === typeof def ? raw[k] : def;
  }
  const validModes = ['none', 'sequence', 'mesh', 'hub', 'optimal'];
  if (!validModes.includes(result.connectionMode)) result.connectionMode = 'none';
  const validShapes = ['circle', 'rectangle', 'regular', 'arrow', 'star'];
  if (!validShapes.includes(result.shapeType)) result.shapeType = 'circle';
  result.opacity = Math.max(0, Math.min(1, Number(result.opacity) || 0.95));
  result.weight = Math.max(1, Math.min(20, Number(result.weight) || 3));
  result.shapeSides = Math.max(3, Math.min(64, Number(result.shapeSides) || 6));
  result.shapeSize = Math.max(1, Math.min(5000, Number(result.shapeSize) || 100));
  result.eraserSize = Math.max(1, Math.min(5000, Number(result.eraserSize) || 30));
  return result;
}

/** Settings / contours are opaque JSON blobs; we only cap their size. */
const MAX_JSON_BYTES = 4 * 1024 * 1024; // 4 MB per field — generous

export function sanitiseJsonObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const s = JSON.stringify(raw);
    if (s.length > MAX_JSON_BYTES) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Feature merge — union by stable id, used by PUT / import(merge)
// ---------------------------------------------------------------------------

export function mergeFeatures(existing, incoming) {
  const map = new Map();
  for (const f of existing || []) map.set(f.id || JSON.stringify(f.geometry), f);
  for (const f of incoming || []) map.set(f.id || JSON.stringify(f.geometry), f);
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated user for a request.
 * Verifies the cookie signature/expiry AND that the embedded tokenVersion
 * still matches the stored credential (so password change / logout-all
 * invalidates the session everywhere).
 *
 * @returns {Promise<{userId,username,displayName,rec}|null>}
 */
export async function authenticate(req) {
  const payload = getSessionPayload(req);
  if (!payload) return null;
  const rec = await getCred(payload.un);
  if (!rec) return null;
  if (rec.userId !== payload.uid) return null;
  if ((rec.tokenVersion || 1) !== (payload.tv || 1)) return null;
  return { userId: rec.userId, username: rec.username, displayName: rec.displayName, rec };
}
