/**
 * POST /api/auth/login — authenticate with username + password.
 *
 * Body: { username, password }
 * Includes a per-account temporary lockout to throttle brute-force attempts.
 * Sets the session cookie on success.
 */

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000; // attempts counted within this window
const LOCK_MS = 15 * 60 * 1000; // lock duration once exceeded

export default async function handler(req, res) {
  const cors = await import('../../server/lib/cors.js');
  const auth = await import('../../server/lib/auth.js');
  const db = await import('../../server/lib/db.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  if (req.method !== 'POST') return cors.error(res, 405, 'Method not allowed');

  try {
    const body = cors.parseBody(req);
    const username = db.normUsername(body.username);
    const password = String(body.password == null ? '' : body.password);

    // Generic error for both "no such user" and "wrong password" so we
    // never reveal which usernames exist.
    const GENERIC = 'Неверное имя пользователя или пароль';

    if (!username || !password) {
      return cors.error(res, 400, 'Укажите имя пользователя и пароль');
    }

    const fails = await db.loginFailureCount(username, WINDOW_MS);
    if (fails >= MAX_ATTEMPTS) {
      return cors.error(res, 429, 'Слишком много попыток входа. Повторите попытку позже.');
    }

    const rec = await db.getCred(username);
    if (!rec) {
      // Constant-ish work to reduce username enumeration via timing.
      auth.hashPassword(password);
      await db.recordLoginFailure(username);
      return cors.error(res, 401, GENERIC);
    }

    const ok = auth.verifyPassword(password, rec.pw);
    if (!ok) {
      await db.recordLoginFailure(username);
      return cors.error(res, 401, GENERIC);
    }

    // Success — clear throttle, issue cookie.
    if (fails > 0) await db.clearLoginFailures(username);

    const token = auth.signSession({ uid: rec.userId, un: rec.username, tv: rec.tokenVersion });
    auth.setSessionCookie(res, token);

    return cors.json(res, 200, {
      ok: true,
      user: { username: rec.username, displayName: rec.displayName, createdAt: rec.createdAt },
    });
  } catch (err) {
    console.error('[auth/login]', err);
    return cors.error(res, 500, 'Не удалось выполнить вход', err.message);
  }
}
