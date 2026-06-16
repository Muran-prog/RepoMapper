/**
 * POST /api/auth/register — create a new account (username + password).
 *
 * Body: { username, password }
 * Sets the session cookie on success so the user is immediately logged in.
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
    const usernameErr = auth.validateUsername(body.username);
    if (usernameErr) return cors.error(res, 400, usernameErr);
    const passwordErr = auth.validatePassword(body.password);
    if (passwordErr) return cors.error(res, 400, passwordErr);

    const username = db.normUsername(body.username);

    // Uniqueness check (check-then-set; the race window is negligible for
    // this app and a duplicate would only ever overwrite at registration).
    if (await db.credExists(username)) {
      return cors.error(res, 409, 'Имя пользователя уже занято');
    }

    const pw = auth.hashPassword(String(body.password));
    const rec = await db.createCred({
      username,
      displayName: String(body.username).trim(),
      pw,
    });
    rec.lastLoginAt = Date.now();
    await db.saveCred(rec);

    // Materialise an empty data blob up-front so the account's data path
    // always exists — subsequent reads never hit a "new path" 404.
    await db.saveUserData(rec.userId, db.emptyData(rec.userId));

    const token = auth.signSession({ uid: rec.userId, un: rec.username, tv: rec.tokenVersion });
    auth.setSessionCookie(res, token);

    return cors.json(res, 201, {
      ok: true,
      user: { username: rec.username, displayName: rec.displayName, createdAt: rec.createdAt },
    });
  } catch (err) {
    console.error('[auth/register]', err);
    return cors.error(res, 500, 'Не удалось создать аккаунт', err.message);
  }
}
