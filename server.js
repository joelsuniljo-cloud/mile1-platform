'use strict';
/* Mile 1 platform server. No dependencies. Node 18 or newer. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- config (.env loader, no dotenv needed) ---------- */
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
} catch (e) { /* ignore */ }

const PORT = +process.env.PORT || 3000;
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
/* Storage: a JSON file by default, or Upstash Redis (needed on Vercel, which has no permanent disk). */
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REDIS = !!(REDIS_URL && REDIS_TOKEN);
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();   // anthropic | gemini | openai
const AI_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', gemini: 'gemini-2.5-flash', openai: '' };
const AI_MODEL = process.env.AI_MODEL || DEFAULT_MODELS[AI_PROVIDER] || '';
const AI_BASE = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
const KNOWN_PROVIDER = Object.prototype.hasOwnProperty.call(DEFAULT_MODELS, AI_PROVIDER);
const MOCK = process.env.AI_MODE === 'mock' || !AI_KEY || !KNOWN_PROVIDER;
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_DAYS = 14;

if (!REDIS) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- constants ---------- */
const PLATFORMS = ['Instagram', 'LinkedIn', 'Facebook', 'YouTube Shorts'];
const TYPES = ['post', 'carousel', 'reel'];
const STATUSES = ['idea', 'drafted', 'review', 'changes', 'approved', 'published'];
const FIELDS = {
  post: ['visual', 'caption', 'hashtags', 'cta'],
  carousel: ['visual', 'caption', 'hashtags', 'cta'],
  reel: ['hook', 'script', 'shots', 'onscreen', 'videoPrompt', 'caption', 'hashtags', 'cta']
};
const CLIENT_VISIBLE = ['change', 'approve', 'reply', 'resolved'];

/* ---------- store: one JSON file, written atomically ---------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: [], clients: [], items: [], comments: [] };
function load() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    ['users', 'clients', 'items', 'comments'].forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
  }
}
let saveTimer = null;
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch (e) { /* ignore */ }
}
let VER = 0; // bumps on every change so open screens know when to refresh
function save() {
  VER++;
  if (REDIS) return; // Redis mode writes changed records in persist(), before the reply is sent
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 150);
}

