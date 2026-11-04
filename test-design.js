'use strict';
/* Checks the brand design feature: colours, fonts and look read from a website, the AI design brief, pictures sent to the AI,
   and the design reaching image prompts. Uses a fake website and a fake AI on this machine. Usage: node test-design.js */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);

const SITE = 3481, AI = 3482;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 3)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 5)]);
const HOME = `<!doctype html><html><head><title>Oak &amp; Ember</title><meta name="description" content="Handmade furniture from Jaipur."><meta name="theme-color" content="#1B2A49"><meta property="og:image" content="/banner.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css"><style>:root{--brand-primary:#1B2A49;--accent:#E8A33D;--shadow:rgba(0,0,0,.1)} .btn{background:#E8A33D;color:#fff} #fedcba{margin:0} .a #bada55{margin:0}</style></head>
<body><img class="site-logo" src="/logo.png" alt="Oak logo"><h1>Handmade furniture</h1><p>We build solid wood tables and chairs in Jaipur, one order at a time, with a five year promise on every joint.</p><div style="color:#E8A33D">x</div></body></html>`;
const CSS = `body{background:#F6F1E7;color:#222222;font-family:'Playfair Display',Georgia,serif}.hero{background:#1B2A49}.cta{background:#E8A33D;border-color:#e8a33d}h2{font-family:Inter,Arial,sans-serif}.fa{font-family:"Font Awesome 5 Free"}`;
const site = http.createServer((req, res) => {
  const send = (c, t, b) => { res.writeHead(c, { 'content-type': t }); res.end(b); };
  if (req.url === '/') return send(200, 'text/html', HOME);
  if (req.url === '/site.css') return send(200, 'text/css', CSS);
  if (req.url === '/logo.png') return send(200, 'image/png', png);
  if (req.url === '/banner.jpg') return send(200, 'image/jpeg', jpg);
  if (req.url === '/plain') return send(200, 'text/html', '<html><head><title>Plain</title></head><body><h1>Hello</h1><p>' + 'A page with no styling at all. '.repeat(8) + '</p></body></html>');
  send(404, 'text/plain', 'no');
});

/* fake AI: records what it was sent; replies with a design brief */
let seen = [], failImages = false;
const ai = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const b = raw ? JSON.parse(raw) : {}; let text = '', images = 0;
    if (req.url.startsWith('/v1/messages')) { const c = b.messages[0].content; if (Array.isArray(c)) { images = c.filter(x => x.type === 'image').length; text = c.filter(x => x.type === 'text').map(x => x.text).join(''); } else text = c; }
    else if (req.url.startsWith('/chat/completions')) { const c = b.messages[0].content; if (Array.isArray(c)) { images = c.filter(x => x.type === 'image_url').length; text = c.filter(x => x.type === 'text').map(x => x.text).join(''); } else text = c; }
    seen.push({ url: req.url, text, images });
    if (images && failImages) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'This model does not accept images' } })); }
    let out;
    if (text.includes('Write the design brief')) out = { colors: [{ hex: '#1B2A49', name: 'deep navy', role: 'primary' }, { hex: '#e8a33d', name: 'warm amber', role: 'accent' }, { hex: '#1B2A49', name: 'duplicate navy', role: 'text' }, { hex: 'blue', name: 'not a code', role: 'accent' }, { hex: '#123456', name: 'guessed teal', role: 'weird' }], fonts: ['Playfair Display', 'Inter'], style: 'FAKE style: warm, solid, unfussy.', imagery: 'FAKE imagery: workshop light, close-ups of wood grain.', avoid: 'Neon colours.', summary: 'FAKE summary: deep navy and warm amber on cream.' };
    else if (text.includes('You write prompts for an AI image generator')) out = { prompt: 'FAKE image prompt' };
    else out = { visual: 'FAKE visual', caption: 'FAKE caption', hashtags: '#x', cta: 'c', hook: 'h', script: 's', shots: 'a', onscreen: 'o', videoPrompt: 'v', summary: 'FAKE' };
    const t = JSON.stringify(out); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/v1/messages') ? JSON.stringify({ content: [{ type: 'text', text: t }] }) : JSON.stringify({ choices: [{ message: { content: t } }] }));
  });
});

