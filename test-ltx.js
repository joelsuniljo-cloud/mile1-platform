'use strict';
/* Checks Reels with LTX-2.5 on your own PC: the platform -> comfy-bridge.js -> a fake ComfyUI on this machine.
   Usage: node test-ltx.js  (or M1_PGLITE=1 node test-ltx.js) */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);
const AI = 3712, COMFY = 3713, BRIDGE = 3714, TOKEN = 'a-very-long-bridge-secret';
const jpg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, 9)]).toString('base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(20000, 3)]);
const T2V = { '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}', clip: ['2', 0] } }, '3': { class_type: 'CLIPTextEncode', inputs: { text: '{{NEGATIVE}}', clip: ['2', 0] } },
  '4': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: 768, height: 512, length: 97, batch_size: 1 } }, '5': { class_type: 'LTXVConditioning', inputs: { frame_rate: 25, positive: ['1', 0] } },
  '6': { class_type: 'SamplerCustom', inputs: { noise_seed: 42, cfg: 3 } }, '7': { class_type: 'LatentUpscale', inputs: { width: 1536, height: 1024, samples: ['6', 0] } }, '8': { class_type: 'SaveVideo', inputs: { fps: 25, filename_prefix: 'ltx' } } };
const I2V = Object.assign(JSON.parse(JSON.stringify(T2V)), { '9': { class_type: 'LoadImage', inputs: { image: 'example.png' } } });
const LTX_GOOD = 'A close vertical shot of a teak dining table in a bright showroom, warm amber light from tall windows. A dust sheet slides off in the first second, revealing the grain. A woman in her thirties with short dark hair and a cream linen shirt runs her palm along the edge and smiles. The camera slowly pushes in until the grain fills the frame. A hard cut transitions to a wide shot of a family sitting down to dinner at the same table in the evening light. Soft fabric rustle and the clink of plates are heard. Light acoustic guitar plays at a medium tempo. A warm female narrator speaks off-screen in English, saying: "Built by hand in Jaipur."';
let seen = [], badFirst = false;
const ai = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const b = JSON.parse(raw || '{}'); let text = '', images = 0; const c = b.messages[0].content;
    if (Array.isArray(c)) { images = c.filter(x => x.type === 'image').length; text = c.filter(x => x.type === 'text').map(x => x.text).join(''); } else text = c;
    seen.push({ text, images }); let out = { ok: 1 };
    if (text.includes('LTX-2.5')) out = badFirst && !text.includes('had these problems') ? { prompt: 'integrated_multimodal_description: [Shot 1] a table.', negative: '' } : { prompt: LTX_GOOD, negative: 'blurry, warped hands' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
  });
});
/* fake ComfyUI */
const prompts = [], uploads = []; let comfyDown = false, failNext = false, refuseNext = false;
const comfy = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const raw = Buffer.concat(chunks), send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (comfyDown) { req.socket.destroy(); return; }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/system_stats') return send(200, { system: {} });
    if (u.pathname === '/upload/image') { uploads.push({ ct: req.headers['content-type'], len: raw.length, hasName: /filename="mile1-/.test(raw.toString('latin1')) }); return send(200, { name: 'mile1-up.jpg', subfolder: '', type: 'input' }); }
    if (u.pathname === '/prompt') {
      if (refuseNext) { refuseNext = false; return send(400, { error: { message: 'Prompt outputs failed validation' }, node_errors: { '4': { class_type: 'EmptyLTXVLatentVideo', errors: [{ message: 'Value not in list', details: 'width' }] } } }); }
      const b = JSON.parse(raw.toString()); const id = 'p' + (prompts.length + 1); prompts.push({ id, wf: b.prompt, polls: 0, fail: failNext }); failNext = false; return send(200, { prompt_id: id, number: prompts.length });
    }
    const h = /^\/history\/(\w+)$/.exec(u.pathname);
    if (h) { const p = prompts.find(x => x.id === h[1]); if (!p) return send(200, {}); p.polls++; if (p.polls < 3) return send(200, {});
      if (p.fail) return send(200, { [p.id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] }, outputs: {} } });
      return send(200, { [p.id]: { status: { status_str: 'success', completed: true }, outputs: { '8': { images: [{ filename: 'ltx_00001.mp4', subfolder: 'video', type: 'output' }] } } } }); }
    if (u.pathname === '/queue') { const pend = prompts.filter(p => p.polls === 0).map((p, i) => [i, p.id]), run = prompts.filter(p => p.polls === 1 || p.polls === 2).map(p => [0, p.id]); return send(200, { queue_running: run, queue_pending: pend }); }
    if (u.pathname === '/view') { if (u.searchParams.get('filename') !== 'ltx_00001.mp4' || u.searchParams.get('subfolder') !== 'video') return send(404, {}); res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(MP4); }
    send(404, { error: 'nope' });
  });
});
async function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1l-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_MODE: 'mock', ANTHROPIC_API_KEY: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: '', IG_ACCESS_TOKEN: '', FAL_KEY: '', COMFYUI_URL: '', COMFYUI_TOKEN: '', VIDEO_PROVIDER: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 80 && !log.includes('running'); i++) await sleep(100);
  assert(log.includes('running'), 'server did not start: ' + log);
  let cookie = '';
  const call = async (m, p, b) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const raw = async (p, h) => fetch('http://127.0.0.1:' + port + p, { headers: Object.assign({ cookie, 'x-m1': '1' }, h || {}) });
  let st = 0; for (let i = 0; i < 60 && st !== 200; i++) { st = (await call('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' })).status; if (st !== 200) await sleep(250); }
  assert.equal(st, 200);
  return { child, call, raw };
}
function startBridge(dir, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'comfy-bridge.js')], { env: Object.assign({}, process.env, { BRIDGE_TOKEN: TOKEN, COMFY_URL: 'http://127.0.0.1:' + COMFY, BRIDGE_PORT: String(BRIDGE), WORKFLOW: path.join(dir, 'workflow.json') }, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', d => { log += d; if (log.includes('bridge running')) resolve(child); }); child.stderr.on('data', d => log += d);
    child.on('exit', code => reject(new Error('bridge exited ' + code + ': ' + log))); setTimeout(() => reject(new Error('bridge did not start: ' + log)), 8000);
  });
}
const B = (p, opts) => fetch('http://127.0.0.1:' + BRIDGE + p, Object.assign({}, opts || {}, { headers: Object.assign({ authorization: 'Bearer ' + TOKEN }, (opts && opts.headers) || {}) }));
(async () => {
  await Promise.all([[ai, AI], [comfy, COMFY]].map(([s, p]) => new Promise(r => s.listen(p, r))));
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1w-')), wf = path.join(wdir, 'workflow.json');
  let bridge = null, live = null;
  try {
    /* ---- the bridge on its own ---- */
    const short = spawn(process.execPath, [path.join(__dirname, 'comfy-bridge.js')], { env: Object.assign({}, process.env, { BRIDGE_TOKEN: 'short' }), stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise(r => short.on('exit', r)); assert.equal(code, 1); ok('the bridge refuses to start with a short token');
    bridge = await startBridge(wdir);
    let r = await fetch('http://127.0.0.1:' + BRIDGE + '/health'); assert.equal(r.status, 401);
    r = await fetch('http://127.0.0.1:' + BRIDGE + '/health', { headers: { authorization: 'Bearer wrong-token-of-same-size!' } }); assert.equal(r.status, 401); ok('the bridge answers nothing without the right token');
    let j = await (await B('/health')).json(); assert(!j.ok && /No workflow\.json/.test(j.error)); ok('health says when workflow.json is missing');
    fs.writeFileSync(wf, JSON.stringify({ nodes: [], links: [] })); j = await (await B('/health')).json(); assert(/Export \(API\)/.test(j.error)); ok('a workflow saved in the normal format is caught: use Export (API)');
    const noPrompt = JSON.parse(JSON.stringify(T2V)); noPrompt['1'].inputs.text = 'a cat'; fs.writeFileSync(wf, JSON.stringify(noPrompt));
    j = await (await B('/health')).json(); assert(!j.ok && /\{\{PROMPT\}\}/.test(j.error)); ok('a workflow without {{PROMPT}} is caught');
    fs.writeFileSync(wf, JSON.stringify(T2V)); j = await (await B('/health')).json(); assert(j.ok && j.comfy && !j.startImage); ok('health is green with ComfyUI running and a good workflow');

    /* ---- platform ---- */
    live = await start(3722, { AI_MODE: '', AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_BASE_URL: 'http://127.0.0.1:' + AI, COMFYUI_URL: 'http://127.0.0.1:' + BRIDGE, COMFYUI_TOKEN: TOKEN });
    r = await live.call('GET', '/api/state'); assert.equal(r.json.config.video, 'live'); assert.equal(r.json.config.videoProvider, 'ltx'); assert.deepEqual(r.json.config.videoRes, ['512P', '768P']); assert.equal(r.json.config.videoRefs, 1); ok('with COMFYUI_URL the app switches Reels to LTX-2.5 on your PC (512p and 768p, one start image)');
    r = await live.call('GET', '/api/reels-health'); assert(r.json.ok && r.json.provider === 'comfyui'); ok('Check the connection reaches the bridge and ComfyUI');
    r = await live.call('POST', '/api/clients', { name: 'Oak and Ember', industry: 'Furniture', platforms: ['Instagram'] }); const cl = r.json.id;
    r = await live.call('POST', '/api/items', { clientId: cl, date: '2026-12-01', platform: 'Instagram', type: 'reel', topic: 'Teak table reveal' }); const it = r.json.id;
    await live.call('PUT', `/api/items/${it}`, { content: { hook: 'Watch the grain', caption: 'New table' } });
    r = await live.call('POST', '/api/reels', { clientId: cl, itemId: it }); const rl = r.json.id; assert.equal(r.json.resolution, '512P'); ok('a new reel defaults to 512p, the size a 16 GB card can manage');
    badFirst = true; seen = [];
    r = await live.call('POST', `/api/reels/${rl}/prompt`, { voice: 'Built by hand in Jaipur.', duration: 5 }); badFirst = false; assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(seen.length, 2); assert(/LTX-2\.5/.test(seen[0].text) && /One flowing paragraph in the present tense/.test(seen[0].text) && /hard cut transitions/.test(seen[0].text) && /speaks off-screen in English, saying/.test(seen[0].text));
    assert(/remove section labels/.test(seen[1].text)); assert.equal(r.json.prompt, LTX_GOOD); assert.equal(r.json.negative, 'blurry, warped hands'); assert.deepEqual(r.json.problems, []);
    ok('the LTX prompt follows Lightricks\' guide (one paragraph, cuts in prose, audio last, voiceover in quotes); an H3-style answer is sent back once');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.job.provider, 'comfyui'); assert(r.json.job.notes.some(x => /512x896/.test(x)) && r.json.job.notes.some(x => /121 frames/.test(x)));
    let w = prompts[prompts.length - 1].wf;
    assert.equal(w['1'].inputs.text, LTX_GOOD); assert.equal(w['3'].inputs.text, 'blurry, warped hands');
    assert.deepEqual([w['4'].inputs.width, w['4'].inputs.height, w['4'].inputs.length], [512, 896, 121]); assert.deepEqual([w['7'].inputs.width, w['7'].inputs.height], [1536, 1024]);
    assert.equal(w['5'].inputs.frame_rate, 24); assert.equal(w['8'].inputs.fps, 24); assert.notEqual(w['6'].inputs.noise_seed, 42);
    ok('the bridge fills the workflow: prompt, negative, 512x896, 121 frames (8n+1 for 5 s at 24 fps), frame rate, a new seed; the upscaler is left alone');
    r = await live.call('GET', `/api/reels/${rl}/status`); assert.equal(r.json.job.status, 'IN_PROGRESS');
    r = await live.call('GET', `/api/reels/${rl}/status`); assert(!r.json.job.done);
    r = await live.call('GET', `/api/reels/${rl}/status`); assert(r.json.job.done && r.json.video && r.json.video.store && !r.json.video.url); ok('when ComfyUI finishes, the video is copied into the app');
    let v = await live.raw(`/api/reels/${rl}/video`); assert.equal(v.status, 200); assert.equal(v.headers.get('content-type'), 'video/mp4'); assert.equal((await v.arrayBuffer()).byteLength, MP4.length);
    v = await live.raw(`/api/reels/${rl}/video`, { range: 'bytes=100-199' }); assert.equal(v.status, 206); assert.equal(v.headers.get('content-range'), `bytes 100-199/${MP4.length}`); assert.equal((await v.arrayBuffer()).byteLength, 100); ok('the stored video plays in the browser, with seeking (range requests)');
    v = await live.raw(`/api/reels/${rl}/video?dl=1`); assert(/attachment/.test(v.headers.get('content-disposition'))); ok('Download MP4 saves a file');
    r = await live.call('GET', '/api/state'); const item = r.json.items.find(x => x.id === it); assert(item.video && item.video.reelId === rl && !item.video.url); ok('the video is added to the linked calendar item');
    comfyDown = true; v = await live.raw(`/api/reels/${rl}/video`); assert.equal(v.status, 200); comfyDown = false; ok('the stored video still plays when the PC is off');
    await live.call('POST', `/api/items/${it}/send`, {}); r = await live.call('GET', '/api/state'); const token = r.json.clients.find(x => x.id === cl).token;
    const pr = await (await fetch(`http://127.0.0.1:3722/r/${token}/data`)).json(); const pv = pr.items.find(x => x.id === it).video;
    assert.equal(pv, `/r/${token}/video/${rl}`); v = await fetch('http://127.0.0.1:3722' + pv); assert.equal(v.status, 200); assert.equal((await v.arrayBuffer()).byteLength, MP4.length); ok('the client review link plays the video from the app');
    v = await fetch(`http://127.0.0.1:3722/r/${token}/video/nope`); assert.equal(v.status, 404);

    /* start image */
    r = await live.call('POST', `/api/studio/${rl}/refs`, { data: jpg }); assert.equal(r.status, 200);
    r = await live.call('POST', `/api/studio/${rl}/refs`, { data: jpg }); assert.equal(r.status, 400); ok('LTX reels take one start image');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert(r.json.job.notes.some(x => /Load Image/.test(x))); ok('with a text-to-video workflow, the start image is skipped and the note says why');
    for (let i = 0; i < 3; i++) await live.call('GET', `/api/reels/${rl}/status`);
    fs.writeFileSync(wf, JSON.stringify(I2V)); const up0 = uploads.length;
    seen = []; r = await live.call('POST', `/api/reels/${rl}/prompt`, {}); assert.equal(seen[0].images, 1); assert(/START IMAGE/.test(seen[0].text)); ok('the AI sees the start image and is told the video begins on it');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(uploads.length, up0 + 1); assert(/multipart\/form-data/.test(uploads[up0].ct) && uploads[up0].hasName); assert.equal(prompts[prompts.length - 1].wf['9'].inputs.image, 'mile1-up.jpg'); ok('with an image-to-video workflow, the start image is uploaded to ComfyUI and put in the Load Image node');
    for (let i = 0; i < 3; i++) await live.call('GET', `/api/reels/${rl}/status`);
    await live.call('DELETE', `/api/studio/${rl}/refs/${(await live.call('GET', `/api/studio/${rl}`)).json.refs[0]}`);
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 502); assert(/starts from a picture/.test(r.json.error)); ok('an image-to-video workflow without a start image gives a clear message');
    fs.writeFileSync(wf, JSON.stringify(T2V));

    /* failures */
    refuseNext = true; r = await live.call('POST', `/api/reels/${rl}/make`, {}); assert.equal(r.status, 502); assert(/refused the workflow.*Value not in list/.test(r.json.error)); ok('ComfyUI\'s own validation error is passed on');
    failNext = true; r = await live.call('POST', `/api/reels/${rl}/make`, {}); for (let i = 0; i < 3; i++) r = await live.call('GET', `/api/reels/${rl}/status`);
    assert(r.json.job.done && /CUDA out of memory/.test(r.json.job.error) && r.json.video); ok('an out-of-memory error on the PC is shown, and the last good video is kept');
    r = await live.call('POST', `/api/reels/${rl}/make`, {}); bridge.kill(); await sleep(300);
    r = await live.call('GET', `/api/reels/${rl}/status`); assert(!r.json.job.done && /Cannot reach your PC/.test(r.json.job.offline)); ok('while the PC is off the job waits and says it cannot reach the PC');
    bridge = await startBridge(wdir); for (let i = 0; i < 3; i++) r = await live.call('GET', `/api/reels/${rl}/status`); assert(r.json.job.done && !r.json.job.offline); ok('when the PC is back, the job finishes');
    const wrong = await start(3723, { AI_MODE: 'mock', COMFYUI_URL: 'http://127.0.0.1:' + BRIDGE, COMFYUI_TOKEN: 'not-the-right-token-at-all' });
    try { r = await wrong.call('GET', '/api/reels-health'); assert(!r.json.ok && /refused the token/.test(r.json.error)); ok('a token that does not match is explained'); } finally { wrong.child.kill(); }
    const half = await start(3724, { AI_MODE: 'mock', VIDEO_PROVIDER: 'comfyui' });
    try { r = await half.call('GET', '/api/state'); assert.equal(r.json.config.video, 'demo'); assert.equal(r.json.config.videoProvider, 'ltx'); r = await half.call('POST', '/api/clients', { name: 'H', platforms: ['Instagram'] }); r = await half.call('POST', '/api/reels', { clientId: r.json.id, topic: 'A lamp' }); r = await half.call('POST', `/api/reels/${r.json.id}/prompt`, {}); assert(!/integrated_multimodal_description/.test(r.json.prompt) && /\.$/.test(r.json.prompt)); ok('LTX chosen but not connected: demo mode still writes LTX-style prompts'); } finally { half.child.kill(); }
    const st = (await live.call('GET', '/api/state')).json; const store = st.studio.find(x => x.id === rl);
    r = await live.call('GET', `/api/studio/${rl}`); const sid = r.json.video.store;
    r = await live.call('DELETE', `/api/studio/${rl}`); assert.equal(r.status, 200); assert.equal((await live.raw('/api/img/' + sid)).status, 404);
    r = await live.call('GET', '/api/state'); assert(!r.json.items.find(x => x.id === it).video); ok('deleting the reel deletes the stored video and clears it from the item'); void store;
  } finally { if (bridge) bridge.kill(); if (live) live.child.kill(); ai.close(); comfy.close(); }
  console.log('\nAll ' + n + ' LTX and bridge checks passed.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
