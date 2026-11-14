'use strict';
/* Checks the full brand guidelines, the social media image prompts, and the Studio (free-form posts and carousels).
   Uses a fake website, a fake AI and fake image services on this machine. Usage: node test-studio.js  (or M1_PGLITE=1 node test-studio.js) */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);
const SITE = 3511, AI = 3512, IMG = 3513;
const jpgBuf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1200, 5)]);
const upload = len => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(len, 9)]).toString('base64');
const HOME = `<!doctype html><html><head><title>Oak &amp; Ember</title><meta name="description" content="Handmade furniture from Jaipur."><meta name="theme-color" content="#1B2A49"><link rel="stylesheet" href="/site.css"></head>
<body><h1>Handmade furniture</h1><p>We build solid wood tables and chairs in Jaipur, one order at a time, with a five year promise on every joint.</p><a href="/about">About us</a> <a href="/services">Our services</a></body></html>`;
const ABOUT = `<html><head><title>About</title></head><body><h1>Our story</h1><p>Founded by two carpenters who believed furniture should outlast its owners. MARKER-ABOUT-TEXT is how we describe it.</p></body></html>`;
const SERV = `<html><head><title>Services</title></head><body><h1>Services</h1><p>Custom dining tables, restoration and delivery across India. MARKER-SERVICES-TEXT sits here for the test.</p></body></html>`;
const CSS = `:root{--brand-primary:#1B2A49;--accent:#E8A33D} body{background:#F6F1E7;color:#1B2A49;font-family:'Playfair Display',serif}`;
const site = http.createServer((req, res) => {
  const send = (t, b) => { res.writeHead(200, { 'content-type': t }); res.end(b); };
  if (req.url === '/') return send('text/html', HOME); if (req.url === '/about') return send('text/html', ABOUT); if (req.url === '/services') return send('text/html', SERV);
  if (req.url === '/site.css') return send('text/css', CSS); res.writeHead(404); res.end('no');
});
let seen = [];
const ai = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const b = raw ? JSON.parse(raw) : {}; let text = '', images = 0;
    const c = b.messages[0].content; if (Array.isArray(c)) { images = c.filter(x => x.type === 'image').length; text = c.filter(x => x.type === 'text').map(x => x.text).join(''); } else text = c;
    seen.push({ text, images }); let out;
    if (text.includes('brand guidelines from what was read')) out = { colors: [{ hex: '#1B2A49', name: 'deep navy', role: 'primary', pantone: 'Pantone 2767 C' }, { hex: '#F6F1E7', name: 'warm cream', role: 'background', pantone: 'x'.repeat(80) }, { hex: '#E8A33D', name: 'warm amber', role: 'accent' }], fonts: ['Playfair Display'], style: 'Warm and solid.', imagery: 'Workshop light.', avoid: 'Neon.', summary: 'Navy and amber on cream.',
      guide: { strategy: { story: 'Two carpenters. ' + 'long '.repeat(300), mission: 'Furniture that outlasts owners.', tone: 'Plain, warm', voiceDos: ['Be direct', 'Use craft words'], voiceDonts: 'No hype' }, logo: { clearSpace: 'Height of the O on all sides' }, imagery: { photography: 'Window light on wood grain', icons: 'Thin line icons' }, governance: { aiRules: 'No people look-alikes' }, basis: { strategy: 'found', logo: 'recommended', typography: 'made up', imagery: 'inferred' } } };
    else if (text.includes('structured prompt for an AI image generator')) out = { prompt: 'Oak table by a window in warm light', style: 'editorial', composition: 'table at the right third', lighting: 'window light', color_palette: 'deep navy, warm amber', camera: '50mm', characters: [], negative_prompt: 'clutter' };
    else if (text.includes('reference social media posts')) out = { notes: 'REFNOTES: big headline on the left, grainy film look' };
    else if (text.includes('on-image words and the caption')) { const m = /exactly (\d+) objects/.exec(text), k = m ? +m[1] : 1; out = { slides: Array.from({ length: k }, (x, i) => ({ role: i === 0 ? 'cover' : i === k - 1 && k > 1 ? 'cta' : 'content', headline: 'Headline ' + (i + 1), body: 'Body ' + (i + 1) })), caption: 'CAPTION from AI', hashtags: ['#oak', '#wood'] }; }
    else out = { ok: 1 };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
  });
});
let imgReqs = [];
const img = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw); } catch (e) { /* multipart */ }
    imgReqs.push({ url: req.url, size: b.size, parts: b.contents ? b.contents[0].parts : null, ct: req.headers['content-type'] || '', len: raw.length });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('interactions')) return res.end(JSON.stringify({ outputs: [{ type: 'image', mime_type: 'image/jpeg', data: jpgBuf.toString('base64') }] }));
    if (req.url.includes('generateContent')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpgBuf.toString('base64') } }] } }] }));
    res.end(JSON.stringify({ data: [{ b64_json: jpgBuf.toString('base64') }] }));
  });
});
async function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1s-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '', IG_ACCESS_TOKEN: '', M1_ALLOW_LOCAL_FETCH: '1' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 80 && !log.includes('running'); i++) await sleep(100);
  assert(log.includes('running'), 'server did not start: ' + log);
  let cookie = '';
  const call = async (m, p, b) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const raw = async p => fetch('http://127.0.0.1:' + port + p, { headers: { cookie, 'x-m1': '1' } });
  let st = 0; for (let i = 0; i < 60 && st !== 200; i++) { st = (await call('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' })).status; if (st !== 200) await sleep(250); }
  assert.equal(st, 200);
  return { child, call, raw };
}
(async () => {
  await Promise.all([[site, SITE], [ai, AI], [img, IMG]].map(([s, p]) => new Promise(r => s.listen(p, r))));
  const demo = await start(3521, {});
  const aiEnv = { AI_MODE: '', AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_BASE_URL: 'http://127.0.0.1:' + AI };
  const gem = await start(3522, Object.assign({}, aiEnv, { IMAGE_PROVIDER: 'gemini', IMAGE_API_KEY: 'g', IMAGE_MODEL: 'm', IMAGE_BASE_URL: 'http://127.0.0.1:' + IMG }));
  const oai = await start(3523, Object.assign({}, aiEnv, { IMAGE_PROVIDER: 'openai', IMAGE_API_KEY: 'o', IMAGE_MODEL: 'gpt-image-1', IMAGE_BASE_URL: 'http://127.0.0.1:' + IMG }));
  try {
    /* ---- 1. guidelines in demo mode ---- */
    let r = await demo.call('POST', '/api/clients', { name: 'Oak & Ember', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'], industry: 'Furniture' }); const dcid = r.json.id;
    r = await demo.call('POST', `/api/clients/${dcid}/design/scan`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); let d = r.json.design;
    assert(d.guide && ['strategy', 'logo', 'typography', 'imagery', 'governance'].every(k => d.guide[k] && d.guide.basis[k] === 'demo'), JSON.stringify(d.guide && d.guide.basis));
    assert(/3 pages|text read from 3/.test(d.sources[0].note), d.sources[0].note); ok('a scan produces all five guideline sections, labelled as demo when no AI is connected, and reads the home, about and services pages');
    const navy = d.colors.find(c => c.hex === '#1B2A49'); assert.deepEqual(navy.rgb, [27, 42, 73]); assert.deepEqual(navy.cmyk, [63, 42, 0, 71]);
    ok('every colour carries RGB and CMYK values worked out from its hex code');
    const pair = d.contrast.find(x => x.fg === '#1B2A49' && x.bg === '#F6F1E7') || d.contrast.find(x => x.bg === '#1B2A49' || x.fg === '#1B2A49');
    assert(d.contrast.length && d.contrast.every(x => x.ratio >= 3) && d.contrast.some(x => x.aa), JSON.stringify(d.contrast)); assert(d.contrast.find(x => (x.fg === '#1B2A49' && x.bg === '#FFFFFF') || (x.bg === '#1B2A49' && x.fg === '#FFFFFF')).ratio > 12, 'navy on white is about 14:1');
    ok('contrast checks between brand colours are calculated, not guessed (navy on white is above 12:1)');

    /* ---- 2. guidelines with an AI ---- */
    const L = gem.call; seen = [];
    r = await L('POST', '/api/clients', { name: 'Oak & Ember', website: `http://127.0.0.1:${SITE}/`, platforms: ['Instagram'], industry: 'Furniture', voice: 'Plain and warm', audience: 'Home owners' }); const cid = r.json.id;
    r = await L('POST', `/api/clients/${cid}/design/scan`, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); d = r.json.design;
    const sent = seen.find(s => s.text.includes('brand guidelines from what was read')).text;
    assert(sent.includes('MARKER-ABOUT-TEXT') && sent.includes('MARKER-SERVICES-TEXT'), 'about and services text reach the AI'); ok('the AI is given the text of the about and services pages as well as the home page');
    assert(d.guide.strategy.story.length <= 900 && d.guide.strategy.mission.startsWith('Furniture') && d.guide.strategy.voiceDos === 'Be direct\nUse craft words', JSON.stringify(d.guide.strategy));
    assert.equal(d.guide.basis.strategy, 'found'); assert.equal(d.guide.basis.typography, 'inferred', 'an unknown basis falls back to inferred'); assert.equal(d.guide.basis.logo, 'recommended');
    assert.equal(d.colors[0].pantone, 'Pantone 2767 C'); assert(d.colors[1].pantone.length <= 30); assert.equal(d.colors[2].pantone, '');
    ok('the guidelines are cleaned: long text cut, lists joined, an unknown basis made "inferred", Pantone kept only when given');
    r = await L('PUT', `/api/clients/${cid}/design`, { colors: d.colors, fonts: d.fonts, style: d.style, imagery: d.imagery, avoid: d.avoid, summary: d.summary, guide: Object.assign({}, d.guide, { logo: Object.assign({}, d.guide.logo, { clearSpace: 'EDITED rule' }) }) });
    assert.equal(r.status, 200); assert.equal(r.json.design.guide.logo.clearSpace, 'EDITED rule'); assert.equal(r.json.design.guide.strategy.mission.slice(0, 9), 'Furniture'); assert(r.json.design.contrast.length);
    ok('edits to any guideline field are saved, and the contrast checks are recalculated');

    /* ---- 3. studio basics (demo) ---- */
    const st = demo.call;
    r = await st('POST', '/api/studio', { clientId: dcid, kind: 'carousel', slides: 5, aspect: '1:1', title: 'Five tips' }); assert.equal(r.status, 200); let doc = r.json;
    assert.equal(doc.slides.length, 5); assert.equal(doc.aspect, '1:1'); assert.deepEqual(doc.slides.map(s => s.role), ['cover', 'content', 'content', 'content', 'cta']); assert.equal(doc.slides[0].layout, 'full'); assert.equal(doc.slides[4].layout, 'cta');
    ok('a carousel starts with a cover, content slides and a closing slide, each with a sensible layout');
    r = await st('POST', '/api/studio', { clientId: dcid, kind: 'post' }); assert.equal(r.json.slides.length, 1); const postId = r.json.id; assert.equal(r.json.aspect, '4:5');
    r = await st('PUT', `/api/studio/${postId}`, { slides: [{ id: r.json.slides[0].id, headline: 'One' }, { headline: 'Two' }] }); assert.equal(r.json.slides.length, 1); ok('a single post cannot grow extra slides');
    r = await st('POST', '/api/studio', { clientId: 'nope', kind: 'post' }); assert.equal(r.status, 404);
    const ids = doc.slides.map(s => s.id);
    r = await st('PUT', `/api/studio/${doc.id}`, { slides: [{ id: ids[2], headline: 'Moved up', layout: 'quote', bg: '#e8a33d', fg: 'dark', size: 'l', align: 'center' }, { id: ids[0], layout: 'bogus', fg: 'neon' }, { headline: 'Brand new', body: 'b' }, { id: ids[4] }] });
    doc = r.json; assert.deepEqual(doc.slides.map(s => s.headline), ['Moved up', '', 'Brand new', '']); assert.equal(doc.slides[0].id, ids[2]); assert.equal(doc.slides[0].layout, 'quote'); assert.equal(doc.slides[0].bg, '#E8A33D'); assert.equal(doc.slides[0].size, 'l');
    assert.equal(doc.slides[1].layout, 'full', 'unknown layout keeps the old one'); assert.equal(doc.slides[1].fg, 'auto', 'unknown text colour falls back'); assert(!doc.slides.some(s => s.id === ids[1] || s.id === ids[3]));
    ok('slides can be reordered, added, removed and restyled; unknown layouts and colours are ignored');
    r = await st('PUT', `/api/studio/${doc.id}`, { slides: [] }); assert.equal(r.status, 400);
    r = await st('POST', `/api/studio/${doc.id}/plan`, { topic: 'Why solid wood lasts', count: 4 }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.slides.length, 4); assert(/solid wood/i.test(r.json.slides[0].headline) && r.json.caption);
    assert.equal(r.json.slides[0].layout, 'quote', 'existing slides keep their layout when the words are rewritten'); assert.equal(r.json.slides[3].layout, 'cta'); ok('planning writes the words for every slide and the caption, and keeps layouts that already exist');
    r = await st('GET', '/api/state'); const sm = r.json.studio.find(x => x.id === doc.id); assert(sm && sm.n === 4 && !sm.slides && sm.title === 'Five tips'); ok('the app state carries only a light summary of each design');
    r = await st('GET', `/api/studio/${doc.id}`); assert.equal(r.json.slides.length, 4);

    /* ---- 4. prompts with a real AI ---- */
    r = await L('POST', '/api/studio', { clientId: cid, kind: 'carousel', slides: 3, aspect: '4:5', topic: 'Why solid wood lasts' }); let ld = r.json;
    r = await L('POST', `/api/studio/${ld.id}/plan`, { topic: 'Why solid wood lasts', count: 3 }); ld = r.json; assert.equal(ld.slides[0].headline, 'Headline 1'); assert.equal(ld.caption, 'CAPTION from AI'); assert.equal(ld.hashtags, '#oak #wood');
    const planSent = seen.filter(s => s.text.includes('on-image words and the caption')).pop().text; assert(planSent.includes('BRAND GUIDELINES') && planSent.includes('Plain and warm')); ok('the copy planner is given the brief and the guidelines');
    seen = []; r = await L('POST', `/api/studio/${ld.id}/slides/${ld.slides[0].id}/prompt`, { direction: 'Make it moody' }); assert.equal(r.status, 200, JSON.stringify(r.json));
    const ps = seen[0].text;
    assert(ps.includes('BRAND GUIDELINES') && ps.includes('deep navy (primary)') && ps.includes('Window light on wood grain') && ps.includes('Thin line icons') && ps.includes('No people look-alikes'), 'guideline sections reach the prompt writer');
    assert(ps.includes('Keep the lower 40% of the frame calm') && ps.includes('Headline 1') && ps.includes('Make it moody') && /no words at all/.test(ps) && /never hex codes/.test(ps) && !/#1B2A49/i.test(ps.split('BRAND GUIDELINES')[1].split('THE CREATIVE')[0]));
    ok('the prompt writer gets the photography, icon and AI rules, the layout\'s text zone, the slide words, the team\'s direction and a ban on text in the picture');
    assert(r.json.prompt.startsWith('Oak table by a window') && /Style: editorial/.test(r.json.prompt) && /Composition: table at the right third/.test(r.json.prompt) && /Colour palette: deep navy, warm amber/.test(r.json.prompt) && /Do not include: clutter, text, letters, numbers, logos, watermarks/.test(r.json.prompt) && /4:5 frame for Instagram/.test(r.json.prompt), r.json.prompt);
    assert.equal(r.json.spec.technical.aspect_ratio, '4:5'); assert(Array.isArray(r.json.spec.characters)); ok('the structured prompt (style, composition, lighting, palette, camera, people, things to avoid, technical) is flattened into one editable text');
    seen = []; r = await L('POST', `/api/studio/${ld.id}/slides/${ld.slides[1].id}/prompt`, {}); assert(seen[0].text.includes('SERIES') && seen[0].text.includes('editorial') && seen[0].text.includes('content (slide 2 of 3)')); ok('later slides are told to keep the look of the first, so a carousel stays consistent');

    /* ---- 5. references ---- */
    r = await L('POST', `/api/studio/${ld.id}/refs`, { data: upload(900) }); assert.equal(r.status, 200); assert.equal(r.json.refs.length, 1); const ref1 = r.json.refs[0];
    r = await L('POST', `/api/studio/${ld.id}/refs`, { data: 'data:image/png;base64,AAAA' }); assert.equal(r.status, 400);
    r = await L('POST', `/api/studio/${ld.id}/refs`, { data: upload(900) }); r = await L('POST', `/api/studio/${ld.id}/refs`, { data: upload(900) }); r = await L('POST', `/api/studio/${ld.id}/refs`, { data: upload(900) }); assert.equal(r.status, 400); assert.equal((await L('GET', `/api/studio/${ld.id}`)).json.refs.length, 3); ok('up to three reference pictures can be added; other formats are refused');
    seen = []; r = await L('POST', `/api/studio/${ld.id}/slides/${ld.slides[2].id}/prompt`, {});
    const vis = seen.find(s => s.text.includes('reference social media posts')); assert(vis && vis.images === 3, 'the references are shown to the AI'); const ps2 = seen.find(s => s.text.includes('structured prompt for an AI image generator')).text; assert(ps2.includes('REFNOTES: big headline on the left')); assert(/\[Image 1\], \[Image 2\], \[Image 3\]/.test(r.json.prompt)); ok('reference pictures are described once by the AI, and the notes plus [Image N] pointers go into the prompt');
    seen = []; await L('POST', `/api/studio/${ld.id}/slides/${ld.slides[0].id}/prompt`, {}); assert(!seen.some(s => s.text.includes('reference social media posts')), 'notes are kept, not re-read every time'); ok('the reference notes are saved, so they are not paid for again on every prompt');
    r = await L('DELETE', `/api/studio/${ld.id}/refs/${ref1}`); assert.equal(r.json.refs.length, 2); assert.equal((await gem.raw('/api/img/' + ref1)).status, 404); ok('removing a reference deletes its picture');

    /* ---- 6. image services get the references ---- */
    imgReqs = []; r = await L('POST', `/api/studio/${ld.id}/slides/${ld.slides[0].id}/generate`, { prompt: 'a table' }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.refs, 2);
    assert(imgReqs[0].url.includes('generateContent') && imgReqs[0].parts.length === 3 && imgReqs[0].parts.slice(1).every(p => p.inline_data && p.inline_data.mime_type === 'image/jpeg'), JSON.stringify(imgReqs[0].parts && imgReqs[0].parts.map(p => Object.keys(p))));
    ok('Gemini receives the prompt plus each reference picture as an image part');
    const g2 = (await L('POST', '/api/studio', { clientId: cid, kind: 'post' })).json; imgReqs = []; r = await L('POST', `/api/studio/${g2.id}/slides/${g2.slides[0].id}/generate`, { prompt: 'a table' }); assert(imgReqs[0].url.includes('interactions') && r.json.refs === 0); ok('with no references Gemini uses the normal route');
    r = await L('POST', `/api/studio/${g2.id}/slides/${g2.slides[0].id}/generate`, { prompt: '' }); assert.equal(r.status, 400);
    const o1 = (await oai.call('POST', '/api/clients', { name: 'X', platforms: ['Instagram'] })).json.id, od = (await oai.call('POST', '/api/studio', { clientId: o1, kind: 'post', aspect: '4:5' })).json;
    imgReqs = []; r = await oai.call('POST', `/api/studio/${od.id}/slides/${od.slides[0].id}/generate`, { prompt: 'a table' }); assert(imgReqs[0].url.includes('/images/generations') && r.status === 200 && imgReqs[0].size === '1024x1536', JSON.stringify(imgReqs[0])); ok('OpenAI-style services get a portrait size for 4:5 posts');
    await oai.call('POST', `/api/studio/${od.id}/refs`, { data: upload(900) }); imgReqs = []; r = await oai.call('POST', `/api/studio/${od.id}/slides/${od.slides[0].id}/generate`, { prompt: 'a table' }); assert(r.status === 200 && /multipart\/form-data/.test(imgReqs[0].ct) && imgReqs[0].url.includes('/images/edits'), JSON.stringify(imgReqs[0])); ok('OpenAI-style services get the reference pictures through the edits route');

    /* ---- 7. artwork ---- */
    const sid = ld.slides[0].id;
    r = await L('PUT', `/api/studio/${ld.id}/slides/${sid}/art`, { data: upload(900), prompt: 'p1', source: 'ai' }); assert.equal(r.status, 200); const art1 = r.json.slides[0].art; assert((await gem.raw('/api/img/' + art1)).status === 200);
    r = await L('PUT', `/api/studio/${ld.id}/slides/${sid}/art`, { data: upload(900) }); const art2 = r.json.slides[0].art; assert.notEqual(art1, art2); assert.equal((await gem.raw('/api/img/' + art1)).status, 404); ok('replacing a slide\'s picture deletes the old one');
    r = await L('PUT', `/api/studio/${ld.id}/slides/${sid}/art`, { data: 'data:image/jpeg;base64,AAAA' }); assert.equal(r.status, 400);
    r = await L('PUT', `/api/studio/${ld.id}/slides/${sid}/art`, { data: upload(460000) }); assert.equal(r.status, 413); ok('pictures that are not valid or too large are refused');
    r = await L('PUT', `/api/studio/${ld.id}`, { slides: ld.slides.slice(1).map(s => ({ id: s.id })) }); assert.equal(r.json.slides.length, 2); assert.equal((await gem.raw('/api/img/' + art2)).status, 404); ok('removing a slide deletes its picture');
    const keep = (await L('PUT', `/api/studio/${ld.id}/slides/${ld.slides[1].id}/art`, { data: upload(900) })).json.slides[0].art;
    r = await L('DELETE', `/api/clients/${cid}`); assert.equal(r.status, 200); assert.equal((await L('GET', `/api/studio/${ld.id}`)).status, 404); assert.equal((await gem.raw('/api/img/' + keep)).status, 404); ok('deleting a client deletes its designs and their pictures');

    /* ---- 8. other things ---- */
    const ex = await (await demo.raw('/api/export')).json(); assert(Array.isArray(ex.studio) && ex.studio.length >= 2); ok('the backup file includes the studio designs');
    r = await gem.call('POST', '/api/clients', { name: 'Y', platforms: ['Instagram'], website: `http://127.0.0.1:${SITE}/` }); const yc = r.json.id; await gem.call('POST', `/api/clients/${yc}/design/scan`, {});
    r = await gem.call('POST', '/api/items', { clientId: yc, date: '2026-11-09', platform: 'Instagram', type: 'post', topic: 'Oak table' }); seen = [];
    r = await gem.call('POST', `/api/items/${r.json.id}/image/prompt`, {}); assert.equal(r.status, 200); assert(/Style: editorial/.test(r.json.prompt) && r.json.spec && /Do not include/.test(r.json.prompt)); assert(seen[0].text.includes('structured prompt')); ok('the image section inside each calendar item now uses the same structured, brand-aware prompt writer');
  } finally { [demo, gem, oai].forEach(x => x.child.kill()); site.close(); ai.close(); img.close(); }
  console.log('\nAll ' + n + ' studio checks passed.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
