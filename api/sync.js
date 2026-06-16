/**
 * /api/sync — Main synchronisation endpoint.
 *
 * GET  /api/sync  — Load all data for the current IP
 * POST /api/sync  — Save all data (full replace)
 * PUT  /api/sync  — Partial update (merge)
 */

export default async function handler(req, res) {
  const db   = await import('./lib/db.js');
  const cors = await import('./lib/cors.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  const ip = cors.getClientIP(req);

  try {
    if (req.method === 'GET')  return await handleGet(ip, res, db, cors);
    if (req.method === 'POST') return await handlePost(ip, req, res, db, cors);
    if (req.method === 'PUT')  return await handlePut(ip, req, res, db, cors);
    return cors.error(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[sync]', err);
    return cors.error(res, 500, 'Internal server error', err.message);
  }
}

async function handleGet(ip, res, db, cors) {
  await db.registerUser(ip);
  const [features, prefs, settings, contours, acc] = await Promise.all([
    db.dbGet(db.userKey(ip, 'features')),
    db.dbGet(db.userKey(ip, 'prefs')),
    db.dbGet(db.userKey(ip, 'settings')),
    db.dbGet(db.userKey(ip, 'contours')),
    db.dbGet(db.accessKey(ip)),
  ]);

  let shared = [];
  if (acc?.sharedWith?.length) {
    const ps = acc.sharedWith.map(async sip => {
      const sa = await db.dbGet(db.accessKey(sip));
      if (sa?.sharedWith?.includes(db.safeIP(ip))) {
        const sf = await db.dbGet(db.userKey(sip, 'features'));
        return (sf?.features || []).map(f => ({
          ...f, properties: { ...(f.properties || {}), __sharedFrom: sip },
        }));
      }
      return [];
    });
    shared = (await Promise.all(ps)).flat();
  }

  return cors.json(res, 200, {
    ok: true, ip: db.safeIP(ip),
    data: {
      features: features || { version: 1, features: [] },
      prefs: prefs || null,
      settings: settings || null,
      contours: contours || null,
    },
    shared, access: acc || { sharedWith: [] }, timestamp: Date.now(),
  });
}

async function handlePost(ip, req, res, db, cors) {
  await db.registerUser(ip);
  const body = cors.parseBody(req);
  const results = {};

  if (body.features !== undefined) {
    const features = db.sanitiseFeatures(body.features?.features || body.features || []);
    results.features = await db.dbSet(db.userKey(ip, 'features'), {
      version: 1, features, updatedAt: Date.now(), ip: db.safeIP(ip),
    });
  }
  if (body.prefs !== undefined) {
    const prefs = db.sanitisePrefs(body.prefs);
    if (prefs) results.prefs = await db.dbSet(db.userKey(ip, 'prefs'), { ...prefs, updatedAt: Date.now() });
  }
  if (body.settings && typeof body.settings === 'object') {
    results.settings = await db.dbSet(db.userKey(ip, 'settings'), { ...body.settings, updatedAt: Date.now() });
  }
  if (body.contours && typeof body.contours === 'object') {
    results.contours = await db.dbSet(db.userKey(ip, 'contours'), { ...body.contours, updatedAt: Date.now() });
  }

  const allOk = Object.values(results).every(Boolean);
  return cors.json(res, allOk ? 200 : 207, { ok: allOk, results, timestamp: Date.now() });
}

async function handlePut(ip, req, res, db, cors) {
  await db.registerUser(ip);
  const body = cors.parseBody(req);
  const results = {};

  if (body.features !== undefined) {
    const existing = (await db.dbGet(db.userKey(ip, 'features'))) || { version: 1, features: [] };
    const incoming = db.sanitiseFeatures(body.features?.features || body.features || []);
    const merged = new Map();
    for (const f of existing.features || []) merged.set(f.id || JSON.stringify(f.geometry), f);
    for (const f of incoming) merged.set(f.id || JSON.stringify(f.geometry), f);
    results.features = await db.dbSet(db.userKey(ip, 'features'), {
      version: 1, features: [...merged.values()], updatedAt: Date.now(), ip: db.safeIP(ip),
    });
  }
  if (body.prefs !== undefined) {
    const ex = (await db.dbGet(db.userKey(ip, 'prefs'))) || {};
    const s = db.sanitisePrefs({ ...ex, ...body.prefs });
    if (s) results.prefs = await db.dbSet(db.userKey(ip, 'prefs'), { ...s, updatedAt: Date.now() });
  }
  if (body.settings !== undefined) {
    const ex = (await db.dbGet(db.userKey(ip, 'settings'))) || {};
    results.settings = await db.dbSet(db.userKey(ip, 'settings'), { ...ex, ...body.settings, updatedAt: Date.now() });
  }
  if (body.contours !== undefined) {
    const ex = (await db.dbGet(db.userKey(ip, 'contours'))) || {};
    results.contours = await db.dbSet(db.userKey(ip, 'contours'), { ...ex, ...body.contours, updatedAt: Date.now() });
  }

  const allOk = Object.values(results).every(Boolean);
  return cors.json(res, allOk ? 200 : 207, { ok: allOk, results, timestamp: Date.now() });
}
