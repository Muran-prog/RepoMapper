/**
 * /api/access — IP-based access control management.
 */

export default async function handler(req, res) {
  const { dbGet, dbSet, accessKey, safeIP, registerUser } = await import('./lib/db.js');
  const { setCORS, handleOptions, getClientIP, parseBody, json, error } = await import('./lib/cors.js');

  if (handleOptions(req, res)) return;
  setCORS(req, res);

  const ip = getClientIP(req);
  await registerUser(ip);

  try {
    if (req.method === 'GET') {
      const config = (await dbGet(accessKey(ip))) || { sharedWith: [], createdAt: Date.now() };
      return json(res, 200, { ok: true, ip: safeIP(ip), access: config });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (!body.ip) return error(res, 400, 'Missing "ip" field');
      const safeTarget = safeIP(body.ip);
      if (safeTarget === safeIP(ip)) return error(res, 400, 'Cannot share with yourself');
      if (safeTarget === 'unknown') return error(res, 400, 'Invalid IP address');

      const config = (await dbGet(accessKey(ip))) || { sharedWith: [], createdAt: Date.now() };
      if (config.sharedWith.includes(safeTarget)) {
        return json(res, 200, { ok: true, message: 'IP already in shared list', access: config });
      }
      config.sharedWith.push(safeTarget);
      config.updatedAt = Date.now();
      const saved = await dbSet(accessKey(ip), config);

      // Bidirectional: also register on target side
      const targetConfig = (await dbGet(accessKey(safeTarget))) || { sharedWith: [], createdAt: Date.now() };
      if (!targetConfig.sharedWith.includes(safeIP(ip))) {
        targetConfig.sharedWith.push(safeIP(ip));
        targetConfig.updatedAt = Date.now();
        await dbSet(accessKey(safeTarget), targetConfig);
      }
      return json(res, saved ? 200 : 500, { ok: saved, access: config });
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      if (!body.ip) return error(res, 400, 'Missing "ip" field');
      const safeTarget = safeIP(body.ip);
      const config = (await dbGet(accessKey(ip))) || { sharedWith: [], createdAt: Date.now() };
      const idx = config.sharedWith.indexOf(safeTarget);
      if (idx === -1) return json(res, 200, { ok: true, message: 'IP not in shared list', access: config });

      config.sharedWith.splice(idx, 1);
      config.updatedAt = Date.now();
      const saved = await dbSet(accessKey(ip), config);

      // Remove reverse entry
      const targetConfig = (await dbGet(accessKey(safeTarget))) || { sharedWith: [] };
      const revIdx = targetConfig.sharedWith.indexOf(safeIP(ip));
      if (revIdx !== -1) {
        targetConfig.sharedWith.splice(revIdx, 1);
        targetConfig.updatedAt = Date.now();
        await dbSet(accessKey(safeTarget), targetConfig);
      }
      return json(res, saved ? 200 : 500, { ok: saved, access: config });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      if (!Array.isArray(body.ips)) return error(res, 400, 'Missing "ips" array');
      const safeIPs = body.ips.map(i => safeIP(i)).filter(i => i !== 'unknown' && i !== safeIP(ip));

      const oldConfig = (await dbGet(accessKey(ip))) || { sharedWith: [] };
      const oldSet = new Set(oldConfig.sharedWith || []);
      const newSet = new Set(safeIPs);

      // Remove reverse entries for removed IPs
      for (const old of oldSet) {
        if (!newSet.has(old)) {
          const tc = (await dbGet(accessKey(old))) || { sharedWith: [] };
          const ri = tc.sharedWith.indexOf(safeIP(ip));
          if (ri !== -1) { tc.sharedWith.splice(ri, 1); await dbSet(accessKey(old), tc); }
        }
      }
      // Add reverse entries for new IPs
      for (const n of newSet) {
        if (!oldSet.has(n)) {
          const tc = (await dbGet(accessKey(n))) || { sharedWith: [], createdAt: Date.now() };
          if (!tc.sharedWith.includes(safeIP(ip))) { tc.sharedWith.push(safeIP(ip)); tc.updatedAt = Date.now(); await dbSet(accessKey(n), tc); }
        }
      }

      const config = { sharedWith: safeIPs, createdAt: oldConfig.createdAt || Date.now(), updatedAt: Date.now() };
      const saved = await dbSet(accessKey(ip), config);
      return json(res, saved ? 200 : 500, { ok: saved, access: config });
    }

    return error(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[access] Error:', err);
    return error(res, 500, 'Internal server error', err.message);
  }
}
