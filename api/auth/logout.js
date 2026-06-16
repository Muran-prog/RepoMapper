/**
 * POST /api/auth/logout — clear the session cookie.
 *
 * Body (optional): { everywhere: true } — bumps the account's tokenVersion
 * so every previously issued session cookie (on every device) is instantly
 * invalidated.
 */

export default async function handler(req, res) {
  const cors = await import('../lib/cors.js');
  const auth = await import('../lib/auth.js');
  const db = await import('../lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  if (req.method !== 'POST') return cors.error(res, 405, 'Method not allowed');

  try {
    const body = cors.parseBody(req);
    if (body.everywhere) {
      const user = await db.authenticate(req);
      if (user) {
        user.rec.tokenVersion = (user.rec.tokenVersion || 1) + 1;
        await db.saveCred(user.rec);
      }
    }
    auth.clearSessionCookie(res);
    return cors.json(res, 200, { ok: true });
  } catch (err) {
    console.error('[auth/logout]', err);
    // Even on error, clear the cookie so the client ends up logged out.
    try {
      const auth = await import('../lib/auth.js');
      auth.clearSessionCookie(res);
    } catch {}
    return cors.json(res, 200, { ok: true });
  }
}
