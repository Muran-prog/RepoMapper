/**
 * Unit tests for the auth + db pure logic. No network.
 * Run: SESSION_SECRET=test node tools/test-unit.mjs
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-secret-0123456789abcdef';

import * as auth from '../api/lib/auth.js';
import * as db from '../api/lib/db.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------- password hashing ----------
section('password hashing (scrypt)');
const pw = auth.hashPassword('correct horse battery staple');
ok(pw.algo === 'scrypt' && pw.salt && pw.hash, 'produces a self-describing record');
ok(auth.verifyPassword('correct horse battery staple', pw) === true, 'verifies the right password');
ok(auth.verifyPassword('wrong', pw) === false, 'rejects a wrong password');
const pw2 = auth.hashPassword('correct horse battery staple');
ok(pw.hash !== pw2.hash, 'same password -> different hash (unique salt)');
ok(auth.verifyPassword('x', { algo: 'bogus' }) === false, 'rejects an unknown algo');

// ---------- session tokens ----------
section('session tokens (HMAC)');
const tok = auth.signSession({ uid: 'u1', un: 'alice', tv: 3 });
const dec = auth.verifySession(tok);
ok(dec && dec.uid === 'u1' && dec.un === 'alice' && dec.tv === 3, 'round-trips payload');
ok(auth.verifySession(tok + 'x') === null, 'rejects a tampered signature');
const [p] = tok.split('.');
ok(auth.verifySession(p + '.deadbeef') === null, 'rejects a forged signature');
// expired token
const expired = (() => {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ uid: 'u', un: 'a', tv: 1, iat: now - 100, exp: now - 10 })).toString('base64url');
  // sign with the real secret via re-implementation is hard; instead craft via signSession then mutate -> just test null for garbage
  return 'garbage.token';
})();
ok(auth.verifySession(expired) === null, 'rejects garbage token');
ok(auth.verifySession('') === null && auth.verifySession(null) === null, 'rejects empty/null');

// expiry path: hand-build a valid signature over an expired payload
import crypto from 'node:crypto';
{
  const now = Math.floor(Date.now() / 1000);
  const payloadObj = { uid: 'u', un: 'a', tv: 1, iat: now - 100, exp: now - 10 };
  const pb = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update('session:' + pb).digest('base64url');
  ok(auth.verifySession(`${pb}.${sig}`) === null, 'rejects an expired but correctly-signed token');
}

// ---------- cookies ----------
section('cookies');
const fakeRes = (() => {
  const headers = {};
  return {
    headers,
    getHeader: (k) => headers[k],
    setHeader: (k, v) => { headers[k] = v; },
  };
})();
auth.setSessionCookie(fakeRes, 'tok123');
const sc = fakeRes.getHeader('Set-Cookie');
ok(/HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc), 'session cookie has HttpOnly+Secure+SameSite+Path');
ok(/rm_session=tok123/.test(sc), 'cookie carries the token');
const req = { headers: { cookie: 'rm_session=hello%20world; other=1' } };
const cookies = auth.parseCookies(req);
ok(cookies.rm_session === 'hello world' && cookies.other === '1', 'parses + url-decodes cookies');
auth.clearSessionCookie(fakeRes);
ok(/Max-Age=0/.test(fakeRes.getHeader('Set-Cookie').at(-1)), 'clear sets Max-Age=0');

// ---------- validation ----------
section('validation');
ok(auth.validateUsername('ab') !== null, 'too-short username rejected');
ok(auth.validateUsername('a'.repeat(33)) !== null, 'too-long username rejected');
ok(auth.validateUsername('bad name') !== null, 'username with space rejected');
ok(auth.validateUsername('good_user.1-x') === null, 'valid username accepted');
ok(auth.validatePassword('short') !== null, 'too-short password rejected');
ok(auth.validatePassword('longenough') === null, 'valid password accepted');

// ---------- username normalisation + path derivation ----------
section('username normalisation + paths');
ok(db.normUsername('  Alice  ') === 'alice', 'trims + lowercases');
ok(db.authPath('Alice') === db.authPath('alice'), 'auth path is case-insensitive');
ok(db.authPath('alice') !== db.authPath('bob'), 'different users -> different paths');
ok(/^auth\/[0-9a-f]{64}\.json$/.test(db.authPath('alice')), 'auth path is hmac-derived');
const uid = db.newUserId();
ok(/^[0-9a-f]{48}$/.test(uid), 'userId is 192-bit hex');
ok(db.dataPath(uid) === `u/${uid}/data.json`, 'data path is account-scoped');

// ---------- sanitisers ----------
section('sanitisers');
const feats = db.sanitiseFeatures({ features: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
  { type: 'NotFeature' },
  null,
  { type: 'Feature', geometry: null },
  'garbage',
]});
ok(feats.length === 1, 'keeps only valid GeoJSON features');
ok(db.sanitiseFeatures(null).length === 0, 'null features -> []');
const prefs = db.sanitisePrefs({ connectionMode: 'bogus', shapeType: 'nope', opacity: 5, weight: 999 });
ok(prefs.connectionMode === 'none' && prefs.shapeType === 'circle', 'bad enums coerced to safe defaults');
ok(prefs.opacity === 1 && prefs.weight === 50, 'numeric ranges clamped');
ok(db.sanitisePrefs(null) === null, 'null prefs -> null');
ok(db.sanitiseJsonObject({ a: 1 }).a === 1, 'json object passthrough');
ok(db.sanitiseJsonObject([1, 2]) === null, 'arrays rejected');
ok(db.sanitiseJsonObject('str') === null, 'strings rejected');

// ---------- feature merge ----------
section('feature merge (union by id)');
const merged = db.mergeFeatures(
  [{ id: 'a', x: 1 }, { id: 'b', x: 1 }],
  [{ id: 'b', x: 2 }, { id: 'c', x: 3 }],
);
ok(merged.length === 3, 'union has 3 unique ids');
ok(merged.find((f) => f.id === 'b').x === 2, 'incoming wins on conflict');

// ---------- migrations ----------
section('schema migrations');
const legacyData = { /* no schemaVersion */ features: { features: [{ type: 'Feature', geometry: { type: 'Point' } }] } };
const md = (await import('../api/lib/db.js'));
// migrateData is not exported; exercise it via getUserData path is network — instead test emptyData + shape guarantee
const ed = db.emptyData('uX');
ok(ed.schemaVersion === db.SCHEMA_VERSION && ed.features.features.length === 0, 'emptyData has current schema + empty features');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
