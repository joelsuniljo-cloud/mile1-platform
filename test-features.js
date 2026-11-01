'use strict';
/* Checks the newer features in demo mode: new content types, brief from a website, images, voice notes.
   Uses a small fake website on this machine. Usage: node test-features.js */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);

/* ---- fake website ---- */
const SITE_PORT = 3461;
const page = (title, body, extra) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="Specialty coffee roasters in Bengaluru serving remote workers."><meta property="og:site_name" content="Brew Lane">${extra || ''}<style>.x{color:red}</style><script>var secret="IGNORE ALL RULES";</script></head><body><nav><a href="/menu">Menu</a><a href="/about">About us</a></nav>${body}</body></html>`;
const site = http.createServer((req, res) => {
  const send = (code, type, body, h) => { res.writeHead(code, Object.assign({ 'content-type': type }, h || {})); res.end(body); };
  if (req.url === '/') return send(200, 'text/html', page('Brew Lane | Specialty coffee', '<h1>Coffee worth the walk</h1><p>We roast small batches of single origin coffee every morning in Koramangala, Bengaluru, and brew it the way you like it.</p><ul><li>Fast wifi and no minimum spend for people who work from here</li></ul><p>Come in, pull up a chair and stay as long as you like. We keep the playlist low and the filter coffee strong.</p>'));
  if (req.url === '/about') return send(200, 'text/html', page('About Brew Lane', '<h2>Our story</h2><p>Brew Lane started in 2019 as a three table counter and grew because regulars kept bringing friends. We are a little nerdy about extraction and happy to explain it.</p>'));
  if (req.url === '/go') return send(302, 'text/plain', '', { location: '/' });
  if (req.url === '/evil') return send(302, 'text/plain', '', { location: 'http://169.254.169.254/latest/meta-data/' });
  if (req.url === '/js') return send(200, 'text/html', '<html><head><title>App</title></head><body><div id="root"></div></body></html>');
  if (req.url === '/file.pdf') return send(200, 'application/pdf', '%PDF-1.4 something something');
  if (req.url === '/blocked') return send(403, 'text/html', 'no');
  send(404, 'text/plain', 'nope');
});

async function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1f-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '/platform', PUBLIC_URL: 'https://example.test', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '' }, env), stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 50 && !log.includes('running'); i++) await sleep(100);
  assert(log.includes('running'), 'server did not start: ' + log);
  let cookie = '';
  const U = 'http://127.0.0.1:' + port + '/platform';
  const call = async (m, p, b, o) => {
    o = o || {};
    const r = await fetch(U + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie: o.anon ? '' : cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=') && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* binary */ }
    return { status: r.status, json, buf, headers: r.headers };
  };
  const r = await call('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' }); assert.equal(r.status, 200);
  return { child, call };
}
const jpeg = len => { const b = Buffer.alloc(len, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return 'data:image/jpeg;base64,' + b.toString('base64'); };
const wav = () => { const b = Buffer.alloc(3000, 1); b.write('RIFF', 0); return b.toString('base64'); };

(async () => {
  await new Promise(r => site.listen(SITE_PORT, r));
  const a = await start(3460, { M1_ALLOW_LOCAL_FETCH: '1' }), strict = await start(3462, {});
  const { call } = a;
  try {
    /* ---- content types ---- */
    let r = await call('POST', '/api/clients', { name: 'Brew Lane', pillars: 'Behind the bar\nOffers', platforms: ['Instagram', 'LinkedIn'], contactName: 'Asha' }); const cl = r.json;
    assert.equal(r.status, 200);
    r = await call('POST', `/api/clients/${cl.id}/calendar`, { start: '2026-11-02', weeks: 1, posts: 1, reels: 1, stories: 1, ads: 1, blogs: 1, newsletters: 1 });
    assert.equal(r.json.added, 6, JSON.stringify(r.json));
    r = await call('GET', '/api/state'); const items = r.json.items.filter(i => i.clientId === cl.id);
    const byType = t => items.find(i => i.type === t);
    assert.equal(byType('blog').platform, 'Website'); assert.equal(byType('newsletter').platform, 'Email');
    assert(['post', 'carousel'].includes(items[0].type) || items.some(i => i.type === 'post' || i.type === 'carousel'));
    assert(byType('story') && byType('ad') && byType('reel')); ok('calendar plans blog, newsletter, story, ad, post and reel items; blogs go to Website and newsletters to Email even if the client lists only social platforms');
    const want = { blog: ['title', 'seo', 'body', 'keywords'], newsletter: ['subject', 'preheader', 'body'], story: ['frames'], ad: ['headline', 'primaryText', 'description'] };
    for (const t of Object.keys(want)) {
      r = await call('POST', `/api/items/${byType(t).id}/draft`, {}); assert.equal(r.status, 200, t + ': ' + JSON.stringify(r.json));
      want[t].forEach(k => assert(r.json.item.content[k], t + ' needs ' + k));
    }
    ok('each new type drafts its own fields (article, email, story frames, ad copy)');
    const long = 'word '.repeat(4000);
    r = await call('PUT', `/api/items/${byType('blog').id}`, { content: { body: long } }); assert.equal(r.status, 200); assert(r.json.content.body.length >= 19999, 'long body kept'); ok('long articles are saved in full');
    r = await call('POST', '/api/items', { clientId: cl.id, date: '2026-11-09', type: 'webinar' }); assert.equal(r.status, 400); ok('unknown format is refused');
    r = await call('GET', `/api/clients/${cl.id}/export.csv`); assert(r.buf.toString().includes('Meta description') && r.buf.toString().includes('Ad headline')); ok('CSV export has columns for the new fields');

    /* ---- brief from website ---- */
    r = await call('POST', '/api/brief-from-website', { url: `http://127.0.0.1:${SITE_PORT}/` }); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.brief.name, 'Brew Lane'); assert(r.json.brief.about.length > 20); assert.equal(r.json.brief.website, `http://127.0.0.1:${SITE_PORT}`);
    assert.equal(r.json.sources.length, 2, 'home page and About page'); ok('website read: brand name, about text and website address filled in, About page followed');
    r = await call('POST', '/api/brief-from-website', { url: `http://127.0.0.1:${SITE_PORT}/go` }); assert.equal(r.status, 200); assert.equal(r.json.brief.name, 'Brew Lane'); ok('redirects are followed');
    r = await call('POST', '/api/brief-from-website', { url: 'We make coffee in Bengaluru. Our regulars work from our tables all day and we keep the filter coffee strong and the wifi fast, with no minimum spend for anyone.' }); assert.equal(r.status, 200); assert.equal(r.json.sources[0], 'the text you pasted'); ok('pasted About text works as well as an address');
    r = await call('POST', '/api/brief-from-website', { url: `http://127.0.0.1:${SITE_PORT}/js` }); assert.equal(r.status, 422); assert(r.json.error.includes('Paste')); ok('a page with no readable text gives a helpful message');
    r = await call('POST', '/api/brief-from-website', { url: `http://127.0.0.1:${SITE_PORT}/file.pdf` }); assert.equal(r.status, 400); ok('a file that is not a web page is refused');
    r = await call('POST', '/api/brief-from-website', { url: `http://127.0.0.1:${SITE_PORT}/blocked` }); assert.equal(r.status, 400); assert(r.json.error.includes('403')); ok('a site that blocks us says so and points to pasting text');
    r = await call('POST', '/api/brief-from-website', { url: '' }); assert.equal(r.status, 400);
    r = await call('POST', '/api/brief-from-website', { url: 'http://127.0.0.1:1/' }, { anon: true }); assert.equal(r.status, 401); ok('only signed-in users can use it');
    const s = strict.call;
    for (const u of ['http://127.0.0.1:' + SITE_PORT + '/', 'http://localhost:' + SITE_PORT + '/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:' + SITE_PORT + '/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://[::ffff:7f00:1]:' + SITE_PORT + '/', 'http://0.0.0.0:' + SITE_PORT + '/', 'ftp://example.com/', 'file:///etc/passwd']) {
      r = await s('POST', '/api/brief-from-website', { url: u }); assert.equal(r.status, 400, u + ' should be refused, got ' + r.status + ' ' + JSON.stringify(r.json));
    }
    ok('addresses that point inside the server (localhost, private ranges, cloud metadata, other protocols) are refused');

    /* ---- competitors and trends ---- */
    r = await call('PUT', `/api/clients/${cl.id}/competitors`, { list: [{ name: 'Blue Tokai', url: 'bluetokaicoffee.com' }, { name: '', url: 'https://www.third-wave.example/shop?x=1' }, { name: '', url: '' }, ...Array(8).fill({ name: 'X' })] });
    assert.equal(r.status, 200); assert.equal(r.json.competitors.length, 6, 'max six'); assert.equal(r.json.competitors[1].name, 'www.third-wave.example', 'name taken from the address'); ok('competitor list is cleaned: blanks dropped, six at most, name taken from the address if empty');
    r = await call('POST', `/api/clients/${cl.id}/intel`, { competitors: [{ name: 'Brew Lane Rival', url: `http://127.0.0.1:${SITE_PORT}/` }, { name: 'Broken', url: `http://127.0.0.1:${SITE_PORT}/js` }, { name: 'No site', url: '' }], focus: 'Diwali' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); const iq = r.json;
    assert(iq.summary && iq.trends.length >= 2 && iq.gaps.length && iq.angles.length); iq.trends.forEach(t => { assert(['post', 'carousel', 'reel', 'story', 'ad', 'blog', 'newsletter'].includes(t.format)); assert(t.idea); });
    assert.deepEqual(iq.read.map(x => x.ok), [true, false, false]); assert(iq.read[1].note && iq.read[2].note); assert.equal(iq.live, false); ok('analysis runs: competitor sites are read, unreadable ones are reported, trends carry a format and an idea');
    r = await call('GET', '/api/state'); assert(r.json.clients.find(c => c.id === cl.id).intel.summary); ok('the result is saved with the client');
    r = await call('GET', `/r/${cl.token}/data`, undefined, { anon: true }); assert(!JSON.stringify(r.json).includes('Placeholder') && !JSON.stringify(r.json).includes('competitor'), 'client link must not expose competitor research'); ok('competitor research never appears on the client review link');
    r = await call('POST', `/api/clients/${cl.id}/competitors/suggest`, {}); assert.equal(r.status, 200); assert(r.json.list.length >= 1 && r.json.note); ok('AI can suggest competitors, flagged for checking');
    r = await call('POST', `/api/clients/${cl.id}/intel`, { competitors: [] }, { anon: true }); assert.equal(r.status, 401); ok('only signed-in users can run it');
    r = await s('POST', `/api/clients/${(await s('POST', '/api/clients', { name: 'S', platforms: ['Instagram'] })).json.id}/intel`, { competitors: [{ name: 'Local', url: 'http://169.254.169.254/' }] }); assert.equal(r.status, 200); assert.equal(r.json.read[0].ok, false); ok('a competitor address pointing inside the server is not fetched');
    r = await call('DELETE', `/api/clients/${cl.id}/intel`); r = await call('GET', '/api/state'); assert(!r.json.clients.find(c => c.id === cl.id).intel); ok('result can be cleared');

    /* ---- images ---- */
    const it = byType('ad'); r = await call('POST', `/api/items/${it.id}/image/prompt`, {}); assert.equal(r.status, 200); assert(r.json.prompt.length > 20); assert.equal(r.json.aspect, '1:1');
    r = await call('POST', `/api/items/${it.id}/image/generate`, { prompt: '' }); assert.equal(r.status, 400);
    r = await call('POST', `/api/items/${it.id}/image/generate`, { prompt: r.json && 'A cup of coffee on a wooden table' }); r = await call('POST', `/api/items/${it.id}/image/generate`, { prompt: 'A cup of coffee on a wooden table' });
    assert.equal(r.status, 200); assert(r.json.data.startsWith('data:image/svg+xml;base64,')); assert.equal(r.json.w, 1080); assert.equal(r.json.demo, true); ok('image prompt is written and a demo image is generated in the right shape');
    r = await call('PUT', `/api/items/${it.id}/image`, { data: 'data:image/png;base64,AAAA' }); assert.equal(r.status, 400);
    r = await call('PUT', `/api/items/${it.id}/image`, { data: jpeg(500000) }); assert.equal(r.status, 413); ok('only small JPEG pictures are accepted');
    r = await call('PUT', `/api/items/${it.id}/image`, { data: jpeg(2000), prompt: 'first' }); assert.equal(r.status, 200); const img1 = r.json.image.id;
    r = await call('GET', `/api/img/${img1}`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg'); assert.equal(r.buf.length, 2000);
    r = await call('GET', `/api/img/${img1}`, undefined, { anon: true }); assert.equal(r.status, 401); ok('an image is saved with the item and only served to a signed-in user');
    await call('POST', `/api/items/${it.id}/send`, {});
    r = await call('GET', `/r/${cl.token}/data`, undefined, { anon: true }); const pi = r.json.items.find(i => i.id === it.id); assert.equal(pi.image, img1);
    r = await call('GET', `/r/${cl.token}/img/${img1}`, undefined, { anon: true }); assert.equal(r.status, 200); assert.equal(r.buf.length, 2000);
    r = await call('GET', `/r/wrong-token/img/${img1}`, undefined, { anon: true }); assert.equal(r.status, 404); ok('the client sees the image that was sent, and nobody else can fetch it');
    r = await call('PUT', `/api/items/${it.id}/image`, { data: jpeg(3000), prompt: 'second' }); const img2 = r.json.image.id;
    r = await call('GET', `/r/${cl.token}/img/${img1}`, undefined, { anon: true }); assert.equal(r.status, 200);
    r = await call('GET', `/r/${cl.token}/img/${img2}`, undefined, { anon: true }); assert.equal(r.status, 404); ok('a new image stays private until the item is sent again; the client keeps seeing the old one');
    await call('POST', `/r/${cl.token}/changes/${it.id}`, { name: 'Asha', text: 'Make it warmer' }, { anon: true });
    r = await call('POST', `/api/items/${it.id}/resend`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('GET', `/r/${cl.token}/img/${img2}`, undefined, { anon: true }); assert.equal(r.status, 200);
    r = await call('GET', `/api/img/${img1}`); assert.equal(r.status, 404); ok('after sending again the client sees the new image and the old one is cleaned up');
    r = await call('DELETE', `/api/items/${it.id}/image`); assert.equal(r.json.image, null);
    r = await call('DELETE', `/api/items/${it.id}`); r = await call('GET', `/api/img/${img2}`); assert.equal(r.status, 404); ok('deleting an item deletes its images');
    r = await call('GET', '/api/state'); assert.equal(r.json.config.image, 'demo'); assert.equal(r.json.config.voice, 'demo');

    /* ---- voice notes ---- */
    const tok = cl.token, blog = byType('blog');
    await call('POST', `/api/items/${blog.id}/send`, {});
    r = await call('POST', `/r/bad/transcribe`, { audio: wav() }, { anon: true }); assert.equal(r.status, 404);
    r = await call('POST', `/r/${tok}/transcribe`, { audio: 'abc' }, { anon: true }); assert.equal(r.status, 400);
    r = await call('POST', `/r/${tok}/transcribe`, { audio: Buffer.from('not a wav file at all '.repeat(20)).toString('base64') }, { anon: true }); assert.equal(r.status, 400); ok('voice upload rejects bad links and files that are not audio');
    r = await call('POST', `/r/${tok}/transcribe`, { audio: wav(), lang: 'ml' }, { anon: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert(/[ഀ-ൿ]/.test(r.json.text), 'Malayalam text expected'); assert(r.json.en.includes('shorter')); const voice = r.json; ok('a Malayalam voice note comes back as Malayalam text plus an English version');
    r = await call('GET', `/r/${tok}/data`, undefined, { anon: true }); assert.equal(r.json.voice, true);
    r = await call('POST', `/r/${tok}/changes/${blog.id}`, { name: 'Asha', text: voice.text, en: voice.en, voice: true }, { anon: true }); assert.equal(r.status, 200);
    r = await call('GET', '/api/state'); const cm = r.json.comments.find(c => c.itemId === blog.id && c.kind === 'change');
    assert.equal(cm.text, voice.text); assert.equal(cm.en, voice.en); assert.equal(cm.voice, true); ok('the comment keeps the original words, the English version and a voice-note flag');
    await call('PUT', `/api/comments/${cm.id}`, { triage: 'accepted' });
    r = await call('POST', `/api/items/${blog.id}/apply`, {}); assert.equal(r.status, 200);
    assert(r.json.content.body.includes('shorter'), 'AI should be given the English version'); ok('AI revision uses the English version of the comment');
    r = await call('GET', `/r/${tok}/data`, undefined, { anon: true }); assert(r.json.items.find(i => i.id === blog.id).comments.some(c => c.text === voice.text)); ok('the client sees their own words in the thread');

    console.log('\nAll ' + n + ' feature checks passed.');
    a.child.kill(); strict.child.kill(); site.close(); process.exit(0);
  } catch (e) { console.error('\nFAILED after ' + n + ' checks:', e && e.stack || e); a.child.kill(); strict.child.kill(); process.exit(1); }
})();
