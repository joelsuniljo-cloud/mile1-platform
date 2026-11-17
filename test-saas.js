'use strict';
/* Multi-company (Postgres) mode: company isolation, signup, email verification, password reset, invites and roles.
   Uses an in-memory Postgres (PGlite), so no database setup is needed. Usage: node test-saas.js */
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);
const children = [];

async function start(port, env, legacy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1s-'));
  const e = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '/platform', PUBLIC_URL: 'https://app.example.test', ADMIN_EMAIL: 'root@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '', M1_PGLITE: legacy ? '' : '1', M1_LOG_LINKS: '1', ALLOW_SIGNUP: '1' }, env);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { child, log: '', port };
  child.stdout.on('data', d => srv.log += d); child.stderr.on('data', d => srv.log += d);
  children.push(child);
  for (let i = 0; i < 80 && !srv.log.includes('running'); i++) await sleep(100);
  assert(srv.log.includes('running'), 'server did not start: ' + srv.log);
  const U = 'http://127.0.0.1:' + port + '/platform';
  srv.session = () => {
    let cookie = '';
    const call = async (m, p, b) => {
      const r = await fetch(U + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
      const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = /Max-Age=0/.test(sc) ? '' : sc.split(';')[0];
      const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (x) { /* binary */ }
      return { status: r.status, json, buf };
    };
    call.signedIn = () => !!cookie;
    return call;
  };
  /* the most recent emailed link for an address (the server prints them when M1_LOG_LINKS=1) */
  srv.linkFor = (email, key) => { const m = [...srv.log.matchAll(new RegExp('LINK ' + email.replace(/[.+]/g, '\\$&') + ' (\\S+)', 'g'))].map(x => x[1]).filter(u => u.includes(key + '=')); return m.length ? decodeURIComponent(m[m.length - 1].split(key + '=')[1]) : null; };
  return srv;
}
const jpeg = len => { const b = Buffer.alloc(len, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return 'data:image/jpeg;base64,' + b.toString('base64'); };

(async () => {
  const S = await start(3520, {});
  const A = S.session(), B = S.session(), anon = S.session();
  try {
    /* ---- signup ---- */
    let r = await anon('GET', '/api/public-config'); assert.deepEqual(r.json, { saas: true, signup: true }); ok('the app reports it is in multi-company mode with signup open');
    r = await A('POST', '/api/signup', { company: 'Acme Agency', name: 'Asha', email: 'Asha@Acme.test', password: 'short' }); assert.equal(r.status, 400);
    r = await A('POST', '/api/signup', { company: 'Acme Agency', name: 'Asha', email: 'not-an-email', password: 'long-password-123' }); assert.equal(r.status, 400);
    r = await A('POST', '/api/signup', { company: 'A', name: 'Asha', email: 'asha@acme.test', password: 'long-password-123' }); assert.equal(r.status, 400); ok('signup checks the company, email and password');
    r = await A('POST', '/api/signup', { company: 'Acme Agency', name: 'Asha', email: 'Asha@Acme.test', password: 'long-password-123' }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert(A.signedIn());
    r = await B('POST', '/api/signup', { company: 'Beta Foods', name: 'Bala', email: 'bala@beta.test', password: 'another-long-pass-1' }); assert.equal(r.status, 200);
    r = await anon('POST', '/api/signup', { company: 'Copy', name: 'Xavier', email: 'ASHA@acme.test', password: 'long-password-123' }); assert.equal(r.status, 409); ok('two companies signed up; the same email (any capitals) cannot sign up twice');
    r = await A('GET', '/api/state'); assert.equal(r.status, 200); assert.equal(r.json.org.name, 'Acme Agency'); assert.equal(r.json.user.role, 'owner'); assert.equal(r.json.user.emailVerified, false); assert(!JSON.stringify(r.json).includes('"pw"')); ok('a new account lands signed in as owner of its own company, and password hashes are never sent');

    /* ---- isolation ---- */
    r = await A('POST', '/api/clients', { name: 'Brew Lane', platforms: ['Instagram'], pillars: 'Offers' }); const ca = r.json;
    r = await A('POST', `/api/clients/${ca.id}/calendar`, { start: '2026-11-02', weeks: 1, posts: 2, reels: 1 });
    r = await A('GET', '/api/state'); const ia = r.json.items[0];
    await A('POST', `/api/items/${ia.id}/draft`, {}); r = await A('PUT', `/api/items/${ia.id}/image`, { data: jpeg(2000), prompt: 'p' }); const imgA = r.json.image.id; assert(imgA);
    await A('POST', `/api/clients/${ca.id}/intel`, { competitors: [{ name: 'Rival', url: '' }] });
    r = await B('POST', '/api/clients', { name: 'Spice Box', platforms: ['LinkedIn'] }); const cb = r.json;
    r = await B('POST', `/api/clients/${cb.id}/calendar`, { start: '2026-11-02', weeks: 1, posts: 1, reels: 0 }); r = await B('GET', '/api/state'); const ib = r.json.items[0];
    await B('POST', `/api/items/${ib.id}/draft`, {}); r = await B('PUT', `/api/items/${ib.id}/image`, { data: jpeg(2500), prompt: 'q' }); const imgB = r.json.image.id;
    r = await B('GET', '/api/state'); assert.equal(r.json.clients.length, 1); assert.equal(r.json.clients[0].name, 'Spice Box'); assert(r.json.items.every(i => i.clientId === cb.id)); assert(!JSON.stringify(r.json).includes(ca.token) && !JSON.stringify(r.json).includes(ia.id));
    ok("each company's screen shows only its own clients, items and tokens");
    const attacks = [
      ['PUT', `/api/items/${ia.id}`, { topic: 'HACKED' }], ['DELETE', `/api/items/${ia.id}`], ['POST', `/api/items/${ia.id}/draft`, {}], ['POST', `/api/items/${ia.id}/send`, {}],
      ['POST', `/api/items/${ia.id}/image/prompt`, {}], ['PUT', `/api/items/${ia.id}/image`, { data: jpeg(1500) }], ['DELETE', `/api/items/${ia.id}/image`], ['GET', `/api/img/${imgA}`],
      ['PUT', `/api/clients/${ca.id}`, { name: 'HACKED', platforms: ['Instagram'] }], ['DELETE', `/api/clients/${ca.id}`], ['POST', `/api/clients/${ca.id}/calendar`, { start: '2026-12-01', weeks: 1, posts: 1 }],
      ['POST', `/api/clients/${ca.id}/intel`, {}], ['GET', `/api/clients/${ca.id}/export.csv`], ['POST', `/api/clients/${ca.id}/regen-link`, {}], ['PUT', `/api/clients/${ca.id}/competitors`, { list: [] }],
      ['POST', `/api/items/${ia.id}/comments`, { text: 'hi' }], ['POST', `/api/items/${ia.id}/restore`, { index: 0 }], ['POST', `/api/items/${ia.id}/apply`, {}], ['POST', `/api/items/${ia.id}/resend`, {}]
    ];
    for (const [m, p, b] of attacks) { r = await B(m, p, b); assert.equal(r.status, 404, `${m} ${p} should be 404 for another company, got ${r.status}`); }
    ok(`${attacks.length} attempts by company B to read or change company A's items, clients and pictures all fail with "not found"`);
    r = await A('GET', '/api/state'); assert.equal(r.json.clients[0].name, 'Brew Lane'); assert(!r.json.items.some(i => i.topic === 'HACKED')); assert.equal(r.json.items.length, 3); ok("company A's data is untouched after those attempts");
    r = await B('POST', '/api/items', { clientId: ca.id, date: '2026-11-09', type: 'post' }); assert.notEqual(r.status, 200); r = await A('GET', '/api/state'); assert.equal(r.json.items.length, 3); ok("company B cannot add an item to company A's client");
    r = await anon('GET', `/r/${cb.token}/img/${imgA}`); assert.equal(r.status, 404); r = await anon('GET', `/r/${ca.token}/img/${imgB}`); assert.equal(r.status, 404); ok("a client link cannot be used to fetch another company's picture");
    await A('POST', `/api/items/${ia.id}/send`, {}); r = await anon('GET', `/r/${ca.token}/data`); assert.equal(r.status, 200); assert.equal(r.json.client.name, 'Brew Lane'); assert(r.json.items.every(i => i.id === ia.id));
    r = await anon('POST', `/r/${ca.token}/approve/${ib.id}`, { name: 'X' }); assert(r.status === 404 || r.status === 400); r = await B('GET', '/api/state'); assert.equal(r.json.items[0].status !== 'approved', true); ok("a client link only reaches its own company's items");
    r = await anon('POST', `/r/${ca.token}/approve/${ia.id}`, { name: 'Asha C' }); assert.equal(r.status, 200); r = await A('GET', '/api/state'); assert.equal(r.json.items.find(i => i.id === ia.id).status, 'approved'); ok('client approval lands in the right company');
    r = await anon('GET', '/r/not-a-real-token-123/data'); assert.equal(r.status, 404); ok('a wrong client link is "not valid"');

    /* ---- version counter per company ---- */
    const ver = async s => (await s('GET', '/api/version')).json.v;
    const va = await ver(A), vb = await ver(B); await A('POST', '/api/clients', { name: 'Second', platforms: ['Instagram'] });
    assert(await ver(A) > va); assert.equal(await ver(B), vb); ok("one company's changes do not wake another company's open screens");
    assert.equal((await anon('GET', '/api/version')).json.v, 0);

    /* ---- parallel use ---- */
    await Promise.all([...Array(8)].map((_, i) => A('POST', '/api/clients', { name: 'A' + i, platforms: ['Instagram'] }).then(x => assert.equal(x.status, 200)).then(() => B('POST', '/api/clients', { name: 'B' + i, platforms: ['Instagram'] }))));
    r = await A('GET', '/api/state'); const na = r.json.clients.map(c => c.name); r = await B('GET', '/api/state'); const nb = r.json.clients.map(c => c.name);
    assert.equal(na.filter(x => /^A\d/.test(x)).length, 8); assert(!na.some(x => /^B\d/.test(x))); assert.equal(nb.filter(x => /^B\d/.test(x)).length, 8); assert(!nb.some(x => /^A\d/.test(x))); ok('16 requests at the same moment from two companies all land in the right company');

    /* ---- email verification ---- */
    let tok = S.linkFor('asha@acme.test', 'verify'); assert(tok, 'verification link emailed');
    r = await anon('POST', '/api/verify', { token: tok + 'x' }); assert.equal(r.status, 400);
    r = await anon('POST', '/api/verify', { token: tok }); assert.equal(r.status, 200); r = await A('GET', '/api/state'); assert.equal(r.json.user.emailVerified, true); ok('the emailed link verifies the address, and a tampered link does not');
    r = await B('POST', '/api/resend-verify', {}); assert.equal(r.status, 200); assert(S.linkFor('bala@beta.test', 'verify')); ok('a new verification link can be requested');

    /* ---- password reset ---- */
    const before = S.log.length;
    r = await anon('POST', '/api/forgot', { email: 'nobody@nowhere.test' }); assert.equal(r.status, 200); assert(!S.log.slice(before).includes('nobody@nowhere.test')); ok('asking to reset an unknown email gives the same answer and sends nothing');
    r = await anon('POST', '/api/forgot', { email: 'ASHA@acme.test' }); assert.equal(r.status, 200); tok = S.linkFor('asha@acme.test', 'reset'); assert(tok);
    r = await anon('POST', '/api/reset', { token: tok, password: 'short' }); assert.equal(r.status, 400);
    const A2 = S.session(); r = await A2('POST', '/api/reset', { token: tok, password: 'brand-new-password-9' }); assert.equal(r.status, 200);
    r = await A2('POST', '/api/login', { email: 'asha@acme.test', password: 'long-password-123' }); assert.equal(r.status, 401);
    r = await A2('POST', '/api/login', { email: 'asha@acme.test', password: 'brand-new-password-9' }); assert.equal(r.status, 200); r = await A2('GET', '/api/state'); assert.equal(r.json.org.name, 'Acme Agency');
    r = await anon('POST', '/api/reset', { token: tok, password: 'yet-another-password-1' }); assert.equal(r.status, 400); ok('reset sets the new password, the old one stops working, and the link works only once');

    /* ---- team and roles ---- */
    r = await A('POST', '/api/team/invite', { email: 'bala@beta.test', role: 'editor' }); assert.equal(r.status, 409); ok('an email that already has an account cannot be invited');
    r = await A('POST', '/api/team/invite', { email: 'ed@acme.test', role: 'editor' }); assert.equal(r.status, 200); const invEd = r.json.invite;
    r = await A('POST', '/api/team/invite', { email: 'view@acme.test', role: 'viewer' }); const invView = r.json.invite;
    r = await A('POST', '/api/team/invite', { email: 'adm@acme.test', role: 'admin' }); const invAdm = r.json.invite;
    r = await A('GET', '/api/team'); assert.equal(r.json.members.length, 1); assert.equal(r.json.invites.length, 3); assert(r.json.invites[0].link.includes('invite=')); ok('the owner invites an editor, a viewer and an admin and sees the pending invites');
    const tokOf = i => decodeURIComponent(i.link.split('invite=')[1]);
    const ED = S.session(); r = await ED('POST', '/api/invite/peek', { token: tokOf(invEd) }); assert.equal(r.json.company, 'Acme Agency'); assert.equal(r.json.email, 'ed@acme.test');
    r = await ED('POST', '/api/invite/accept', { token: tokOf(invEd) + 'x', name: 'Ed', password: 'long-password-123' }); assert.equal(r.status, 400);
    r = await ED('POST', '/api/invite/accept', { token: tokOf(invEd), name: 'Ed', password: 'long-password-123' }); assert.equal(r.status, 200);
    r = await ED('GET', '/api/state'); assert.equal(r.json.user.role, 'editor'); assert.equal(r.json.org.name, 'Acme Agency'); assert(r.json.clients.some(c => c.name === 'Brew Lane')); assert(!r.json.clients.some(c => c.name === 'Spice Box'));
    r = await ED('POST', '/api/invite/accept', { token: tokOf(invEd), name: 'Ed again', password: 'long-password-123' }); assert.equal(r.status, 400); ok('an invited person joins the right company with the invited role; the invite works once');
    r = await ED('POST', '/api/clients', { name: 'Made by editor', platforms: ['Instagram'] }); assert.equal(r.status, 200);
    r = await ED('GET', '/api/team'); assert.equal(r.status, 403); r = await ED('POST', '/api/team/invite', { email: 'x@acme.test', role: 'viewer' }); assert.equal(r.status, 403); r = await ED('PUT', '/api/org', { name: 'Mine now' }); assert.equal(r.status, 403); ok('an editor can work on content but cannot manage the team or the company name');
    const VW = S.session(); await VW('POST', '/api/invite/accept', { token: tokOf(invView), name: 'Vee', password: 'long-password-123' });
    r = await VW('GET', '/api/state'); assert.equal(r.status, 200); assert.equal(r.json.user.role, 'viewer');
    r = await VW('PUT', `/api/items/${ia.id}`, { topic: 'viewer edit' }); assert.equal(r.status, 403); r = await VW('POST', '/api/clients', { name: 'v', platforms: ['Instagram'] }); assert.equal(r.status, 403);
    r = await VW('POST', '/api/password', { current: 'long-password-123', next: 'viewer-new-password-1' }); assert.equal(r.status, 200); ok('a viewer can look and change their own password but cannot change anything else');
    const AD = S.session(); await AD('POST', '/api/invite/accept', { token: tokOf(invAdm), name: 'Adi', password: 'long-password-123' });
    r = await AD('POST', '/api/team/invite', { email: 'adm2@acme.test', role: 'admin' }); assert.equal(r.status, 403);
    r = await AD('POST', '/api/team/invite', { email: 'ed2@acme.test', role: 'editor' }); assert.equal(r.status, 200); const invEd2 = r.json.invite;
    r = await AD('DELETE', `/api/team/invites/${invEd2.id}`); r = await anon('POST', '/api/invite/accept', { token: tokOf(invEd2), name: 'Ed2', password: 'long-password-123' }); assert.equal(r.status, 400); ok('an admin manages editors and viewers but cannot create other admins; a cancelled invite stops working');
    r = await A('GET', '/api/team'); const members = r.json.members; assert.equal(members.length, 4);
    const edId = members.find(m => m.email === 'ed@acme.test').id, admId = members.find(m => m.email === 'adm@acme.test').id, ownerId = members.find(m => m.role === 'owner').id;
    r = await AD('PUT', `/api/team/users/${edId}`, { role: 'admin' }); assert.equal(r.status, 403); r = await AD('DELETE', `/api/team/users/${ownerId}`); assert.equal(r.status, 400); r = await A('PUT', `/api/team/users/${ownerId}`, { role: 'editor' }); assert.equal(r.status, 400); r = await A('DELETE', `/api/team/users/${ownerId}`); assert.equal(r.status, 400);
    r = await A('PUT', `/api/team/users/${edId}`, { role: 'viewer' }); assert.equal(r.status, 200); r = await ED('PUT', `/api/items/${ia.id}`, { topic: 'x' }); assert.equal(r.status, 403); ok('role changes take effect at once; the owner cannot be demoted or removed');
    r = await A('DELETE', `/api/team/users/${edId}`); assert.equal(r.status, 200); r = await ED('GET', '/api/state'); assert.equal(r.status, 401); r = await ED('POST', '/api/login', { email: 'ed@acme.test', password: 'long-password-123' }); assert.equal(r.status, 401); ok('removing a person ends their access immediately, even with a signed-in browser');
    r = await B('GET', '/api/team'); assert.equal(r.json.members.length, 1); assert.equal(r.json.members[0].email, 'bala@beta.test'); ok("company B's team list shows none of company A's people");
    r = await A('PUT', '/api/org', { name: 'Acme Studio' }); assert.equal(r.status, 200); r = await A('GET', '/api/state'); assert.equal(r.json.org.name, 'Acme Studio'); r = await B('GET', '/api/state'); assert.equal(r.json.org.name, 'Beta Foods'); ok('the company name can be changed by the owner');

    /* ---- the bootstrap company (ADMIN_EMAIL) and login ---- */
    const R = S.session(); r = await R('POST', '/api/login', { email: 'root@x.test', password: 'long-password-123' }); assert.equal(r.status, 200); r = await R('GET', '/api/state'); assert.equal(r.json.org.name, 'Mile 1'); assert.equal(r.json.org.plan, 'internal'); assert.equal(r.json.clients.length, 0); ok('the ADMIN_EMAIL account is your own company, separate from every customer');
    r = await anon('GET', '/healthz'); assert.equal(r.json.storage, 'postgres'); ok('health check reports Postgres');

    /* ---- other servers: signup closed, signup limit, single-company mode ---- */
    const C = await start(3521, { ALLOW_SIGNUP: '' }); r = await C.session()('POST', '/api/signup', { company: 'Zed', name: 'Zed', email: 'z@z.test', password: 'long-password-123' }); assert.equal(r.status, 403);
    r = await C.session()('GET', '/api/public-config'); assert.deepEqual(r.json, { saas: true, signup: false }); ok('signup is closed unless you switch it on, so you can run by invitation only');
    const D = await start(3522, {}); let last; for (let i = 0; i < 11; i++) last = await D.session()('POST', '/api/signup', { company: 'Co' + i, name: 'Nm' + i, email: `u${i}@lim.test`, password: 'long-password-123' });
    assert.equal(last.status, 429); ok('one network cannot create more than 10 sign up attempts an hour');
    const L = await start(3523, {}, true); const ls = L.session(); r = await ls('POST', '/api/signup', { company: 'Zed', name: 'Zed', email: 'z@z.test', password: 'long-password-123' }); assert.equal(r.status, 404);
    r = await ls('GET', '/api/public-config'); assert.deepEqual(r.json, { saas: false, signup: false }); r = await ls('POST', '/api/login', { email: 'root@x.test', password: 'long-password-123' }); assert.equal(r.status, 200); r = await ls('GET', '/api/state'); assert.equal(r.json.user.role, 'owner'); assert.equal(r.json.org.name, 'Mile 1'); ok('the single-agency setup (file or Redis) still works the same and offers no signup');

    console.log('\nAll ' + n + ' multi-company checks passed.'); children.forEach(c => c.kill()); process.exit(0);
  } catch (e) { console.error('\nFAILED after ' + n + ' checks:', e && e.stack || e); children.forEach(c => c.kill()); process.exit(1); }
})();
