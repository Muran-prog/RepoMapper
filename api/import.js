/**
 * /api/import — Import a previously exported data blob.
 */

export default async function handler(req, res) {
  const { dbGet, dbSet, userKey, accessKey, safeIP, registerUser, sanitiseFeatures, sanitisePrefs } = await import('./lib/db.js');
  const { setCORS, handleOptions, getClientIP, parseBody, json, error } = await import('./lib/cors.js');

  if (handleOptions(req, res)) return;
  setCORS(req, res);
  if (req.method !== 'POST') return error(res, 405, 'Method not allowed');

  const ip = getClientIP(req);
  await registerUser(ip);

  try {
    const body = parseBody(req);
    if (!body.__repomapper_export) return error(res, 400, 'Invalid import format');
    if (body.version !== 1) return error(res, 400, `Unsupported version: ${body.version}`);

    const mode = body.mode || 'replace';
    const data = body.data;
    if (!data || typeof data !== 'object') return error(res, 400, 'Missing data object');

    const results = {};

    if (data.features) {
      const features = sanitiseFeatures(data.features?.features || data.features || []);
      if (mode === 'merge') {
        const existing = (await dbGet(userKey(ip, 'features'))) || { version: 1, features: [] };
        const merged = new Map();
        for (const f of existing.features || []) merged.set(f.id || JSON.stringify(f.geometry), f);
        for (const f of features) merged.set(f.id || JSON.stringify(f.geometry), f);
        results.features = await dbSet(userKey(ip, 'features'), { version: 1, features: [...merged.values()], updatedAt: Date.now(), importedAt: Date.now() });
      } else {
        results.features = await dbSet(userKey(ip, 'features'), { version: 1, features, updatedAt: Date.now(), importedAt: Date.now() });
      }
    }

    if (data.prefs) {
      const prefs = sanitisePrefs(data.prefs);
      if (prefs) {
        if (mode === 'merge') {
          const existing = (await dbGet(userKey(ip, 'prefs'))) || {};
          results.prefs = await dbSet(userKey(ip, 'prefs'), { ...existing, ...prefs, updatedAt: Date.now() });
        } else {
          results.prefs = await dbSet(userKey(ip, 'prefs'), { ...prefs, updatedAt: Date.now() });
        }
      }
    }

    if (data.settings && typeof data.settings === 'object') {
      if (mode === 'merge') {
        const existing = (await dbGet(userKey(ip, 'settings'))) || {};
        results.settings = await dbSet(userKey(ip, 'settings'), { ...existing, ...data.settings, updatedAt: Date.now() });
      } else {
        results.settings = await dbSet(userKey(ip, 'settings'), { ...data.settings, updatedAt: Date.now() });
      }
    }

    if (data.contours && typeof data.contours === 'object') {
      if (mode === 'merge') {
        const existing = (await dbGet(userKey(ip, 'contours'))) || {};
        results.contours = await dbSet(userKey(ip, 'contours'), { ...existing, ...data.contours, updatedAt: Date.now() });
      } else {
        results.contours = await dbSet(userKey(ip, 'contours'), { ...data.contours, updatedAt: Date.now() });
      }
    }

    if (body.importAccess && body.access) {
      const accessData = {
        sharedWith: Array.isArray(body.access.sharedWith) ? body.access.sharedWith.map(safeIP).filter(i => i !== 'unknown') : [],
        createdAt: body.access.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      results.access = await dbSet(accessKey(ip), accessData);
    }

    const allOk = Object.values(results).every(Boolean);
    return json(res, allOk ? 200 : 207, { ok: allOk, mode, imported: Object.keys(results), results, timestamp: Date.now() });
  } catch (err) {
    console.error('[import] Error:', err);
    return error(res, 500, 'Import failed', err.message);
  }
}
