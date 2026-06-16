/**
 * /api/sync — per-account data synchronisation. Requires a valid session.
 *
 *   GET  — load all data for the logged-in account
 *   POST — save a full snapshot (replace the provided fields)
 *   PUT  — partial/merge update (union features by id, shallow-merge the rest)
 *
 * The data is keyed strictly by the account id, so the same user sees the
 * same data on every device after logging in.
 */

export default async function handler(req, res) {
  const cors = await import('./lib/cors.js');
  const db = await import('./lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  try {
    const user = await db.authenticate(req);
    if (!user) return cors.error(res, 401, 'Не авторизован');

    if (req.method === 'GET') return await handleGet(user, res, db, cors);
    if (req.method === 'POST') return await handlePost(user, req, res, db, cors);
    if (req.method === 'PUT') return await handlePut(user, req, res, db, cors);
    return cors.error(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[sync]', err);
    return cors.error(res, 500, 'Internal server error', err.message);
  }
}

async function handleGet(user, res, db, cors) {
  const rec = await db.getUserData(user.userId);
  return cors.json(res, 200, {
    ok: true,
    user: { username: user.username, displayName: user.displayName },
    data: {
      features: rec.features || { version: 1, features: [] },
      prefs: rec.prefs || null,
      settings: rec.settings || null,
      contours: rec.contours || null,
    },
    updatedAt: rec.updatedAt,
    timestamp: Date.now(),
  });
}

async function handlePost(user, req, res, db, cors) {
  const body = cors.parseBody(req);
  const rec = await db.getUserData(user.userId);
  const results = {};

  if (body.features !== undefined) {
    rec.features = { version: 1, features: db.sanitiseFeatures(body.features) };
    results.features = true;
  }
  if (body.prefs !== undefined) {
    const prefs = db.sanitisePrefs(body.prefs);
    if (prefs) { rec.prefs = prefs; results.prefs = true; }
  }
  if (body.settings !== undefined) {
    const s = db.sanitiseJsonObject(body.settings);
    if (s) { rec.settings = s; results.settings = true; }
  }
  if (body.contours !== undefined) {
    const c = db.sanitiseJsonObject(body.contours);
    if (c) { rec.contours = c; results.contours = true; }
  }

  await db.saveUserData(user.userId, rec);
  return cors.json(res, 200, { ok: true, results, timestamp: Date.now() });
}

async function handlePut(user, req, res, db, cors) {
  const body = cors.parseBody(req);
  const rec = await db.getUserData(user.userId);
  const results = {};

  if (body.features !== undefined) {
    const incoming = db.sanitiseFeatures(body.features);
    rec.features = {
      version: 1,
      features: db.mergeFeatures(rec.features?.features || [], incoming),
    };
    results.features = true;
  }
  if (body.prefs !== undefined) {
    const prefs = db.sanitisePrefs({ ...(rec.prefs || {}), ...body.prefs });
    if (prefs) { rec.prefs = prefs; results.prefs = true; }
  }
  if (body.settings !== undefined) {
    const s = db.sanitiseJsonObject({ ...(rec.settings || {}), ...body.settings });
    if (s) { rec.settings = s; results.settings = true; }
  }
  if (body.contours !== undefined) {
    const c = db.sanitiseJsonObject({ ...(rec.contours || {}), ...body.contours });
    if (c) { rec.contours = c; results.contours = true; }
  }

  await db.saveUserData(user.userId, rec);
  return cors.json(res, 200, { ok: true, results, timestamp: Date.now() });
}