/* ---------- Redis storage (Upstash REST). One hash per collection, one field per record. ---------- */
const COLS = ['users', 'clients', 'items', 'comments'];
let snap = { users: {}, clients: {}, items: {}, comments: {} };
async function rcall(cmds) {
  let res;
  try {
    res = await fetch(REDIS_URL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  } catch (e) { throw httpError(503, 'Storage is unreachable. Try again.'); }
  if (!res.ok) throw httpError(503, 'Storage is unavailable (' + res.status + '). Check the database settings.');
  const arr = await res.json();
  arr.forEach(x => { if (x && x.error) throw httpError(503, 'Storage error: ' + x.error); });
  return arr.map(x => x.result);
}
async function loadRemote() {
  const out = await rcall(COLS.map(c => ['HGETALL', 'm1:' + c]));
  COLS.forEach((c, i) => {
    let flat = out[i] || [];
    if (!Array.isArray(flat)) flat = Object.entries(flat).flat();
    const list = []; snap[c] = {};
    for (let k = 0; k + 1 < flat.length; k += 2) {
      snap[c][flat[k]] = flat[k + 1];
      try { list.push(JSON.parse(flat[k + 1])); } catch (e) { /* skip a damaged record */ }
    }
    db[c] = list;
  });
}
async function persist() {
  if (!REDIS) return;
  const cmds = [], next = {};
  COLS.forEach(c => {
    const cur = {}; db[c].forEach(o => { cur[o.id] = JSON.stringify(o); });
    const set = []; Object.keys(cur).forEach(id => { if (snap[c][id] !== cur[id]) set.push(id, cur[id]); });
    if (set.length) cmds.push(['HSET', 'm1:' + c].concat(set));
    const del = Object.keys(snap[c]).filter(id => !(id in cur));
    if (del.length) cmds.push(['HDEL', 'm1:' + c].concat(del));
    next[c] = cur;
  });
  if (cmds.length) { cmds.push(['INCR', 'm1:ver']); await rcall(cmds); snap = next; }
}
let readyP = null;
function ready() {
  if (!REDIS) return Promise.resolve();
  if (readyP) return readyP;
  readyP = (async () => {
    if (!process.env.SESSION_SECRET) {
      let [s] = await rcall([['GET', 'm1:secret']]);
      if (!s) { await rcall([['SET', 'm1:secret', crypto.randomBytes(32).toString('hex'), 'NX']]); [s] = await rcall([['GET', 'm1:secret']]); }
      SECRET = s;
    }
    await loadRemote();
    if (!db.users.length) {
      const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase() || 'admin@example.com';
      let pw = process.env.ADMIN_PASSWORD || '', generated = false;
      if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
      db.users.push({ id: 'u' + crypto.createHash('sha1').update(email).digest('hex').slice(0, 10), email, name: 'Mile 1', pw: hashPw(pw), created: now() });
      await persist();
      console.log('Created the first user: ' + email);
      if (generated) console.log('Temporary password (change it after signing in): ' + pw);
    }
  })().catch(e => { readyP = null; throw e; });
  return readyP;
}
const uid = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();

/* ---------- auth ---------- */
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET && !REDIS) {
  const f = path.join(DATA_DIR, 'secret.txt');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8').trim();
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeSession(userId) {
  const exp = now() + SESSION_DAYS * 864e5;
  const v = userId + '.' + exp;
  return v + '.' + sign(v);
}
function readSession(req) {
  const m = /(?:^|;\s*)m1s=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return null;
  const v = parts[0] + '.' + parts[1];
  const good = sign(v), given = parts[2];
  if (good.length !== given.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(given))) return null;
  if (+parts[1] < now()) return null;
  return db.users.find(u => u.id === parts[0]) || null;
}
function cookieHeader(value, maxAge) {
  return `m1s=${encodeURIComponent(value)}; Path=${BASE || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}
const attempts = new Map();
function tooMany(key, limit, windowMs) {
  const t = now(), arr = (attempts.get(key) || []).filter(x => t - x < windowMs);
  arr.push(t); attempts.set(key, arr);
  return arr.length > limit;
}
/* Same idea, but shared between server instances when Redis is on (needed on Vercel). */
async function tooManyShared(key, limit, windowMs) {
  if (!REDIS) return tooMany(key, limit, windowMs);
  const k = 'm1:rl:' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
  const out = await rcall([['INCR', k], ['EXPIRE', k, String(Math.ceil(windowMs / 1000)), 'NX']]);
  return +out[0] > limit;
}

/* ---------- helpers ---------- */
const hasText = c => Object.values(c || {}).some(v => String(v || '').trim());
const clientIp = req => String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = s => /^\d{4}-\d\d-\d\d$/.test(String(s || ''));
const str = (v, max) => String(v == null ? '' : v).slice(0, max || 5000);
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
const publicLink = client => `${PUBLIC_URL}${BASE}/r/${client.token}`;

/* ---------- AI ---------- */
function extractJson(text) {
  text = String(text || '').trim();
  try { return JSON.parse(text); } catch (e) { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* continue */ } }
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* continue */ } }
  throw httpError(502, 'The AI reply could not be read. Try again.');
}
async function llm(prompt, maxTokens) {
  maxTokens = maxTokens || 4000;
  const headers = { 'content-type': 'application/json' };
  let url, body, read;
  if (AI_PROVIDER === 'gemini') {
    url = `${AI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(AI_MODEL)}:generateContent`;
    headers['x-goog-api-key'] = AI_KEY;
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' } };
    read = d => ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map(p => p.text || '').join('');
  } else if (AI_PROVIDER === 'openai') {
    if (!AI_MODEL) throw httpError(500, 'Set AI_MODEL in the server settings for this AI service.');
    url = `${AI_BASE || 'https://api.openai.com/v1'}/chat/completions`;
    headers.authorization = 'Bearer ' + AI_KEY;
    body = { model: AI_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    read = d => (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } else {
    url = `${AI_BASE || 'https://api.anthropic.com'}/v1/messages`;
    headers['x-api-key'] = AI_KEY; headers['anthropic-version'] = '2023-06-01';
    body = { model: AI_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    read = d => (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || ''; } catch (e) { /* ignore */ }
    if (res.status === 429) throw httpError(502, 'The AI service says you have used up its free limit for now. Wait a minute and try again. ' + detail);
    throw httpError(502, 'AI request failed (' + res.status + '). ' + detail);
  }
  const text = read(await res.json());
  if (!String(text).trim()) throw httpError(502, 'The AI returned nothing. Try again.');
  return text;
}
const briefText = c => [
  `Client: ${c.name}`, c.industry && `What they do: ${c.industry}`, c.region && `Market: ${c.region}`,
  c.audience && `Audience: ${c.audience}`, c.voice && `Brand voice: ${c.voice}`,
  c.pillars && `Content pillars:\n${c.pillars}`, c.goals && `Goals: ${c.goals}`, c.notes && `Rules and notes: ${c.notes}`
].filter(Boolean).join('\n');
const FD = {
  visual_post: 'image or design brief: what the visual shows, framing, and any text on the image',
  visual_carousel: 'slide-by-slide plan, one slide per line, formatted "Slide N: headline | supporting line"',
  caption: 'the full caption, ready to publish, with a strong first line',
  hashtags: 'hashtags separated by spaces',
  cta: 'one short call to action',
  hook: 'the opening line or visual that stops the scroll in the first 3 seconds',
  script: 'spoken lines and beats with rough timestamps, 15 to 30 seconds in total',
  shots: 'shot list, one shot per line, with framing and movement',
  onscreen: 'on-screen text overlays, one per line',
  videoPrompt: 'one self-contained prompt for an AI video generator: subject, setting, camera movement, lighting, style, 9:16 vertical, no text in frame'
};
function draftPrompt(cl, it, instruction, current) {
  const keys = FIELDS[it.type] || FIELDS.post;
  const spec = keys.map(k => `- "${k}": ${k === 'visual' ? FD['visual_' + (it.type === 'carousel' ? 'carousel' : 'post')] : FD[k]}`).join('\n');
  let p = `You are the senior content strategist at a social media agency called Mile 1. Write content for the client below.\n\nCLIENT BRIEF\n${briefText(cl)}\n\nCONTENT ITEM\nPlatform: ${it.platform}\nFormat: ${it.type}\nContent pillar: ${it.pillar || 'any'}\nTopic: ${it.topic}\nPublish date: ${it.date}\n`;
  p += it.platform === 'LinkedIn' ? '\nLinkedIn: professional but human, strong first line, short paragraphs, 3 to 5 hashtags.\n' : '\nInstagram style: hook in the first line, short lines, 5 to 10 relevant hashtags.\n';
  if (current) p += `\nCURRENT DRAFT (JSON)\n${JSON.stringify(current)}\n\nREQUESTED CHANGES\n${instruction}\nApply the changes and keep everything else as it is.\n`;
  p += `\nReply with only one JSON object. Every value is a plain string. Fields:\n${spec}\n- "summary": one or two plain sentences telling the client what you changed or wrote`;
  return p;
}
function normalizeDraft(out, type) {
  const o = {};
  (FIELDS[type] || FIELDS.post).forEach(k => { let v = out && out[k]; if (Array.isArray(v)) v = v.join('\n'); o[k] = v == null ? '' : String(v); });
  return { content: o, summary: str(out && out.summary, 600) };
}
function mockDraft(cl, it, instruction) {
  const t = it.topic || 'this idea', tag = '#' + String(cl.name || 'brand').replace(/\W+/g, '');
  const tweak = instruction ? ' (Updated: ' + instruction.replace(/\s+/g, ' ').slice(0, 90) + ')' : '';
  const c = {
    hook: 'Stop scrolling. ' + t + '.' + tweak,
    script: '0-3s: Hook line on screen.\n3-15s: Show ' + t + '.\n15-25s: Close with the offer.',
    shots: 'Close-up of the product\nWide shot of the space\nSmiling customer\nLogo end card',
    onscreen: t + '\nSee you soon',
    videoPrompt: 'Vertical 9:16 video. ' + t + '. Natural light, handheld camera, warm colours, no text in frame.',
    visual: it.type === 'carousel' ? 'Slide 1: ' + t + ' | Swipe\nSlide 2: Why it matters | One reason\nSlide 3: What to do | Next step' : 'Clean photo that shows: ' + t,
    caption: 'DEMO DRAFT. ' + t + '.' + tweak + '\n\nTell us what you think in the comments.',
    hashtags: tag + ' #demo',
    cta: 'Visit us this week'
  };
  const out = {}; (FIELDS[it.type] || FIELDS.post).forEach(k => { out[k] = c[k] || ''; });
  out.summary = instruction ? 'Updated the draft to reflect your feedback.' : 'First draft written from the brief.';
  return out;
}
async function aiDraft(cl, it, instruction, current) {
  const out = MOCK ? mockDraft(cl, it, instruction) : extractJson(await llm(draftPrompt(cl, it, instruction, current), 3500));
  return normalizeDraft(out, it.type);
}
async function aiCalendar(cl, o) {
  const plats = (cl.platforms && cl.platforms.length) ? cl.platforms : ['Instagram'];
  const end = addDays(o.start, o.weeks * 7 - 1);
  const total = o.weeks * (o.posts + o.reels);
  let rows;
  if (MOCK) {
    rows = []; const pillars = lines(cl.pillars); let p = 0;
    for (let w = 0; w < o.weeks; w++) {
      for (let k = 0; k < o.posts + o.reels; k++) {
        const reel = k >= o.posts;
        const platform = plats[(w + k) % plats.length];
        rows.push({
          date: addDays(o.start, w * 7 + Math.min(6, Math.floor(k * 7 / Math.max(1, o.posts + o.reels)))),
          platform, type: reel && platform !== 'LinkedIn' ? 'reel' : (k % 2 ? 'carousel' : 'post'),
          pillar: pillars.length ? pillars[p++ % pillars.length] : 'General',
          topic: 'Demo idea ' + (rows.length + 1) + ' for ' + cl.name
        });
      }
    }
  } else {
    const recent = db.items.filter(i => i.clientId === cl.id).sort(byDate).slice(-25).map(i => i.topic).filter(Boolean);
    const prompt = `You are the senior content strategist at a social media agency called Mile 1. Plan a content calendar.\n\nCLIENT BRIEF\n${briefText(cl)}\n\nDATE RANGE\n${o.start} to ${end} inclusive (${o.weeks} week${o.weeks > 1 ? 's' : ''}, weeks start on Monday).\nPer week: ${o.posts} static posts or carousels (mix them) and ${o.reels} reels.\nPlatforms allowed: ${plats.join(', ')}.\n${o.focus ? 'Focus for this period: ' + o.focus + '\n' : ''}\nRules:\n- Dates are YYYY-MM-DD inside the range, spread across the week, at most 2 items on one day.\n- Reels only on Instagram, Facebook or YouTube Shorts. LinkedIn gets post or carousel.\n- Rotate the content pillars evenly and put each item's pillar in "pillar".\n- "topic" is one specific idea in a single sentence, not a theme.\n- Include relevant festivals or national days in the range for the client's market when they fit the brand.\n${recent.length ? '- Do not repeat these existing topics: ' + recent.join(' | ') + '\n' : ''}\nReply with only a JSON array of objects like {"date":"2026-11-02","platform":"Instagram","type":"reel","pillar":"Education","topic":"..."}. "type" is one of post, carousel, reel.`;
    rows = extractJson(await llm(prompt, 6000));
    if (!Array.isArray(rows)) throw httpError(502, 'The AI reply could not be read. Try again.');
  }
  return rows.filter(r => r && r.topic).slice(0, total + 4).map(r => {
    let date = isDate(r.date) ? r.date : o.start; if (date < o.start) date = o.start; if (date > end) date = end;
    const platform = plats.includes(r.platform) ? r.platform : plats[0];
    let type = TYPES.includes(r.type) ? r.type : 'post'; if (type === 'reel' && platform === 'LinkedIn') type = 'post';
    return { date, platform, type, pillar: str(r.pillar, 120), topic: str(r.topic, 400) };
  });
}
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const byDate = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.created || 0) - (b.created || 0);

/* ---------- email (optional, Resend) ---------- */
const mailOn = () => !!(RESEND_KEY && MAIL_FROM);
async function sendMail(to, subject, text) {
  if (!mailOn()) throw httpError(400, 'Email is not set up. Add RESEND_API_KEY and MAIL_FROM to the settings.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RESEND_KEY },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text })
  });
  if (!res.ok) throw httpError(502, 'Email could not be sent (' + res.status + ').');
}
function notifyAgency(subject, text) {
  if (mailOn() && NOTIFY_EMAIL) sendMail(NOTIFY_EMAIL, subject, text).catch(() => {});
}

/* ---------- domain logic ---------- */
const itemById = id => db.items.find(i => i.id === id);
const clientById = id => db.clients.find(c => c.id === id);
function need(v, status, msg) { if (!v) throw httpError(status || 404, msg || 'Not found'); return v; }
function pushHistory(it, oldContent) {
  if (hasText(oldContent)) it.history = [{ at: now(), content: oldContent }, ...(it.history || [])].slice(0, 6);
}
function sendItem(it) {
  if (!hasText(it.content)) throw httpError(400, 'Draft the content before sending it for review.');
  it.round = (it.round || 0) + 1;
  it.sent = { at: now(), round: it.round, content: JSON.parse(JSON.stringify(it.content)), date: it.date, platform: it.platform, type: it.type, pillar: it.pillar, topic: it.topic };
  it.status = 'review';
  it.revised = false;
  it.updated = now();
}
function addComment(it, fields) {
  const c = Object.assign({ id: uid(), itemId: it.id, clientId: it.clientId, round: it.round || 0, at: now(), triage: null, applied: false, seen: fields.author !== 'client' }, fields);
  db.comments.push(c);
  return c;
}
function cleanItemInput(b, base) {
  const o = {};
  if (b.date !== undefined) { if (!isDate(b.date)) throw httpError(400, 'Pick a valid date.'); o.date = b.date; }
  if (b.platform !== undefined) o.platform = str(b.platform, 40);
  if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw httpError(400, 'Unknown format.'); o.type = b.type; }
  if (b.pillar !== undefined) o.pillar = str(b.pillar, 120);
  if (b.topic !== undefined) o.topic = str(b.topic, 600);
  return Object.assign(base || {}, o);
}
function cleanContent(c) {
  const o = {};
  if (c && typeof c === 'object') Object.keys(FD).concat(['visual']).forEach(k => { if (c[k] !== undefined && k !== 'visual_post' && k !== 'visual_carousel') o[k] = str(c[k], 8000); });
  return o;
}
function csvFor(client) {
  const cols = [['Date', 'date'], ['Platform', 'platform'], ['Format', 'type'], ['Pillar', 'pillar'], ['Topic', 'topic'], ['Status', 'status'], ['Hook', 'hook'], ['Caption', 'caption'], ['Hashtags', 'hashtags'], ['CTA', 'cta'], ['Visual brief', 'visual'], ['Script', 'script'], ['Shot list', 'shots'], ['On-screen text', 'onscreen'], ['AI video prompt', 'videoPrompt']];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const its = db.items.filter(i => i.clientId === client.id).sort(byDate);
  return '﻿' + [cols.map(c => q(c[0])).join(',')].concat(its.map(i => cols.map(([, k]) => q(i[k] !== undefined ? i[k] : (i.content || {})[k])).join(','))).join('\n');
}
function unreadCount() { return db.comments.filter(c => c.author === 'client' && !c.seen).length; }

/* ---------- routes ---------- */
const routes = [];
function route(method, pattern, handler, opts) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: !(opts && opts.public) });
}
const A = (m, p, h) => route(m, p, h);
const P = (m, p, h) => route(m, p, h, { public: true });

/* auth */
P('POST', '/api/login', async ({ body, req, res }) => {
  const emailIn = String(body.email || '').trim().toLowerCase();
  if (await tooManyShared('login:' + clientIp(req) + ':' + emailIn, 8, 15 * 60e3)) throw httpError(429, 'Too many attempts. Wait 15 minutes and try again.');
  const u = db.users.find(x => x.email === emailIn);
  if (!u || !checkPw(String(body.password || ''), u.pw)) throw httpError(401, 'Email or password is wrong.');
  res.setHeader('Set-Cookie', cookieHeader(makeSession(u.id), SESSION_DAYS * 86400));
  return { ok: true };
});
P('POST', '/api/logout', async ({ res }) => { res.setHeader('Set-Cookie', cookieHeader('', 0)); return { ok: true }; });
A('POST', '/api/password', async ({ body, user }) => {
  if (!checkPw(String(body.current || ''), user.pw)) throw httpError(400, 'Current password is wrong.');
  if (String(body.next || '').length < 10) throw httpError(400, 'Use at least 10 characters.');
  user.pw = hashPw(String(body.next)); save(); return { ok: true };
});
A('GET', '/api/state', async ({ user }) => ({
  user: { id: user.id, email: user.email, name: user.name },
  clients: db.clients, items: db.items, comments: db.comments,
  config: { ai: MOCK ? 'demo' : 'live', mail: mailOn(), baseUrl: PUBLIC_URL + BASE }, unread: unreadCount()
}));

/* clients */
function cleanClient(b, base) {
  const o = base || {};
  ['name', 'industry', 'region', 'audience', 'voice', 'pillars', 'goals', 'notes', 'contactName', 'contactEmail', 'contactPhone'].forEach(k => { if (b[k] !== undefined) o[k] = str(b[k], 3000).trim(); });
  if (b.platforms !== undefined) o.platforms = (Array.isArray(b.platforms) ? b.platforms : []).filter(p => PLATFORMS.includes(p));
  if (b.postsPerWeek !== undefined) o.postsPerWeek = Math.max(0, Math.min(7, +b.postsPerWeek || 0));
  if (b.reelsPerWeek !== undefined) o.reelsPerWeek = Math.max(0, Math.min(7, +b.reelsPerWeek || 0));
  if (!o.name) throw httpError(400, 'Enter the client name.');
  return o;
}
A('POST', '/api/clients', async ({ body }) => {
  const c = cleanClient(body, { id: uid(), token: crypto.randomBytes(18).toString('base64url'), hue: (db.clients.length * 53 + 160) % 360, created: now() });
  if (!c.platforms || !c.platforms.length) throw httpError(400, 'Pick at least one platform.');
  db.clients.push(c); save(); return c;
});
A('PUT', '/api/clients/:id', async ({ params, body }) => {
  const c = need(clientById(params.id)); cleanClient(body, c);
  if (!c.platforms || !c.platforms.length) throw httpError(400, 'Pick at least one platform.');
  save(); return c;
});
A('DELETE', '/api/clients/:id', async ({ params }) => {
  need(clientById(params.id));
  db.clients = db.clients.filter(c => c.id !== params.id);
  db.items = db.items.filter(i => i.clientId !== params.id);
  db.comments = db.comments.filter(c => c.clientId !== params.id);
  save(); return { ok: true };
});
A('POST', '/api/clients/:id/regen-link', async ({ params }) => {
  const c = need(clientById(params.id)); c.token = crypto.randomBytes(18).toString('base64url'); save(); return c;
});
A('POST', '/api/clients/:id/calendar', async ({ params, body }) => {
  const c = need(clientById(params.id));
  const o = { start: body.start, weeks: Math.max(1, Math.min(4, +body.weeks || 4)), posts: Math.max(0, Math.min(7, +body.posts || 0)), reels: Math.max(0, Math.min(7, +body.reels || 0)), focus: str(body.focus, 600).trim() };
  if (!isDate(o.start)) throw httpError(400, 'Pick a start date.');
  if (o.posts + o.reels < 1) throw httpError(400, 'Set at least one post or reel per week.');
  const rows = await aiCalendar(c, o);
  const made = rows.map(r => ({ id: uid(), clientId: c.id, status: 'idea', content: {}, history: [], round: 0, sent: null, revised: false, created: now(), updated: now(), ...r }));
  db.items.push(...made); save();
  return { added: made.length };
});
A('GET', '/api/clients/:id/export.csv', async ({ params, res }) => {
  const c = need(clientById(params.id));
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${c.name.replace(/[^\w-]+/g, '-').toLowerCase()}-calendar.csv"` });
  res.end(csvFor(c)); return null;
});
A('POST', '/api/clients/:id/email', async ({ params, body }) => {
  const c = need(clientById(params.id));
  const to = String(body.to || c.contactEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw httpError(400, 'Enter a valid email address.');
  const text = str(body.message, 4000) || `Hi ${c.contactName || 'there'},\n\nYour content is ready to review: ${publicLink(c)}\n\nThanks,\nMile 1`;
  await sendMail(to, 'Content ready for your review', text);
  return { ok: true };
});

/* items */
A('POST', '/api/items', async ({ body }) => {
  const c = need(clientById(body.clientId), 400, 'Pick a client.');
  const it = cleanItemInput(body, { id: uid(), clientId: c.id, status: 'idea', content: {}, history: [], round: 0, sent: null, revised: false, created: now(), updated: now() });
  if (!it.date) throw httpError(400, 'Pick a date.');
  it.platform = it.platform || (c.platforms || ['Instagram'])[0]; it.type = it.type || 'post'; it.pillar = it.pillar || ''; it.topic = it.topic || '';
  if (body.content) { it.content = cleanContent(body.content); if (hasText(it.content)) it.status = 'drafted'; }
  db.items.push(it); save(); return it;
});
A('PUT', '/api/items/:id', async ({ params, body }) => {
  const it = need(itemById(params.id));
  cleanItemInput(body, it);
  if (body.content !== undefined) {
    const next = Object.assign({}, it.content || {}, cleanContent(body.content));
    if (JSON.stringify(next) !== JSON.stringify(it.content || {})) {
      pushHistory(it, it.content); it.content = next;
      if (it.status === 'idea' && hasText(next)) it.status = 'drafted';
    }
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw httpError(400, 'Unknown status.');
    if (body.status === 'review') sendItem(it);
    else if (body.status !== it.status) it.status = body.status;
  }
  it.updated = now(); save(); return it;
});
A('DELETE', '/api/items/:id', async ({ params }) => {
  need(itemById(params.id));
  db.items = db.items.filter(i => i.id !== params.id);
  db.comments = db.comments.filter(c => c.itemId !== params.id);
  save(); return { ok: true };
});
A('POST', '/api/items/:id/draft', async ({ params, body }) => {
  const it = need(itemById(params.id)), c = need(clientById(it.clientId));
  const instruction = str(body.instruction, 1500).trim();
  const current = hasText(it.content) && instruction ? it.content : null;
  const { content, summary } = await aiDraft(c, it, instruction || null, current);
  pushHistory(it, it.content);
  it.content = Object.assign({}, it.content || {}, content);
  if (it.status === 'idea') it.status = 'drafted';
  it.updated = now(); save(); return { item: it, summary };
});
A('POST', '/api/items/:id/restore', async ({ params, body }) => {
  const it = need(itemById(params.id)), h = (it.history || [])[+body.index];
  need(h, 400, 'That version is gone.');
  const old = it.content; it.content = h.content;
  it.history = [{ at: now(), content: old }, ...it.history.filter((_, j) => j !== +body.index)].slice(0, 6);
  it.updated = now(); save(); return it;
});
A('POST', '/api/items/:id/send', async ({ params }) => {
  const it = need(itemById(params.id)); sendItem(it); save(); return it;
});
A('POST', '/api/items/:id/seen', async ({ params }) => {
  db.comments.filter(c => c.itemId === params.id).forEach(c => { c.seen = true; }); save(); return { ok: true };
});
A('POST', '/api/items/:id/comments', async ({ params, body }) => {
  const it = need(itemById(params.id));
  const text = str(body.text, 3000).trim(); if (!text) throw httpError(400, 'Write a comment first.');
  const kind = body.kind === 'note' ? 'note' : 'reply';
  const c = addComment(it, { author: 'agency', name: 'Mile 1', kind, text }); save(); return c;
});
A('PUT', '/api/comments/:id', async ({ params, body }) => {
  const c = need(db.comments.find(x => x.id === params.id));
  if (c.author !== 'client' || c.kind !== 'change') throw httpError(400, 'Only client change requests can be triaged.');
  if (body.triage !== undefined) { if (![null, 'accepted', 'ignored'].includes(body.triage)) throw httpError(400, 'Bad value.'); c.triage = body.triage; }
  if (body.text !== undefined) c.agencyText = str(body.text, 3000);
  c.seen = true; save(); return c;
});
A('POST', '/api/items/:id/apply', async ({ params, body }) => {
  const it = need(itemById(params.id)), cl = need(clientById(it.clientId));
  const picked = db.comments.filter(c => c.itemId === it.id && c.author === 'client' && c.kind === 'change' && c.triage === 'accepted' && !c.applied);
  if (!picked.length) throw httpError(400, 'Accept at least one client comment first.');
  const instruction = picked.map((c, i) => `${i + 1}. ${c.agencyText != null && c.agencyText !== '' ? c.agencyText : c.text}`).join('\n');
  const { content, summary } = await aiDraft(cl, it, instruction, it.content);
  pushHistory(it, it.content);
  it.content = Object.assign({}, it.content || {}, content);
  it.status = 'drafted'; it.revised = true; it.updated = now();
  picked.forEach(c => { c.applied = true; });
  db.comments.filter(c => c.itemId === it.id && c.author === 'client' && c.kind === 'change' && c.triage === 'ignored' && !c.applied).forEach(c => { c.applied = true; });
  const note = str(body.note, 1500).trim() || summary || 'Updated based on your comments.';
  addComment(it, { author: 'agency', name: 'Mile 1', kind: 'resolved', text: note, round: it.round });
  save(); return it;
});
A('POST', '/api/items/:id/resend', async ({ params, body }) => {
  const it = need(itemById(params.id));
  if (it.status !== 'changes' && it.status !== 'drafted') throw httpError(400, 'This item is not waiting to be resent.');
  db.comments.filter(c => c.itemId === it.id && c.author === 'client' && c.kind === 'change' && !c.applied).forEach(c => { c.applied = true; if (!c.triage) c.triage = 'ignored'; });
  const note = str(body.note, 1500).trim();
  sendItem(it);
  if (note) addComment(it, { author: 'agency', name: 'Mile 1', kind: 'reply', text: note });
  save(); return it;
});
A('GET', '/api/export', async ({ res }) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="mile1-backup.json"' });
  res.end(JSON.stringify({ clients: db.clients, items: db.items, comments: db.comments }, null, 2)); return null;
});

