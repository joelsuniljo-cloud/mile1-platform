'use strict';
/* Checks the Vercel setup: data kept in Upstash Redis, every request reads fresh data, and the Vercel entry
   point (api/index.js) serves the app. Uses a fake Redis REST server on this machine. Usage: node test-redis.js */
const http = require('http'), assert = require('assert'), path = require('path');
const { spawn } = require('child_process');

/* ---- fake Upstash REST ---- */
const store = { str: {}, hash: {} }, log = [];
function run(cmd) {
  const [c0, key, ...a] = cmd, c = String(c0).toUpperCase();
  log.push(c);
  switch (c) {
    case 'GET': return key in store.str ? store.str[key] : null;
    case 'SET': if (a[1] && String(a[1]).toUpperCase() === 'NX' && key in store.str) return null; store.str[key] = a[0]; return 'OK';
    case 'INCR': store.str[key] = String((+store.str[key] || 0) + 1); return +store.str[key];
    case 'EXPIRE': return 1;
    case 'HGETALL': { const h = store.hash[key] || {}; return Object.entries(h).flat(); }
    case 'HSET': { const h = store.hash[key] = store.hash[key] || {}; let n = 0; for (let i = 0; i < a.length; i += 2) { if (!(a[i] in h)) n++; h[a[i]] = a[i + 1]; } return n; }
    case 'HDEL': { const h = store.hash[key] || {}; let n = 0; a.forEach(f => { if (f in h) { delete h[f]; n++; } }); return n; }
    default: throw new Error('fake redis: unsupported ' + c);
  }
}
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer fake-token') { res.writeHead(401); return res.end('{"error":"bad token"}'); }
    try {
      const body = JSON.parse(raw);
      const out = req.url === '/pipeline' ? body.map(c => ({ result: run(c) })) : { result: run(body) };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
  });
});

let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);

