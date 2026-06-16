/**
 * Authentication primitives — password hashing, signed sessions, cookies.
 *
 * No third-party dependencies: everything is built on Node's `crypto`.
 *
 *  • Passwords  — scrypt (memory-hard) with a per-user random salt, stored
 *                 alongside its parameters so the cost can be tuned later
 *                 without breaking existing hashes. Comparison is
 *                 constant-time.
 *  • Sessions   — stateless HMAC-signed tokens (base64url payload + sig)
 *                 stored in an HttpOnly, Secure, SameSite=Lax cookie.
 *                 A per-user `tokenVersion` is embedded so changing a
 *                 password (or "log out everywhere") instantly invalidates
 *                 every previously issued cookie — revocation without a
 *                 session store.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not configured');
  return s;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** Hash a plaintext password. Returns a self-describing record. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return {
    algo: 'scrypt',
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
  };
}

/** Constant-time verify a plaintext password against a stored record. */
export function verifyPassword(password, rec) {
  try {
    if (!rec || rec.algo !== 'scrypt') return false;
    const salt = Buffer.from(rec.salt, 'hex');
    const expected = Buffer.from(rec.hash, 'hex');
    const keylen = rec.keylen || expected.length || 64;
    const got = crypto.scryptSync(password, salt, keylen, {
      N: rec.N || 16384, r: rec.r || 8, p: rec.p || 1, maxmem: SCRYPT.maxmem,
    });
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const COOKIE_NAME = 'rm_session';

function b64urlJSON(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Build a signed session token for a user. */
export function signSession({ uid, un, tv }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid, un, tv: tv || 1, iat: now, exp: now + SESSION_TTL_SECONDS };
  const p = b64urlJSON(payload);
  const sig = crypto.createHmac('sha256', sessionSecret()).update(`session:${p}`).digest('base64url');
  return `${p}.${sig}`;
}

/** Verify & decode a session token. Returns payload or null. */
export function verifySession(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const dot = tokenStr.lastIndexOf('.');
  if (dot <= 0) return null;
  const p = tokenStr.slice(0, dot);
  const sig = tokenStr.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(`session:${p}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.uid || !payload.un) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
}

export function setSessionCookie(res, tokenStr) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(tokenStr)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  appendSetCookie(res, attrs.join('; '));
}

export function clearSessionCookie(res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  appendSetCookie(res, attrs.join('; '));
}

/** Decode the session payload from a request (signature + expiry checked). */
export function getSessionPayload(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateUsername(u) {
  const s = String(u == null ? '' : u).trim();
  if (s.length < 3) return 'Имя пользователя должно содержать минимум 3 символа';
  if (s.length > 32) return 'Имя пользователя не должно превышать 32 символа';
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    return 'Допустимы только буквы, цифры и символы . _ -';
  }
  return null;
}

export function validatePassword(p) {
  const s = String(p == null ? '' : p);
  if (s.length < 8) return 'Пароль должен содержать минимум 8 символов';
  if (s.length > 200) return 'Пароль слишком длинный (максимум 200 символов)';
  return null;
}
