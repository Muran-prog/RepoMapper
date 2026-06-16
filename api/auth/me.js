/**
 * GET /api/auth/me — return the currently authenticated user, or 401.
 */

export default async function handler(req, res) {
  const cors = await import('../lib/cors.js');
  const db = await import('../lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  if (req.method !== 'GET') return cors.error(res, 405, 'Method not allowed');

  try {
    const user = await db.authenticate(req);
    if (!user) return cors.error(res, 401, 'Не авторизован');
    return cors.json(res, 200, {
      ok: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        createdAt: user.rec.createdAt,
        lastLoginAt: user.rec.lastLoginAt,
      },
    });
  } catch (err) {
    console.error('[auth/me]', err);
    return cors.error(res, 500, 'Internal server error', err.message);
  }
}
