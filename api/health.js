/**
 * /api/health — Health check endpoint.
 */

export default async function handler(req, res) {
  const { dbGet } = await import('./lib/db.js');
  const { setCORS, handleOptions, getClientIP, json } = await import('./lib/cors.js');

  if (handleOptions(req, res)) return;
  setCORS(req, res);

  const ip = getClientIP(req);
  const start = Date.now();

  let dbStatus = 'unknown';
  try { await dbGet('meta_users'); dbStatus = 'connected'; } catch { dbStatus = 'error'; }

  return json(res, 200, {
    ok: true, status: 'healthy', ip, db: dbStatus,
    latency: Date.now() - start, timestamp: Date.now(), version: '1.0.0',
  });
}
