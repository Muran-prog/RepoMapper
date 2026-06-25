/**
 * POST /api/auth/password — change the current user's password.
 *
 * Body: { currentPassword, newPassword }
 * Bumps tokenVersion (invalidating all other sessions) and re-issues a
 * fresh cookie for the current device.
 */

export default async function handler(req, res) {
  const cors = await import('../../server/lib/cors.js');
  const auth = await import('../../server/lib/auth.js');
  const db = await import('../../server/lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  if (req.method !== 'POST') return cors.error(res, 405, 'Method not allowed');

  try {
    const user = await db.authenticate(req);
    if (!user) return cors.error(res, 401, 'Не авторизован');

    const body = cors.parseBody(req);
    const newErr = auth.validatePassword(body.newPassword);
    if (newErr) return cors.error(res, 400, newErr);

    if (!auth.verifyPassword(String(body.currentPassword == null ? '' : body.currentPassword), user.rec.pw)) {
      return cors.error(res, 403, 'Текущий пароль неверен');
    }

    user.rec.pw = auth.hashPassword(String(body.newPassword));
    user.rec.tokenVersion = (user.rec.tokenVersion || 1) + 1;
    await db.saveCred(user.rec);

    // Re-issue a cookie for this device with the new tokenVersion.
    const token = auth.signSession({
      uid: user.rec.userId, un: user.rec.username, tv: user.rec.tokenVersion,
    });
    auth.setSessionCookie(res, token);

    return cors.json(res, 200, { ok: true });
  } catch (err) {
    console.error('[auth/password]', err);
    return cors.error(res, 500, 'Не удалось изменить пароль', err.message);
  }
}