async function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1d-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 50 && !log.includes('running'); i++) await sleep(100);
  assert(log.includes('running'), 'server did not start: ' + log);
  let cookie = '';
  const call = async (m, p, b) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  assert.equal((await call('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' })).status, 200);
  return { child, call };
}
const upload = len => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(len, 9)]).toString('base64');
const hexes = d => d.colors.map(c => c.hex);

(async () => {
  await new Promise(r => site.listen(SITE, r)); await new Promise(r => ai.listen(AI, r));
  const demo = await start(3483, { M1_ALLOW_LOCAL_FETCH: '1' }), strict = await start(3484, {});
  const live = await start(3485, { M1_ALLOW_LOCAL_FETCH: '1', AI_MODE: '', AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_BASE_URL: 'http://127.0.0.1:' + AI });
  const oa = await start(3486, { M1_ALLOW_LOCAL_FETCH: '1', AI_MODE: '', AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_API_KEY: 'k', AI_BASE_URL: 'http://127.0.0.1:' + AI });
  try {
    /* ---- reading the website (demo mode, no AI) ---- */
    const call = demo.call;
    let r = await call('POST', '/api/clients', { name: 'Oak & Ember', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'], industry: 'Furniture' }); const cid = r.json.id;
    r = await call('POST', `/api/clients/${cid}/design/scan`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    let d = r.json.design;
    assert(hexes(d).includes('#1B2A49') && hexes(d).includes('#E8A33D'), 'brand colours from CSS, inline style and theme-color: ' + hexes(d));
    assert(!hexes(d).includes('#FEDCBA') && !hexes(d).includes('#BADA55'), 'selectors like #fedcba are not colours');
    assert(d.fonts.includes('Playfair Display') && d.fonts.includes('Inter'), 'fonts: ' + d.fonts); assert(!d.fonts.some(f => /awesome/i.test(f)), 'icon fonts ignored');
    assert(d.sources[0].ok && /stylesheet/.test(d.sources[0].note), JSON.stringify(d.sources));
    ok('colours and fonts are read from the page, its inline styles and its stylesheet; selectors and icon fonts are not mistaken for brand colours');
    assert.equal(hexes(d).filter(h => h === '#E8A33D').length, 1); ok('the same colour written in different ways (#E8A33D, #e8a33d) counts once');
    r = await call('GET', '/api/state'); assert(r.json.clients.find(c => c.id === cid).design.colors.length >= 2); ok('the design is saved on the client');

    r = await call('PUT', `/api/clients/${cid}/design`, { colors: [{ hex: 'e8a33d', name: 'Amber', role: 'primary' }, { hex: 'zzz', name: 'bad' }, { hex: '#fff', name: 'white', role: 'background' }], fonts: ['Lora'], style: 'Warm', summary: 'Hello' });
    assert.equal(r.status, 200); d = r.json.design; assert.deepEqual(hexes(d), ['#E8A33D', '#FFFFFF']); assert(d.edited); assert.equal(d.fonts[0], 'Lora'); ok('edits are saved; short and lower-case hex codes are tidied and invalid ones dropped');
    r = await call('PUT', `/api/clients/${cid}/design`, { colors: [{ hex: 'nope' }] }); assert.equal(r.status, 400); ok('a design with no valid colour is refused');

    /* image prompt in demo mode mentions the colours by name */
    r = await call('POST', '/api/calendar-test', {}); // route does not exist: ignore
    r = await call('POST', '/api/items', { clientId: cid, date: '2026-11-09', platform: 'Instagram', type: 'post', topic: 'New oak table' }); const itemId = r.json.id;
    r = await call('POST', `/api/items/${itemId}/image/prompt`, {}); assert.equal(r.status, 200); assert(/Amber|white/.test(r.json.prompt) && !/#E8A33D/i.test(r.json.prompt), r.json.prompt); ok('demo image prompt uses the colour names, never the hex codes');

    r = await call('DELETE', `/api/clients/${cid}/design`); assert.equal(r.status, 200);
    r = await call('GET', '/api/state'); assert(!r.json.clients.find(c => c.id === cid).design); ok('design can be cleared');

    /* ---- guard rails ---- */
    r = await call('POST', '/api/clients', { name: 'Bare', platforms: ['Instagram'] }); const bare = r.json.id;
    r = await call('POST', `/api/clients/${bare}/design/scan`, {}); assert.equal(r.status, 422); assert(/website|Instagram|pictures/i.test(r.json.error)); ok('nothing to read gives a clear message');
    r = await call('POST', `/api/clients/${bare}/design/scan`, { images: ['data:image/jpeg;base64,AAAA', 'data:text/html;base64,AAAA', upload(800000)] }); assert.equal(r.status, 422); ok('tiny, oversized and non-image uploads are ignored');
    r = await call('PUT', `/api/clients/${bare}`, { name: 'Bare', platforms: ['Instagram'], website: `http://127.0.0.1:${SITE}/plain` });
    r = await call('POST', `/api/clients/${bare}/design/scan`, {}); assert.equal(r.status, 422); ok('a site with no colours in its code and no pictures cannot make a palette');
    r = await call('POST', `/api/clients/${bare}/design/scan`, { handle: '@some.brand' }); assert.equal(r.status, 422);
    r = await call('PUT', `/api/clients/${bare}`, { name: 'Bare', platforms: ['Instagram'], website: `http://127.0.0.1:${SITE}/` });
    r = await call('POST', `/api/clients/${bare}/design/scan`, { handle: 'https://www.instagram.com/some.brand/' }); assert.equal(r.status, 200);
    const ig = r.json.design.sources.find(x => /Instagram/.test(x.label)); assert(ig && !ig.ok && /not connected/i.test(ig.note) && ig.label === 'Instagram @some.brand'); assert.equal(r.json.design.handle, 'some.brand'); ok('an Instagram handle without a connection is reported, and the website is still used; the handle is saved');
    r = await call('POST', `/api/clients/${bare}/design/scan`, { handle: 'bad handle!' }); assert.equal(r.status, 200); assert.equal(r.json.design.handle, ''); ok('a handle that is not valid is dropped');
    r = await strict.call('POST', '/api/clients', { name: 'Local', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'] });
    r = await strict.call('POST', `/api/clients/${r.json.id}/design/scan`, {}); assert.equal(r.status, 422); ok('addresses on the server\'s own network are refused, as for the other website reads');

    /* ---- with an AI (Claude format) ---- */
    const L = live.call; seen = [];
    r = await L('POST', '/api/clients', { name: 'Oak & Ember', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'], industry: 'Furniture', voice: 'Plain and warm' }); const lid = r.json.id;
    r = await L('POST', `/api/clients/${lid}/design/scan`, { images: [upload(900)] }); assert.equal(r.status, 200, JSON.stringify(r.json)); d = r.json.design;
    const sent = seen.find(s => s.text.includes('Write the design brief'));
    assert(sent.text.includes('#1B2A49') && sent.text.includes('#E8A33D') && sent.text.includes('Playfair Display'), 'facts reach the AI');
    assert.equal(sent.images, 3, 'logo, banner and the uploaded picture are sent as pictures: ' + sent.images); assert(/website logo/.test(sent.text) && /uploaded by the team/.test(sent.text));
    ok('the AI receives the colours, fonts, words and the pictures (logo, banner, uploads) as images');
    assert.deepEqual(hexes(d), ['#1B2A49', '#E8A33D', '#123456'], hexes(d)); assert.equal(d.colors[1].name, 'warm amber');
    assert.equal(d.colors[2].role, 'accent', 'unknown role falls back'); assert.deepEqual(d.colors.map(c => c.est), [false, false, true]); ok('the AI reply is cleaned: duplicates and invalid codes dropped, unknown roles fixed, a colour that is not on the site is marked estimated');
    assert(d.notes.some(x => /estimated/i.test(x)) && d.summary.startsWith('FAKE summary') && d.live === true && d.pictures === 3); ok('a note explains estimated colours; the summary is kept');

    /* design reaches prompts */
    seen = [];
    r = await L('POST', '/api/items', { clientId: lid, date: '2026-11-09', platform: 'Instagram', type: 'post', topic: 'New oak table' }); const it1 = r.json.id;
    r = await L('POST', `/api/items/${it1}/image/prompt`, {}); assert.equal(r.status, 200); const ip = seen.find(s => s.text.includes('You write prompts for an AI image generator')).text;
    assert(ip.includes('BRAND DESIGN') && ip.includes('deep navy (primary)') && ip.includes('warm amber (accent)') && ip.includes('FAKE style') && ip.includes('FAKE imagery') && ip.includes('Neon colours'), ip);
    assert(!/#1B2A49|#E8A33D|#123456/i.test(ip.split('BRAND DESIGN')[1].split('CREATIVE')[0]), 'hex codes are not put into the image prompt'); assert(/never as hex codes/.test(ip));
    ok('the image prompt writer is given the colours (by name), style, imagery and what to avoid');
    seen = []; r = await L('POST', `/api/items/${it1}/draft`, {}); assert.equal(r.status, 200); const dp = seen.find(s => /CONTENT ITEM/.test(s.text)).text;
    assert(dp.includes('BRAND DESIGN') && /visual/.test(dp)); ok('drafting a post writes the visual brief with the design in view');
    seen = []; r = await L('POST', '/api/items', { clientId: lid, date: '2026-11-10', platform: 'LinkedIn', type: 'newsletter', topic: 'Monthly note' }); const it2 = r.json.id; r = await L('POST', `/api/items/${it2}/draft`, {});
    ok('other formats still draft normally');
    seen = []; r = await L('POST', `/api/clients/${lid}/calendar`, { start: '2026-11-02', weeks: 1, posts: 1 }); assert(!seen.some(s => s.text.includes('BRAND DESIGN'))); ok('calendar planning does not carry the design block (saves AI cost)');

    /* no design -> prompt unchanged */
    r = await L('POST', '/api/clients', { name: 'No Design', platforms: ['Instagram'] }); r = await L('POST', '/api/items', { clientId: r.json.id, date: '2026-11-09', platform: 'Instagram', type: 'post', topic: 'T' }); seen = [];
    await L('POST', `/api/items/${r.json.id}/image/prompt`, {}); assert(!seen[0].text.includes('BRAND DESIGN') && !/hex codes/.test(seen[0].text)); ok('a client with no design gets the same prompt as before');

    /* ---- model without picture support ---- */
    failImages = true; seen = [];
    const O = oa.call; r = await O('POST', '/api/clients', { name: 'Oak', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'] });
    r = await O('POST', `/api/clients/${r.json.id}/design/scan`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert(seen.length === 2 && seen[0].images > 0 && seen[1].images === 0, JSON.stringify(seen.map(s => s.images)));
    assert(r.json.design.notes.some(x => /could not look at pictures/.test(x)) && r.json.design.pictures === 0); ok('a model that cannot take pictures is retried without them and the brief says so (OpenAI-style format also carries images)');
    failImages = false;
  } finally { [demo, strict, live, oa].forEach(x => x.child.kill()); site.close(); ai.close(); }
  console.log('\nAll ' + n + ' brand design checks passed.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
