/**
 * /api/export — Export ALL user data as a single JSON file.
 */

export default async function handler(req, res) {
  const { dbGet, userKey, accessKey, safeIP, registerUser } = await import('./lib/db.js');
  const { setCORS, handleOptions, getClientIP, json, error } = await import('./lib/cors.js');

  if (handleOptions(req, res)) return;
  setCORS(req, res);
  if (req.method !== 'GET') return error(res, 405, 'Method not allowed');

  const ip = getClientIP(req);
  await registerUser(ip);

  try {
    const [features, prefs, settings, contours, access] = await Promise.all([
      dbGet(userKey(ip, 'features')),
      dbGet(userKey(ip, 'prefs')),
      dbGet(userKey(ip, 'settings')),
      dbGet(userKey(ip, 'contours')),
      dbGet(accessKey(ip)),
    ]);

    const exportData = {
      __repomapper_export: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      timestamp: Date.now(),
      ip: safeIP(ip),
      data: {
        features: features || { version: 1, features: [] },
        prefs: prefs || null,
        settings: settings || null,
        contours: contours || null,
      },
      access: access || { sharedWith: [] },
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="repomapper-export-${Date.now()}.json"`);
    return res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    console.error('[export] Error:', err);
    return error(res, 500, 'Export failed', err.message);
  }
}
