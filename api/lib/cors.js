/**
 * CORS + request helpers for Vercel serverless functions.
 */

const ALLOWED_ORIGINS = [
  'https://muran-prog.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
];

export function setCORS(req, res) {
  const origin = req.headers.origin || req.headers.referer || '';
  const isAllowed =
    ALLOWED_ORIGINS.some((o) => origin.startsWith(o)) ||
    origin.includes('.vercel.app');
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-IP, X-Forwarded-For');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

export function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setCORS(req, res);
    res.status(204).end();
    return true;
  }
  return false;
}

export function getClientIP(req) {
  return (
    req.headers['x-client-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function parseBody(req) {
  try {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body || {};
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
