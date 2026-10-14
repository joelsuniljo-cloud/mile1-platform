'use strict';
/* Checks that each AI provider setting sends the right kind of request and reads the reply.
   Uses a fake AI server on this machine, so no real key or internet is needed. Usage: node test-ai.js */
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');

const FAKE_PORT = 3470;
let last = null;
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    last = { url: req.url, headers: req.headers, body };
    let prompt = '', kind = '';
    if (req.url.startsWith('/v1/messages')) { kind = 'anthropic'; prompt = body.messages[0].content; }
    else if (req.url.includes(':generateContent')) { kind = 'gemini'; prompt = body.contents[0].parts[0].text; }
    else if (req.url.startsWith('/chat/completions')) { kind = 'openai'; prompt = body.messages[0].content; }
    else { res.writeHead(404); return res.end('{}'); }
    if ((req.headers.authorization || '') === 'Bearer bad-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); }
    let out;
    if (prompt.includes('Plan a content calendar')) {
      const start = /DATE RANGE\n(\d{4}-\d\d-\d\d)/.exec(prompt)[1];
      out = [{ date: start, platform: 'Instagram', type: 'post', pillar: 'Offers', topic: 'FAKE idea one' }, { date: start, platform: 'Instagram', type: 'reel', pillar: 'Offers', topic: 'FAKE idea two' }];
    } else {
      out = { visual: 'FAKE visual', caption: 'FAKE caption from ' + kind, hashtags: '#fake', cta: 'FAKE cta', hook: 'FAKE hook', script: 's', shots: 'a\nb', onscreen: 'o', videoPrompt: 'v', summary: 'FAKE summary' };
    }
    const text = (kind === 'gemini' || kind === 'openai') ? JSON.stringify(out) : '```json\n' + JSON.stringify(out) + '\n```';
    res.writeHead(200, { 'content-type': 'application/json' });
    if (kind === 'anthropic') res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    else if (kind === 'gemini') res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    else res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
});

let n = 0; const ok = s => console.log('  ok ' + (++n) + '. ' + s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runProvider(name, port, env, expect) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1ai-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_BASE_URL: 'http://127.0.0.1:' + FAKE_PORT, AI_MODE: '', ANTHROPIC_API_KEY: '' }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  try {
    for (let i = 0; i < 50 && !log.includes('running'); i++) await sleep(100);
    assert(log.includes('live ('), name + ': server should be in live AI mode. Log: ' + log);
    let cookie = '';
    const call = async (m, p, b) => {
      const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
      const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = sc.split(';')[0];
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    let r = await call('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' }); assert.equal(r.status, 200);
    r = await call('POST', '/api/clients', { name: 'Test Cafe', pillars: 'Offers', platforms: ['Instagram'] }); const cid = r.json.id;
    r = await call('POST', `/api/clients/${cid}/calendar`, { start: '2026-11-02', weeks: 1, posts: 1, reels: 1 });
    assert.equal(r.status, 200, name + ' calendar: ' + JSON.stringify(r.json)); assert.equal(r.json.added, 2);
    expect(last); ok(name + ': calendar request is shaped correctly and the reply was read (2 ideas)');
    r = await call('GET', '/api/state'); const it = r.json.items.find(i => i.topic === 'FAKE idea one');
    r = await call('POST', `/api/items/${it.id}/draft`, {}); assert.equal(r.status, 200, name + ' draft: ' + JSON.stringify(r.json));
    assert.equal(r.json.item.content.caption, 'FAKE caption from ' + (env.AI_PROVIDER || 'anthropic')); assert.equal(r.json.summary, 'FAKE summary');
    ok(name + ': draft saved from the provider reply');
    return call;
  } finally { child.kill(); }
}

(async () => {
  await new Promise(r => fake.listen(FAKE_PORT, r));
  try {
    await runProvider('Claude', 3471, { AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-test' }, l => {
      assert(l.url.startsWith('/v1/messages')); assert.equal(l.headers['x-api-key'], 'sk-test'); assert.equal(l.headers['anthropic-version'], '2023-06-01');
      assert.equal(l.body.model, 'claude-sonnet-5-5'); assert(l.body.max_tokens > 0);
    });
    await runProvider('Gemini', 3472, { AI_PROVIDER: 'gemini', AI_API_KEY: 'g-test' }, l => {
      assert(l.url.startsWith('/v1beta/models/gemini-2.5-flash:generateContent')); assert(!l.url.includes('g-test'), 'key must not be in the URL');
      assert.equal(l.headers['x-goog-api-key'], 'g-test'); assert(l.body.generationConfig.maxOutputTokens > 0);
    });
    const call = await runProvider('OpenAI-style (Groq, OpenRouter, others)', 3473, { AI_PROVIDER: 'openai', AI_API_KEY: 'o-test', AI_MODEL: 'llama-3.3-70b-versatile' }, l => {
      assert(l.url.startsWith('/chat/completions')); assert.equal(l.headers.authorization, 'Bearer o-test'); assert.equal(l.body.model, 'llama-3.3-70b-versatile');
    });
    /* bad key: the message from the service reaches the user */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1ai-'));
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: '3474', DATA_DIR: dir, BASE_PATH: '', ADMIN_EMAIL: 'o@x.test', ADMIN_PASSWORD: 'long-password-123', AI_BASE_URL: 'http://127.0.0.1:' + FAKE_PORT, AI_PROVIDER: 'openai', AI_API_KEY: 'bad-key', AI_MODEL: 'm', AI_MODE: '', ANTHROPIC_API_KEY: '' }), stdio: 'ignore' });
    try {
      await sleep(900); let cookie = '';
      const c2 = async (m, p, b) => { const r = await fetch('http://127.0.0.1:3474' + p, { method: m, headers: { 'content-type': 'application/json', 'x-m1': '1', cookie }, body: b === undefined ? undefined : JSON.stringify(b) }); const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('m1s=')) cookie = sc.split(';')[0]; return { status: r.status, json: await r.json().catch(() => ({})) }; };
      await c2('POST', '/api/login', { email: 'o@x.test', password: 'long-password-123' });
      const cl = await c2('POST', '/api/clients', { name: 'T', platforms: ['Instagram'] });
      const r = await c2('POST', `/api/clients/${cl.json.id}/calendar`, { start: '2026-11-02', weeks: 1, posts: 1, reels: 0 });
      assert.equal(r.status, 502); assert(r.json.error.includes('Invalid API key')); ok('a wrong key shows the AI service message to the user');
    } finally { child.kill(); }
    console.log('\nAll ' + n + ' provider checks passed.'); process.exit(0);
  } catch (e) { console.error('\nFAILED after ' + n + ' checks:', e && e.stack || e); process.exit(1); }
})();