(async () => {
  await new Promise(r => fake.listen(3480, r));
  const env = { UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:3480', UPSTASH_REDIS_REST_TOKEN: 'fake-token' };
  try {
    /* 1. the whole review loop with Redis as the only storage */
    const r1 = await new Promise(resolve => {
      const c = spawn(process.execPath, [path.join(__dirname, 'test.js')], { env: Object.assign({}, process.env, env) });
      let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
      const t = setTimeout(() => { c.kill(); resolve({ status: 'timeout', out }); }, 90000);
      c.on('exit', code => { clearTimeout(t); resolve({ status: code, out }); });
    });
    if (r1.status !== 0) { console.log(r1.out.slice(-2500)); throw new Error('main loop test failed in Redis mode (' + r1.status + ')'); }
    ok('full review loop (32 checks) passes with Redis storage');
    assert(Object.keys(store.hash['m1:items'] || {}).length === 6 && Object.keys(store.hash['m1:clients'] || {}).length === 1);
    assert(Object.keys(store.hash['m1:comments'] || {}).length >= 4 && Object.keys(store.hash['m1:users'] || {}).length === 1);
    ok('records are stored one per field (6 items, 1 client, comments, 1 user)');
    assert(store.str['m1:secret'] && store.str['m1:secret'].length === 64); ok('session secret kept in Redis, not on disk');

    /* 2. Vercel entry point, in this process */
    Object.assign(process.env, env, { PORT: '3481', BASE_PATH: '/platform', PUBLIC_URL: 'https://example.test', ADMIN_EMAIL: 'someone-else@example.test', ADMIN_PASSWORD: 'not-used-because-a-user-exists', AI_MODE: 'mock', ANTHROPIC_API_KEY: '' });
    const entry = require('./api/index.js');
    const vercel = http.createServer((req, res) => {
      /* what Vercel does with the rewrites in vercel.json */
      const m = /^\/platform(?:\/(.*))?$/.exec(req.url.split('?')[0]);
      if (!m) { res.writeHead(404); return res.end(); }
      req.url = '/api/index?p=/' + (m[1] || '');
      entry(req, res);
    });
    await new Promise(r => vercel.listen(3481, r));
    const U = 'http://127.0.0.1:3481/platform'; let cookie = '';
    const call = async (m, p, b, noCookie) => {
      const r = await fetch(U + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie: noCookie ? '' : cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
      const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=') && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* html */ }
      return { status: r.status, json: j, text: t };
    };
    let r = await call('GET', '/'); assert.equal(r.status, 200); assert(r.text.includes("const BASE='/platform'")); ok('Vercel entry serves the app page at /platform/');
    r = await call('GET', '/healthz'); assert.equal(r.json.storage, 'redis'); ok('health check reports Redis storage');
    r = await call('POST', '/api/login', { email: 'owner@example.test', password: 'a-long-test-password' }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert(cookie);
    ok('a session made by one server instance works on another (same user and secret came from Redis)');
    r = await call('POST', '/api/login', { email: 'someone-else@example.test', password: 'not-used-because-a-user-exists' }); assert.equal(r.status, 401);
    ok('start-up settings do not create a second user once one exists');
    r = await call('GET', '/api/state'); assert.equal(r.status, 200); assert.equal(r.json.clients.length, 1); assert.equal(r.json.items.length, 6);
    const client = r.json.clients[0]; ok('the earlier data is visible through the Vercel entry');

    /* every request reads fresh data: change Redis behind the app's back */
    const before = JSON.parse(store.hash['m1:items'][r.json.items[0].id]);
    before.topic = 'Changed directly in the database';
    store.hash['m1:items'][before.id] = JSON.stringify(before);
    r = await call('GET', '/api/state'); assert(r.json.items.some(i => i.topic === 'Changed directly in the database'));
    ok('a change made elsewhere shows up on the next request (no stale copy kept)');

    /* only changed records are written */
    log.length = 0;
    r = await call('PUT', `/api/items/${before.id}`, { topic: 'Edited in the app' }); assert.equal(r.status, 200);
    assert.equal(log.filter(c => c === 'HSET').length, 1, 'one HSET expected, got ' + log.join(',')); assert.equal(log.filter(c => c === 'HDEL').length, 0);
    ok('editing one item writes one record, not the whole database');
    r = await call('POST', `/api/items/${before.id}/draft`, {}); assert.equal(r.status, 200);
    r = await call('POST', `/api/items/${before.id}/send`, {}); assert.equal(r.json.status, 'review');

    /* version counter for cheap polling */
    const v1 = (await call('GET', '/api/version', undefined, true)).json.v;
    await call('PUT', `/api/items/${before.id}`, { pillar: 'Changed again' });
    const v2 = (await call('GET', '/api/version', undefined, true)).json.v; assert(v2 > v1); ok('version number goes up after a change');
    log.length = 0; await call('GET', '/api/version', undefined, true); assert.deepEqual(log, ['GET']); ok('checking the version costs one database command');

    /* client link works through the Vercel entry, and the response lands in Redis */
    r = await call('GET', `/r/${client.token}/data`, undefined, true); assert.equal(r.status, 200); assert(r.json.items.length >= 1 && r.json.items.some(i => i.id === before.id));
    r = await call('POST', `/r/${client.token}/approve/${before.id}`, { name: 'Asha' }, true); assert.equal(r.status, 200);
    r = await call('GET', '/api/state'); assert.equal(r.json.items.find(i => i.id === before.id).status, 'approved'); ok('client approval goes through Vercel entry and is saved');

    /* login limit is shared through Redis */
    let blocked = 0; for (let i = 0; i < 10; i++) { r = await call('POST', '/api/login', { email: 'owner@example.test', password: 'wrong' + i }); if (r.status === 429) blocked++; }
    assert(blocked >= 1); ok('repeated wrong passwords are blocked (limit stored in Redis)');

    console.log('\nAll ' + n + ' Vercel/Redis checks passed.');
  } catch (e) { console.error('\nFAILED after ' + n + ' checks:', e && e.stack || e); process.exit(1); }
  process.exit(0);
})();