/* client review portal (no login, private link) */
const portalClient = token => db.clients.find(c => c.token === token);
function portalState(it) {
  if (it.status === 'review') return 'awaiting';
  if (it.status === 'approved' || it.status === 'published') return 'approved';
  return 'revising';
}
P('GET', '/r/:token/data', async ({ params }) => {
  const c = need(portalClient(params.token), 404, 'This link is not valid.');
  const items = db.items.filter(i => i.clientId === c.id && i.sent).sort(byDate).map(i => ({
    id: i.id, date: i.sent.date, platform: i.sent.platform, type: i.sent.type, pillar: i.sent.pillar, topic: i.sent.topic,
    content: i.sent.content, round: i.sent.round, state: portalState(i),
    comments: db.comments.filter(x => x.itemId === i.id && CLIENT_VISIBLE.includes(x.kind)).sort((a, b) => a.at - b.at).map(x => ({ id: x.id, author: x.author, name: x.name, kind: x.kind, text: x.text, at: x.at, round: x.round }))
  }));
  return { client: { name: c.name, contactName: c.contactName || '' }, items };
});
function portalGuard(req, params) {
  if (tooMany('portal:' + params.token + ':' + clientIp(req), 60, 60e3)) throw httpError(429, 'Slow down and try again in a minute.');
}
P('POST', '/r/:token/approve/:id', async ({ params, body, req }) => {
  portalGuard(req, params);
  const c = need(portalClient(params.token)), it = need(itemById(params.id));
  if (it.clientId !== c.id || !it.sent) throw httpError(404, 'Not found');
  if (it.status !== 'review') throw httpError(409, 'This item is not waiting for approval.');
  it.status = 'approved'; it.updated = now();
  addComment(it, { author: 'client', name: str(body.name, 80).trim() || 'Client', kind: 'approve', text: 'Approved' });
  save();
  notifyAgency(`${c.name} approved a ${it.type}`, `${c.name} approved: ${it.topic}\n${PUBLIC_URL}${BASE}/`);
  return { ok: true };
});
P('POST', '/r/:token/changes/:id', async ({ params, body, req }) => {
  portalGuard(req, params);
  const c = need(portalClient(params.token)), it = need(itemById(params.id));
  if (it.clientId !== c.id || !it.sent) throw httpError(404, 'Not found');
  if (it.status !== 'review') throw httpError(409, 'This item is not waiting for approval.');
  const text = str(body.text, 3000).trim(); if (!text) throw httpError(400, 'Describe what should change.');
  it.status = 'changes'; it.updated = now();
  addComment(it, { author: 'client', name: str(body.name, 80).trim() || 'Client', kind: 'change', text });
  save();
  notifyAgency(`${c.name} asked for changes`, `${c.name} on "${it.topic}":\n\n${text}\n\n${PUBLIC_URL}${BASE}/`);
  return { ok: true };
});
P('POST', '/r/:token/undo/:id', async ({ params, req }) => {
  portalGuard(req, params);
  const c = need(portalClient(params.token)), it = need(itemById(params.id));
  if (it.clientId !== c.id || !it.sent) throw httpError(404, 'Not found');
  const last = db.comments.filter(x => x.itemId === it.id && x.author === 'client' && x.round === it.round).sort((a, b) => b.at - a.at)[0];
  const undoable = last && ((it.status === 'approved' && last.kind === 'approve') || (it.status === 'changes' && last.kind === 'change' && !last.applied));
  if (!undoable) throw httpError(409, 'This response can no longer be undone.');
  db.comments = db.comments.filter(x => x.id !== last.id);
  it.status = 'review'; it.updated = now(); save(); return { ok: true };
});

