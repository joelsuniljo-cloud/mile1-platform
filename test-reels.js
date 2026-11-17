'use strict';
/* Checks the Reels section (MiniMax H3 prompts, video jobs through a fake fal.ai queue), the simple Studio prompts and the client logo.
   Uses a fake AI and a fake fal.ai on this machine. Usage: node test-reels.js  (or M1_PGLITE=1 node test-reels.js) */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);
const AI = 3612, FAL = 3613;
const jpg = len => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(len || 1200, 9)]).toString('base64');
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 1)]).toString('base64');
const GOOD_T2V = 'integrated_multimodal_description: [Shot 1] Warm editorial look, a close vertical frame of an oak table. The camera slowly pushes in. A warm female narrator (S1) says in an off-screen voiceover: <d>[English] Made to last.</d> while no one on screen speaks. [Shot 2] At 00:04.000, the camera cuts to a family at dinner.\n\noverall_soundscape: Cutlery and soft chatter.\n\nnon_diegetic_music: Acoustic guitar at a medium tempo.';
const BAD_T2V = 'A nice video of a table. [Shot 2] At 00:30.000, the end.';
const GOOD_REF = 'subject_definitions:\n<Subject 1> is a teak dining table, drawn from <Picture 1> (Image 1).\n<Subject 2> is the brand logo, drawn from <Picture 2> (Image 2).\n\nsummary:\n[reference generation] A reveal of the table.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - shape and grain.\n<Subject 2> (appears in [Shot 2]): fully_preserved - exact logo.\n\ndetailed_description:\nWarm editorial look.\n[Shot 1] <Subject 1> under a dust sheet that slides away.\n[Shot 2] At 00:05.000, a clean final frame with <Subject 2>.\n\noverall_soundscape:\nFabric sliding.\n\nnon_diegetic_music:\nN/A';
let seen = [], badFirst = false;
const ai = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const b = raw ? JSON.parse(raw) : {}; let text = '', images = 0;
    const c = b.messages[0].content; if (Array.isArray(c)) { images = c.filter(x => x.type === 'image').length; text = c.filter(x => x.type === 'text').map(x => x.text).join(''); } else text = c;
    seen.push({ text, images }); let out;
    if (text.includes('MiniMax H3')) {
      if (text.includes('REFERENCE PICTURES')) out = { prompt: GOOD_REF };
      else if (badFirst && !text.includes('had these problems')) out = { prompt: BAD_T2V };
      else out = { prompt: GOOD_T2V };
    } else if (text.includes('Write the image prompts for')) {
      const m = /(\d+)-slide/.exec(text), k = m ? +m[1] : 1;
      out = { caption: 'CAPTION-X', hashtags: ['#oak', '#table'], slides: Array.from({ length: k }, (x, i) => ({ headline: 'Head ' + (i + 1), prompt: 'Oak table scene ' + (i + 1), style: 'editorial', composition: 'subject right', lighting: 'window light', color_palette: 'navy and amber', camera: '50mm', characters: [], negative_prompt: 'clutter' })) };
    } else if (text.includes('reference social media posts')) out = { notes: 'REFNOTES' };
    else out = { ok: 1 };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
  });
});
const jobs = {}; let subs = [], failNext = false, localVideo = false;
const fal = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/video.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.alloc(5000, 7)); }
    if (req.headers.authorization !== 'Key fk') return send(401, { detail: 'bad key' });
    const m = /^\/minimax\/h3\/requests\/([\w-]+)(\/status)?$/.exec(req.url);
    if (req.method === 'POST') {
      const id = 'job' + (subs.length + 1), body = JSON.parse(raw); subs.push({ url: req.url, body });
      jobs[id] = { polls: 0, fail: failNext, local: localVideo }; failNext = false;
      return send(200, { request_id: id, status_url: `http://127.0.0.1:${FAL}/minimax/h3/requests/${id}/status`, response_url: `http://127.0.0.1:${FAL}/minimax/h3/requests/${id}` });
    }
    if (m && jobs[m[1]]) {
      const j = jobs[m[1]];
      if (m[2]) { j.polls++; return send(200, j.polls < 2 ? { status: 'IN_QUEUE', queue_position: 2 } : j.polls < 3 ? { status: 'IN_PROGRESS' } : { status: 'COMPLETED' }); }
      if (j.fail) return send(422, { detail: [{ msg: 'content flagged by safety checker' }] });
      return send(200, { video: { url: j.local ? `http://127.0.0.1:${FAL}/video.mp4` : 'https://v3.fal.media/files/abc/' + m[1] + '.mp4', content_type: 'video/mp4' } });
    }
    send(404, { detail: 'not found' });
  });
});
async function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1r-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '', IG_ACCESS_TOKEN: '', FAL_KEY: '', VIDEO_API_KEY: '', FAL_BASE_URL: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
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
  await Promise.all([[ai, AI], [fal, FAL]].map(([s, p]) => new Promise(r => s.listen(p, r))));
  const demo = await start(3621, {});
  const live = await start(3622, { AI_MODE: '', AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_BASE_URL: 'http://127.0.0.1:' + AI, FAL_KEY: 'fk', FAL_BASE_URL: 'http://127.0.0.1:' + FAL });
  try {
    let r;
    /* ---- demo mode ---- */
    r = await demo.call('GET', '/api/state'); assert.equal(r.json.config.video, 'demo'); ok('without a fal.ai key the app says video is in demo mode');
    r = await demo.call('POST', '/api/clients', { name: 'Demo Co', platforms: ['Instagram'] }); const dc = r.json.id;
    r = await demo.call('POST', '/api/reels', { clientId: dc, topic: 'A table reveal' }); assert.equal(r.status, 200); const dr = r.json.id;
    assert.equal(r.json.kind, 'reel'); assert.equal(r.json.aspect, '9:16'); assert.equal(r.json.duration, 10); assert.equal(r.json.resolution, '768P'); ok('a new reel starts as a 10 second 9:16 video at 768p');
    r = await demo.call('POST', `/api/reels/${dr}/prompt`, { voice: 'Built to last a lifetime.', duration: 8 }); assert.equal(r.status, 200);
    assert(/^integrated_multimodal_description: \[Shot 1\]/.test(r.json.prompt) && /\n\noverall_soundscape: /.test(r.json.prompt) && /\n\nnon_diegetic_music: /.test(r.json.prompt), r.json.prompt);
    assert(/<d>\[English\] Built to last a lifetime\.<\/d>/.test(r.json.prompt) && /\[Shot 2\] At 00:03\.\d{3},/.test(r.json.prompt)); assert.equal(r.json.duration, 8); assert.deepEqual(r.json.problems, []);
    ok('demo prompt follows the H3 text-to-video layout: sections, [Shot N] At MM:SS.mmm cuts, <d>[English] speech</d>');
    r = await demo.call('POST', `/api/reels/${dr}/make`, {}); assert.equal(r.status, 200); assert.equal(r.json.demo, true); assert(!r.json.job); ok('Make video in demo mode makes no job and says so');
    r = await demo.call('PUT', `/api/studio/${dr}`, { duration: 7, aspect: '4:5', resolution: '4K', music: false }); assert.equal(r.json.duration, 8); assert.equal(r.json.aspect, '9:16'); assert.equal(r.json.resolution, '768P'); assert.equal(r.json.music, false); ok('reel settings only accept supported lengths, shapes and qualities');
    r = await demo.call('GET', '/api/state'); assert(r.json.studio.some(x => x.id === dr && x.kind === 'reel' && x.state === 'draft')); ok('reels are listed with their state');

    /* ---- logo ---- */
    r = await live.call('POST', '/api/clients', { name: 'Oak and Ember', industry: 'Furniture', platforms: ['Instagram'] }); const cl = r.json.id;
    r = await live.call('PUT', `/api/clients/${cl}/logo`, { data: 'data:image/gif;base64,R0lGOD' }); assert.equal(r.status, 400);
    r = await live.call('PUT', `/api/clients/${cl}/logo`, { data: png }); assert.equal(r.status, 200); const logo = r.json.logo;
    let raw = await live.raw('/api/img/' + logo); assert.equal(raw.headers.get('content-type'), 'image/png'); ok('a PNG logo is saved for the client and served as PNG (transparency kept)');
    r = await live.call('PUT', `/api/clients/${cl}/logo`, { data: png }); assert.equal((await live.raw('/api/img/' + logo)).status, 404); const logo2 = r.json.logo; ok('changing the logo deletes the old file');

    /* ---- simple studio ---- */
    r = await live.call('POST', '/api/studio', { clientId: cl, kind: 'post', aspect: '4:5' }); const sp = r.json.id;
    r = await live.call('POST', `/api/studio/${sp}/prompts`, { topic: '' }); assert.equal(r.status, 400);
    seen = [];
    r = await live.call('POST', `/api/studio/${sp}/prompts`, { topic: 'Diwali offer on dining tables', kind: 'carousel', count: 4, logoPos: 'tl', text: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.kind, 'carousel'); assert.equal(r.json.slides.length, 4); assert.equal(r.json.caption, 'CAPTION-X'); assert.equal(r.json.hashtags, '#oak #table');
    assert(seen.length === 1 && /4-slide Instagram carousel/.test(seen[0].text) && /top-left corner/.test(seen[0].text)); ok('one AI call writes the prompts for every slide of a carousel, plus caption and hashtags');
    const p1 = r.json.slides[0].prompt;
    assert(/Text on the image: the headline "Head 1"/.test(p1) && /Keep the top-left corner plain/.test(p1) && /Do not draw any logo/.test(p1) && !/Do not include:.*\btext, letters/.test(p1), p1); ok('with a headline and a logo, the prompt asks for the exact words and leaves the logo corner plain');
    r = await live.call('POST', `/api/studio/${sp}/prompts`, { topic: 'Diwali offer', kind: 'post', text: false, logoPos: 'none' });
    assert.equal(r.json.slides.length, 1); assert(!/Text on the image/.test(r.json.slides[0].prompt) && !/logo is added/.test(r.json.slides[0].prompt) && /text, letters/.test(r.json.slides[0].prompt)); ok('switching to a single post with no headline and no logo gives a clean no-text prompt');
    r = await live.call('PUT', `/api/studio/${sp}`, { kind: 'carousel', slides: [{ id: r.json.slides[0].id, prompt: 'edited' }, {}, {}] }); assert.equal(r.json.slides.length, 3); assert.equal(r.json.slides[0].prompt, 'edited'); ok('slides and edited prompts are saved');

    /* ---- reels with the real flow ---- */
    r = await live.call('POST', '/api/items', { clientId: cl, date: '2026-12-01', platform: 'Instagram', type: 'reel', topic: 'Teak table reveal' }); const it = r.json.id;
    await live.call('PUT', `/api/items/${it}`, { content: { hook: 'HOOK-X', script: 'SCRIPT-X', shots: 'SHOTS-X' } });
    r = await live.call('POST', '/api/reels', { clientId: cl, itemId: it }); const rl = r.json.id;
    assert.equal(r.json.itemId, it); assert(/Teak table reveal/.test(r.json.topic) && /HOOK-X/.test(r.json.topic) && /SCRIPT-X/.test(r.json.topic)); ok('a reel made from a calendar item starts with its topic, hook, script and shots');
    r = await live.call('POST', '/api/reels', { clientId: cl, itemId: it }); assert.equal(r.json.id, rl); ok('opening the same calendar item again reuses its reel');
    badFirst = true; seen = [];
    r = await live.call('POST', `/api/reels/${rl}/prompt`, { duration: 10 }); assert.equal(r.status, 200); badFirst = false;
    assert.equal(seen.length, 2); assert(/had these problems/.test(seen[1].text) && /missing sections/.test(seen[1].text)); assert.equal(r.json.prompt, GOOD_T2V); assert.deepEqual(r.json.problems, []);
    assert(/integrated_multimodal_description:/.test(seen[0].text) && /00:10\.000/.test(seen[0].text) && /Instagram Reels, 9:16 frame, 10 seconds/.test(seen[0].text)); ok('a prompt that breaks the H3 format is sent back once with the problems listed, and the fixed one is kept');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    let s = subs[subs.length - 1]; assert.equal(s.url, '/minimax/h3/text-to-video'); assert.deepEqual(Object.keys(s.body).sort(), ['aspect_ratio', 'duration', 'enable_safety_checker', 'prompt', 'prompt_expansion_mode', 'resolution']);
    assert.equal(s.body.aspect_ratio, '9:16'); assert.equal(s.body.duration, 10); assert.equal(s.body.resolution, '768P'); assert.equal(s.body.prompt_expansion_mode, 'disabled'); assert.equal(s.body.prompt, GOOD_T2V);
    ok('no references: the job goes to minimax/h3/text-to-video with the prompt as written (fal prompt expansion off)');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 409); ok('a second Make while one is running is refused');
    r = await live.call('GET', `/api/reels/${rl}/status`); assert.equal(r.json.job.status, 'IN_QUEUE'); assert.equal(r.json.job.pos, 2);
    r = await live.call('GET', `/api/reels/${rl}/status`); assert.equal(r.json.job.status, 'IN_PROGRESS'); assert(!r.json.video);
    r = await live.call('GET', `/api/reels/${rl}/status`); assert(r.json.job.done && r.json.video && /^https:\/\/v3\.fal\.media\//.test(r.json.video.url)); ok('status moves from queue to making to ready, and the video address is kept');
    r = await live.call('GET', '/api/state'); const item = r.json.items.find(x => x.id === it); assert(item.video && /^https:\/\/v3\.fal\.media\//.test(item.video.url)); assert.equal(item.video.reelId, rl); ok('the finished video is added to the linked calendar item');
    r = await live.call('POST', `/api/items/${it}/send`, {}); assert.equal(r.status, 200);
    r = await live.call('GET', '/api/state'); const token = r.json.clients.find(x => x.id === cl).token;
    const pr = await (await fetch(`http://127.0.0.1:3622/r/${token}/data`)).json(); assert(/^https:\/\/v3\.fal\.media\//.test(pr.items.find(x => x.id === it).video)); ok('the client review link shows the video after the item is sent');

    /* references and logo go to reference-to-video */
    r = await live.call('POST', `/api/studio/${rl}/refs`, { data: jpg() }); assert.equal(r.status, 200);
    seen = [];
    r = await live.call('POST', `/api/reels/${rl}/prompt`, { useLogo: true }); assert.equal(r.status, 200); assert.equal(r.json.promptPics, 2); assert.deepEqual(r.json.problems, []);
    assert.equal(seen[0].images, 2); assert(/subject_definitions:/.test(seen[0].text) && /Picture 2: the brand logo/.test(seen[0].text) && /attribute_transfer/.test(seen[0].text)); ok('with references the AI sees the pictures and writes the H3 reference layout (subjects, retention, detailed description)');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); s = subs[subs.length - 1];
    assert.equal(s.url, '/minimax/h3/reference-to-video'); assert.equal(s.body.reference_image_urls.length, 2); assert(/^data:image\/jpeg;base64,/.test(s.body.reference_image_urls[0]) && /^data:image\/png;base64,/.test(s.body.reference_image_urls[1])); ok('references plus the logo go to minimax/h3/reference-to-video as pictures, in order');
    for (let i = 0; i < 3; i++) r = await live.call('GET', `/api/reels/${rl}/status`); assert(r.json.video && r.json.job.done);

    /* failures */
    failNext = true; r = await live.call('POST', `/api/reels/${rl}/make`, {});
    for (let i = 0; i < 3; i++) r = await live.call('GET', `/api/reels/${rl}/status`);
    assert(r.json.job.done && /safety checker/.test(r.json.job.error)); assert(r.json.video); ok('a failed job shows the service\'s reason and keeps the last good video');
    r = await live.call('PUT', `/api/clients/${cl}/logo`, { data: png });
    const bad = await start(3623, { AI_MODE: 'mock', FAL_KEY: 'wrong', FAL_BASE_URL: 'http://127.0.0.1:' + FAL });
    try {
      r = await bad.call('POST', '/api/clients', { name: 'B', platforms: ['Instagram'] }); r = await bad.call('POST', '/api/reels', { clientId: r.json.id, topic: 'x' }); const br = r.json.id;
      await bad.call('POST', `/api/reels/${br}/prompt`, {}); r = await bad.call('POST', `/api/reels/${br}/make`, {}); assert.equal(r.status, 502); assert(/refused the key/.test(r.json.error)); ok('a wrong fal.ai key gives a plain message');
    } finally { bad.child.kill(); }

    /* download through the app */
    localVideo = true; r = await live.call('POST', '/api/reels', { clientId: cl, topic: 'Download test', title: 'Download test' }); const dl = r.json.id;
    await live.call('PUT', `/api/studio/${dl}`, { prompt: GOOD_T2V }); await live.call('POST', `/api/reels/${dl}/make`, {}); localVideo = false;
    for (let i = 0; i < 3; i++) r = await live.call('GET', `/api/reels/${dl}/status`);
    raw = await live.raw(`/api/reels/${dl}/video?dl=1`); assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), 'video/mp4'); assert(/attachment; filename="Download-test\.mp4"/.test(raw.headers.get('content-disposition'))); assert.equal((await raw.arrayBuffer()).byteLength, 5000); ok('Download MP4 streams the file through the app with a proper file name');

    /* linking and cleanup */
    r = await live.call('POST', `/api/reels/${dl}/attach`, { itemId: it }); assert.equal(r.json.itemId, it);
    r = await live.call('GET', '/api/state'); assert.equal(r.json.items.find(x => x.id === it).video.reelId, dl); ok('linking another reel to the item moves the video to it');
    r = await live.call('POST', `/api/reels/${dl}/attach`, { itemId: null }); r = await live.call('GET', '/api/state'); assert(!r.json.items.find(x => x.id === it).video); ok('unlinking removes the video from the item');
    r = await live.call('POST', '/api/clients', { name: 'Other', platforms: ['Instagram'] }); const other = r.json.id;
    r = await live.call('POST', '/api/items', { clientId: other, date: '2026-12-02', platform: 'Instagram', type: 'reel', topic: 'x' });
    r = await live.call('POST', `/api/reels/${dl}/attach`, { itemId: r.json.id }); assert.equal(r.status, 400); ok('a reel cannot be linked to another client\'s item');
    r = await live.call('GET', '/api/state'); const logoNow = r.json.clients.find(x => x.id === cl).logo;
    r = await live.call('DELETE', `/api/clients/${cl}`); assert.equal(r.status, 200); assert.equal((await live.raw('/api/img/' + logoNow)).status, 404);
    r = await live.call('GET', '/api/state'); assert(!r.json.studio.some(x => x.clientId === cl)); ok('deleting a client deletes its reels, designs and logo');
    void logo2;
  } finally { [demo, live].forEach(x => x.child.kill()); ai.close(); fal.close(); }
  console.log('\nAll ' + n + ' reels and studio checks passed.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
