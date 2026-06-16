/**
 * Database layer — Edge Config key-value store.
 *
 * IMPORTANT: Environment variables are read lazily (inside each call)
 * to avoid timing issues with Vercel's serverless module evaluation.
 *
 * Data layout in Edge Config:
 *   user_{ip}_features    — GeoJSON FeatureCollection
 *   user_{ip}_prefs       — draw preferences
 *   user_{ip}_settings    — UI settings
 *   user_{ip}_contours    — settlement contour data
 *   access_{ip}           — { sharedWith: [ip1, ip2, ...], createdAt }
 *   meta_users            — list of all known user IPs
 */

// In-memory cache (lives as long as the Lambda is warm)
const memCache = new Map();

/** Return config lazily — avoids module-eval timing issues. */
function getConfig() {
  return {
    id:    process.env.EDGE_CONFIG_ID,
    token: process.env.VERCEL_API_TOKEN,
    get base() {
      return `https://api.vercel.com/v1/edge-config/${this.id}`;
    },
  };
}

/** Sanitise an IP string into a safe key segment. */
export function safeIP(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  return ip.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);
}

async function edgeGet(key) {
  const cfg = getConfig();
  try {
    const res = await fetch(`${cfg.base}/item/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (res.status === 404 || res.status === 204) return undefined;
    if (!res.ok) return undefined;
    const body = await res.json();
    if (body && typeof body === 'object' && 'value' in body && 'edgeConfigId' in body) {
      return body.value;
    }
    return body;
  } catch (err) {
    console.error(`[db] edgeGet(${key}):`, err.message);
    return undefined;
  }
}

async function edgeSet(key, value) {
  const cfg = getConfig();
  try {
    const res = await fetch(`${cfg.base}/items`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ operation: 'upsert', key, value }],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[db] edgeSet(${key}) ${res.status}: ${text}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`[db] edgeSet(${key}):`, err.message);
    return false;
  }
}

async function edgeDelete(key) {
  const cfg = getConfig();
  try {
    const res = await fetch(`${cfg.base}/items`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ operation: 'delete', key }],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[db] edgeDelete(${key}):`, err.message);
    return false;
  }
}

async function edgeGetAll() {
  const cfg = getConfig();
  try {
    const res = await fetch(`${cfg.base}/items`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return {};
    const body = await res.json();
    if (Array.isArray(body)) {
      const result = {};
      for (const item of body) {
        if (item && item.key) result[item.key] = item.value;
      }
      return result;
    }
    return body || {};
  } catch (err) {
    console.error('[db] edgeGetAll:', err.message);
    return {};
  }
}

export async function dbGet(key) {
  const val = await edgeGet(key);
  if (val !== undefined) {
    memCache.set(key, val);
    return val;
  }
  return memCache.get(key);
}

export async function dbSet(key, value) {
  memCache.set(key, value);
  return await edgeSet(key, value);
}

export async function dbDelete(key) {
  memCache.delete(key);
  return await edgeDelete(key);
}

export async function dbGetByPrefix(prefix) {
  const all = await edgeGetAll();
  const results = {};
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      results[key] = val;
    }
  }
  return results;
}

export function userKey(ip, suffix) {
  return `user_${safeIP(ip)}_${suffix}`;
}

export function accessKey(ip) {
  return `access_${safeIP(ip)}`;
}

export async function getUsers() {
  return (await dbGet('meta_users')) || [];
}

export async function registerUser(ip) {
  const users = await getUsers();
  const safe = safeIP(ip);
  if (!users.includes(safe)) {
    users.push(safe);
    await dbSet('meta_users', users);
  }
}

export function sanitiseFeatures(raw) {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.filter((f) => {
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
  return result;
}
