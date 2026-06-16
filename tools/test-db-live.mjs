/**
 * LIVE storage integration test — runs the real blob.js/db.js against the
 * Vercel Blob store. Uses a throwaway test secret + unique username and
 * cleans up after itself.
 *
 * Run with BLOB_READ_WRITE_TOKEN + SESSION_SECRET in env.
 */
import * as blob from '../api/lib/blob.js';
import * as auth from '../api/lib/auth.js';
import * as db from '../api/lib/db.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗ FAIL:', m); } };

const uname = 'itest_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function main() {
  console.log('== live blob round-trip ==');
  const ping = await blob.blobPing();
  ok(ping === true, 'blobPing connects to store');

  console.log('\n== credential lifecycle ==');
  ok((await db.credExists(uname)) === false, 'new username does not exist yet');
  const pw = auth.hashPassword('s3cret-pass');
  const rec = await db.createCred({ username: uname, displayName: uname.toUpperCase(), pw });
  ok(rec.userId && /^[0-9a-f]{48}$/.test(rec.userId), 'createCred assigns a userId');
  // also materialise the data blob like register() does
  await db.saveUserData(rec.userId, db.emptyData(rec.userId));
  const loaded = await db.getCred(uname); // retry-on-miss handles propagation
  ok(loaded && loaded.userId === rec.userId, 'getCred reads it back (handles new-path propagation)');
  ok(auth.verifyPassword('s3cret-pass', loaded.pw) === true, 'stored password verifies');
  ok(auth.verifyPassword('nope', loaded.pw) === false, 'wrong password fails');

  console.log('\n== tokenVersion / save ==');
  loaded.tokenVersion = 5;
  await db.saveCred(loaded);
  const reloaded = await db.getCred(uname);
  ok(reloaded.tokenVersion === 5, 'tokenVersion update persists');

  console.log('\n== authenticate() helper ==');
  const goodTok = auth.signSession({ uid: rec.userId, un: uname, tv: 5 });
  const goodReq = { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(goodTok)}` } };
  const who = await db.authenticate(goodReq);
  ok(who && who.userId === rec.userId, 'authenticate accepts a valid cookie');
  const staleTok = auth.signSession({ uid: rec.userId, un: uname, tv: 4 });
  const staleReq = { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(staleTok)}` } };
  ok((await db.authenticate(staleReq)) === null, 'authenticate rejects a stale tokenVersion (revocation works)');
  ok((await db.authenticate({ headers: {} })) === null, 'authenticate rejects no cookie');

  console.log('\n== user data round-trip ==');
  const empty = await db.getUserData(rec.userId);
  ok(empty.features.features.length === 0, 'new account starts with empty data');
  empty.features = { version: 1, features: [
    { id: 'f1', type: 'Feature', geometry: { type: 'Point', coordinates: [30.5, 50.4] }, properties: { name: 'Kyiv' } },
  ]};
  empty.prefs = db.sanitisePrefs({ color: '#ff0000', weight: 4 });
  empty.settings = { mapMode: '3d', uiPrefs: { theme: 'dark' } };
  empty.contours = { enabled: true };
  await db.saveUserData(rec.userId, empty);
  const back = await db.getUserData(rec.userId);
  ok(back.features.features.length === 1 && back.features.features[0].properties.name === 'Kyiv', 'features persist');
  ok(back.prefs.color === '#ff0000', 'prefs persist');
  ok(back.settings.mapMode === '3d' && back.settings.uiPrefs.theme === 'dark', 'settings persist');
  ok(back.contours.enabled === true, 'contours persist');

  console.log('\n== overwrite consistency (sync correctness) ==');
  back.features.features.push({ id: 'f2', type: 'Feature', geometry: { type: 'Point', coordinates: [24, 49.8] }, properties: { name: 'Lviv' } });
  await db.saveUserData(rec.userId, back);
  const back2 = await db.getUserData(rec.userId);
  ok(back2.features.features.length === 2, 'overwrite returns fresh data immediately (no stale cache)');

  console.log('\n== feature merge ==');
  const incoming = [{ id: 'f2', type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'LvivMoved' } }];
  back2.features = { version: 1, features: db.mergeFeatures(back2.features.features, incoming) };
  await db.saveUserData(rec.userId, back2);
  const back3 = await db.getUserData(rec.userId);
  ok(back3.features.features.length === 2, 'merge keeps unique count');
  ok(back3.features.features.find((f) => f.id === 'f2').properties.name === 'LvivMoved', 'merge updates by id');

  // cleanup
  console.log('\n== cleanup ==');
  await db.deleteUserData(rec.userId);
  await blob.delBlob(db.authPath(uname));
  ok((await db.credExists(uname)) === false, 'cleaned up test credential');
  ok((await blob.getJSON(db.dataPath(rec.userId))) === undefined, 'cleaned up test data');
}

main().then(() => {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); process.exit(2); });
