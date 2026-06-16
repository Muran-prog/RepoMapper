/**
 * HTTP helpers for the serverless API: CORS, body parsing, JSON responses.
 *
 * The app is served same-origin with the API on the Vercel deployment, so
 * CORS is mostly a safety net. When it does apply (local dev, the legacy
 * GitHub Pages mirror) we reflect a known origin and allow credentials so
 * the session cookie can flow.
 */

const ALLOWED_ORIGINS = [
  'https://muran-prog.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
];

export function setCORS(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed =
    ALLOWED_ORIGINS.some((o) => origin === o) || /\.vercel\.app$/.test(safeHost(origin));
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function safeHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

export function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setCORS(req, res);
    res.status(204).end();
    return true;
  }
  return false;
}

export function parseBody(req) {
  try {
    if (req.body == null) return {};
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body;
  } catch {
    return {};
  }
}

export function json(res, status, data) {
  res.status(status).json(data);
}

export function error(res, status, message, details = null) {
  const body = { ok: false, error: message };
  if (details) body.details = details;
  res.status(status).json(body);
}
