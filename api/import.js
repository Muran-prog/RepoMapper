/**
 * POST /api/import — restore a previously exported data blob into the
 * logged-in account.
 *
 * Body: an export object plus { mode: 'replace' | 'merge' }.
 */

export default async function handler(req, res) {
  const cors = await import('../server/lib/cors.js');
  const db = await import('../server/lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);
  if (req.method !== 'POST') return cors.error(res, 405, 'Method not allowed');

  try {
    const user = await db.authenticate(req);
    if (!user) return cors.error(res, 401, 'Не авторизован');

    const body = cors.parseBody(req);
    if (!body.__repomapper_export) return cors.error(res, 400, 'Неверный формат файла');
    if (body.version !== 1) return cors.error(res, 400, `Неподдерживаемая версия: ${body.version}`);

    const data = body.data;
    if (!data || typeof data !== 'object') return cors.error(res, 400, 'Отсутствует объект data');

    const mode = body.mode === 'merge' ? 'merge' : 'replace';
    const rec = await db.getUserData(user.userId);
    const imported = [];

    if (data.features !== undefined) {
      const incoming = db.sanitiseFeatures(data.features);
      rec.features = {
        version: 1,
        features: mode === 'merge'
          ? db.mergeFeatures(rec.features?.features || [], incoming)
          : incoming,
      };
      imported.push('features');
    }
    if (data.prefs) {
      const prefs = db.sanitisePrefs(mode === 'merge' ? { ...(rec.prefs || {}), ...data.prefs } : data.prefs);
      if (prefs) { rec.prefs = prefs; imported.push('prefs'); }
    }
    if (data.settings) {
      const s = db.sanitiseJsonObject(mode === 'merge' ? { ...(rec.settings || {}), ...data.settings } : data.settings);
      if (s) { rec.settings = s; imported.push('settings'); }
    }
    if (data.contours) {
      const c = db.sanitiseJsonObject(mode === 'merge' ? { ...(rec.contours || {}), ...data.contours } : data.contours);
      if (c) { rec.contours = c; imported.push('contours'); }
    }

    await db.saveUserData(user.userId, rec);
    return cors.json(res, 200, { ok: true, mode, imported, timestamp: Date.now() });
  } catch (err) {
    console.error('[import]', err);
    return cors.error(res, 500, 'Import failed', err.message);
  }
}
