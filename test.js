'use strict';
/* End-to-end test of the review loop. Runs the server in demo AI mode. Usage: node test.js */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-'));
Object.assign(process.env, {
  PORT: '3457', DATA_DIR: dir, BASE_PATH: '/platform', PUBLIC_URL: 'https://example.test',
  ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD: 'a-long-test-password', AI_MODE: 'mock', ANTHROPIC_API_KEY: ''
});
const { boot } = require('./server.js');
const server = boot();
const U = 'http://127.0.0.1:3457/platform';
let cookie = '';
async function call(method, p, body, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (!opts.noHeader) headers['x-m1'] = '1';
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  const r = await fetch(U + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=') && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}
let n = 0; const ok = (name) => console.log('  ok ' + (++n) + '. ' + name);

(async () => {
  try {
    await new Promise(r => setTimeout(r, 300));
    let r = await call('GET', '/');
    assert.equal(r.status, 200); assert(r.text.includes("const BASE='/platform'")); assert(r.text.includes('href="/platform/style.css"')); ok('app page served under /platform with the base path filled in');
    r = await call('GET', '/style.css'); assert.equal(r.status, 200); ok('stylesheet served');
    r = await call('GET', '/api/state', undefined, { noCookie: true }); assert.equal(r.status, 401); ok('state refuses signed-out requests');
    r = await call('POST', '/api/login', { email: 'owner@example.test', password: 'wrong' }); assert.equal(r.status, 401); ok('wrong password rejected');
    r = await call('POST', '/api/login', { email: 'OWNER@example.test', password: 'a-long-test-password' }); assert.equal(r.status, 200); assert(cookie); ok('login works');
    r = await call('POST', '/api/clients', { name: '  ', platforms: ['Instagram'] }); assert.equal(r.status, 400); ok('client without name rejected');
    r = await call('POST', '/api/clients', { name: 'Brew Lane', industry: 'Cafe', voice: 'Warm', pillars: 'Behind the bar\nOffers', platforms: ['Instagram', 'LinkedIn'], postsPerWeek: 2, reelsPerWeek: 1, contactName: 'Asha' });
    assert.equal(r.status, 200); const client = r.json; assert(client.token && client.token.length >= 20); ok('client created with a private review token');
    r = await call('POST', `/api/clients/${client.id}/calendar`, { start: '2026-11-02', weeks: 2, posts: 2, reels: 1 }); assert.equal(r.status, 200); assert.equal(r.json.added, 6); ok('calendar generated (6 ideas)');
    r = await call('GET', '/api/state'); assert.equal(r.json.items.length, 6); assert.equal(r.json.config.ai, 'demo');
    const items = r.json.items.sort((a, b) => a.date.localeCompare(b.date)); const [A, B] = items;
    r = await call('POST', `/api/items/${A.id}/send`, {}); assert.equal(r.status, 400); ok('cannot send an undrafted item');
    r = await call('POST', `/api/items/${A.id}/draft`, { instruction: '' }); assert.equal(r.status, 200); assert(r.json.item.content.caption); assert.equal(r.json.item.status, 'drafted'); ok('AI draft saved and item moved to drafted');
    r = await call('POST', `/api/items/${B.id}/draft`, {}); assert.equal(r.status, 200);
    r = await call('PUT', `/api/items/${A.id}`, { content: { caption: 'Manual edit by agency' } }); assert.equal(r.json.content.caption, 'Manual edit by agency'); assert.equal(r.json.history.length, 1); ok('manual edit keeps the earlier version');
    r = await call('POST', `/api/items/${A.id}/restore`, { index: 0 }); assert(r.json.content.caption.startsWith('DEMO DRAFT')); ok('restore earlier version');
    r = await call('POST', `/api/items/${A.id}/send`, {}); assert.equal(r.json.status, 'review'); assert.equal(r.json.round, 1);
    r = await call('POST', `/api/items/${B.id}/send`, {}); assert.equal(r.json.status, 'review'); ok('two items sent for review');

    const tok = client.token;
    r = await call('GET', '/r/bad-token/data', undefined, { noCookie: true }); assert.equal(r.status, 404); ok('wrong review link is rejected');
    r = await call('GET', `/r/${tok}/data`, undefined, { noCookie: true }); assert.equal(r.status, 200); assert.equal(r.json.items.length, 2); assert(r.json.items.every(i => i.state === 'awaiting'));
    assert(!JSON.stringify(r.json).includes('triage')); ok('client sees only the two sent items');
    r = await call('POST', `/r/${tok}/approve/${A.id}`, { name: 'Asha' }, { noCookie: true, noHeader: true }); assert.equal(r.status, 403); ok('portal write without the request header is blocked');
    r = await call('POST', `/r/${tok}/changes/${A.id}`, { name: 'Asha', text: '' }, { noCookie: true }); assert.equal(r.status, 400); ok('empty change request rejected');
    r = await call('POST', `/r/${tok}/changes/${A.id}`, { name: 'Asha', text: 'Make the caption shorter and mention the weekend offer' }, { noCookie: true }); assert.equal(r.status, 200);
    r = await call('POST', `/r/${tok}/approve/${B.id}`, { name: 'Asha' }, { noCookie: true }); assert.equal(r.status, 200); ok('client requested changes on one item and approved the other');
    r = await call('POST', `/r/${tok}/approve/${B.id}`, { name: 'Asha' }, { noCookie: true }); assert.equal(r.status, 409); ok('double approval blocked');

    r = await call('GET', '/api/state'); assert.equal(r.json.unread, 2);
    const stA = r.json.items.find(i => i.id === A.id), stB = r.json.items.find(i => i.id === B.id);
    assert.equal(stA.status, 'changes'); assert.equal(stB.status, 'approved'); ok('agency sees changes asked and approval, with 2 unread');
    const cm = r.json.comments.find(c => c.itemId === A.id && c.kind === 'change');
    r = await call('POST', `/api/items/${A.id}/apply`, {}); assert.equal(r.status, 400); ok('cannot revise before accepting a comment');
    r = await call('PUT', `/api/comments/${cm.id}`, { triage: 'accepted', text: 'Shorten the caption and add the weekend offer.' }); assert.equal(r.json.triage, 'accepted');
    r = await call('POST', `/api/items/${A.id}/apply`, { note: '' }); assert.equal(r.status, 200);
    assert.equal(r.json.status, 'drafted'); assert.equal(r.json.revised, true); assert(r.json.content.caption.includes('weekend offer')); ok('AI revision applied from the accepted comment');
    r = await call('GET', `/r/${tok}/data`, undefined, { noCookie: true });
    let pa = r.json.items.find(i => i.id === A.id);
    assert.equal(pa.state, 'revising'); assert(!pa.content.caption.includes('weekend offer')); ok('client still sees the old version until the revision is sent');
    r = await call('POST', `/api/items/${A.id}/resend`, { note: 'Shortened as asked.' }); assert.equal(r.json.status, 'review'); assert.equal(r.json.round, 2);
    r = await call('GET', `/r/${tok}/data`, undefined, { noCookie: true });
    pa = r.json.items.find(i => i.id === A.id);
    assert.equal(pa.state, 'awaiting'); assert(pa.content.caption.includes('weekend offer')); assert(pa.comments.some(c => c.kind === 'resolved')); assert(pa.comments.some(c => c.kind === 'reply')); assert.equal(pa.round, 2); ok('resent: client sees the new version, what changed, and the note');
    r = await call('POST', `/r/${tok}/approve/${A.id}`, { name: 'Asha' }, { noCookie: true }); assert.equal(r.status, 200);
    r = await call('POST', `/r/${tok}/undo/${A.id}`, {}, { noCookie: true }); assert.equal(r.status, 200);
    r = await call('POST', `/r/${tok}/approve/${A.id}`, { name: 'Asha' }, { noCookie: true }); assert.equal(r.status, 200); ok('approve, undo, approve again');
    r = await call('PUT', `/api/items/${A.id}`, { status: 'published' }); assert.equal(r.json.status, 'published'); ok('marked published');
    r = await call('GET', `/api/clients/${client.id}/export.csv`); assert.equal(r.status, 200); assert(r.text.includes('Caption')); ok('CSV export');
    r = await call('GET', '/api/export'); assert.equal(r.status, 200); ok('JSON backup export');
    r = await call('POST', `/api/clients/${client.id}/regen-link`, {}); assert.notEqual(r.json.token, tok);
    r = await call('GET', `/r/${tok}/data`, undefined, { noCookie: true }); assert.equal(r.status, 404); ok('resetting the link kills the old one');
    r = await call('GET', '/healthz'); assert.equal(r.status, 200);
    r = await call('POST', '/api/password', { current: 'a-long-test-password', next: 'short' }); assert.equal(r.status, 400); ok('short new password rejected');
    r = await call('POST', '/api/logout', {}); cookie = ''; r = await call('GET', '/api/state'); assert.equal(r.status, 401); ok('logout');

    setTimeout(() => {
      if (process.env.UPSTASH_REDIS_REST_URL) ok('data kept in Redis (checked by test-redis.js)');
      else { assert(fs.existsSync(path.join(dir, 'db.json'))); ok('data written to disk'); }
      console.log('\nAll ' + n + ' checks passed.'); process.exit(0);
    }, 500);
  } catch (e) {
    console.error('\nFAILED after ' + n + ' checks:', e && e.stack || e); process.exit(1);
  }
})();