/* ---------- static pages ---------- */
const PUB = path.join(__dirname, 'public');
const pages = {};
function page(name) {
  if (!pages[name] || process.env.NODE_ENV !== 'production') {
    pages[name] = fs.readFileSync(path.join(PUB, name), 'utf8').replace(/%%BASE%%/g, BASE);
  }
  return pages[name];
}
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  'cache-control': 'no-store'
};

/* ---------- server ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > 1e6) { reject(httpError(413, 'Request too large.')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(httpError(400, 'Bad request.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, SECURITY));
  res.end(JSON.stringify(obj));
}
function sendHtml(res, html, noindex) {
  res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, SECURITY, noindex ? { 'x-robots-tag': 'noindex, nofollow' } : {}));
  res.end(html);
}
async function handle(req, res) {
  let p = decodeURI((req.url || '/').split('?')[0]);
  if (BASE && (p === BASE || p.startsWith(BASE + '/'))) p = p.slice(BASE.length) || '/';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && p === '/') return sendHtml(res, page('app.html'), true);
    if (req.method === 'GET' && p === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' });
      return res.end(fs.readFileSync(path.join(PUB, 'style.css')));
    }
    if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, storage: REDIS ? 'redis' : 'file' });
    if (req.method === 'GET' && p === '/api/version') {
      let v = VER;
      if (REDIS) { const [x] = await rcall([['GET', 'm1:ver']]); v = +x || 0; }
      return sendJson(res, 200, { v });
    }
    const pm = /^\/r\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && pm) return sendHtml(res, page('review.html'), true);
    if (REDIS) { await ready(); await loadRemote(); } // fresh data on every request: any server instance may answer
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p); if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let user = null;
      if (r.auth) {
        user = readSession(req);
        if (!user) return sendJson(res, 401, { error: 'Sign in to continue.' });
        if (req.method !== 'GET' && req.headers['x-m1'] !== '1') return sendJson(res, 403, { error: 'Blocked.' });
      } else if (req.method !== 'GET' && req.headers['x-m1'] !== '1') return sendJson(res, 403, { error: 'Blocked.' });
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler({ req, res, params, body, user });
      if (out === null || res.headersSent) return;
      await persist(); // write changes to Redis before replying, so a serverless function cannot stop first
      return sendJson(res, 200, out);
    }
    sendJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (res.headersSent) return;
    const status = e.status || 500;
    if (status === 500) console.error(e);
    sendJson(res, status, { error: status === 500 ? 'Something went wrong. Try again.' : e.message });
  }
}

function boot() {
  if (REDIS) ready().catch(e => console.error('Storage:', e.message)); else load();
  if (!REDIS && !db.users.length) {
    const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    let pw = process.env.ADMIN_PASSWORD || '';
    let generated = false;
    if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
    db.users.push({ id: uid(), email: email || 'admin@example.com', name: 'Mile 1', pw: hashPw(pw), created: now() });
    saveNow();
    console.log('Created the first user: ' + (email || 'admin@example.com'));
    if (generated) console.log('Temporary password (change it after signing in): ' + pw);
  }
  const server = http.createServer(handle);
  server.listen(PORT, () => {
    console.log(`Mile 1 platform running on port ${PORT}${BASE ? ' at path ' + BASE : ''}. AI: ${MOCK ? (KNOWN_PROVIDER ? 'demo mode (no AI_API_KEY set)' : 'demo mode (AI_PROVIDER "' + AI_PROVIDER + '" is not one of anthropic, gemini, openai)') : 'live (' + AI_PROVIDER + ', ' + (AI_MODEL || 'model not set') + ')'}.`);
  });
  const stop = () => { if (saveTimer) { clearTimeout(saveTimer); saveNow(); } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}
/* Entry for serverless hosts (see api/index.js). */
async function handler(req, res) {
  try { await ready(); } catch (e) { return sendJson(res, 503, { error: e.message || 'Storage is unavailable.' }); }
  return handle(req, res);
}
if (require.main === module) boot();
module.exports = { boot, handler, REDIS };
