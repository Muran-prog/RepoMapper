/**
 * GET /api/health — liveness + storage connectivity probe. No auth, no IP.
 */

export default async function handler(req, res) {
  const cors = await import('../server/lib/cors.js');
  const blob = await import('../server/lib/blob.js');

  if (cors.handleOptions(req, res)) return;
  cors.setCORS(req, res);

  const start = Date.now();
  let storage = 'unknown';
  try {
    await blob.blobPing();
    storage = 'connected';
  } catch (err) {
    console.error('[health] storage error:', err.message);
    storage = 'error';
  }

  return cors.json(res, 200, {
    ok: storage === 'connected',
    status: storage === 'connected' ? 'healthy' : 'degraded',
    storage,
    latency: Date.now() - start,
    timestamp: Date.now(),
    version: '2.0.0',
  });
}
