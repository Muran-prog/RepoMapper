/**
 * GET /api/export — download ALL data for the logged-in account as JSON.
 */

export default async function handler(req, res) {
  const cors = await import('./lib/cors.js');
  const db = await import('./lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);
  if (req.method !== 'GET') return cors.error(res, 405, 'Method not allowed');

  try {
    const user = await db.authenticate(req);
    if (!user) return cors.error(res, 401, 'Не авторизован');

    const rec = await db.getUserData(user.userId);
    const exportData = {
      __repomapper_export: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      timestamp: Date.now(),
      account: { username: user.username, displayName: user.displayName },
      data: {
        features: rec.features || { version: 1, features: [] },
        prefs: rec.prefs || null,
        settings: rec.settings || null,
        contours: rec.contours || null,
      },
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="repomapper-${user.username}-${Date.now()}.json"`);
    return res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    console.error('[export]', err);
    return cors.error(res, 500, 'Export failed', err.message);
  }
}
