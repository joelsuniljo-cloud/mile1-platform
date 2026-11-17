'use strict';
/* Mile 1 bridge for ComfyUI: runs on your own PC, next to ComfyUI, and lets the Mile 1 platform make videos there.

   What it does: the platform sends a job (prompt, size, length, optional start picture). The bridge puts these into
   YOUR exported ComfyUI workflow (workflow.json, saved next to this file), queues it in ComfyUI, and hands the finished
   video back. Nothing else in ComfyUI is reachable from outside, and every request must carry your secret token.

   Start it:   BRIDGE_TOKEN=some-long-secret node comfy-bridge.js
   Windows:    set BRIDGE_TOKEN=some-long-secret   then   node comfy-bridge.js
   Settings (optional): COMFY_URL (default http://127.0.0.1:8188), BRIDGE_PORT (default 8190), WORKFLOW (default ./workflow.json),
   AUTOSET=0 to stop the bridge from setting width, height, frames, frame rate and seed in the workflow.
   No packages to install. Needs Node 18 or newer. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const COMFY = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const PORT = +process.env.BRIDGE_PORT || 8190;
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const WORKFLOW = path.resolve(process.env.WORKFLOW || path.join(__dirname, 'workflow.json'));
const AUTOSET = process.env.AUTOSET !== '0';
if (TOKEN.length < 16) { console.error('Set BRIDGE_TOKEN to a secret of at least 16 characters, the same value as COMFYUI_TOKEN on the platform.'); process.exit(1); }

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
const FRAME_KEYS = ['length', 'num_frames', 'frames', 'video_length', 'frame_count'], FPS_KEYS = ['frame_rate', 'fps'], SEED_KEYS = ['seed', 'noise_seed'];
const isNum = v => typeof v === 'number' && isFinite(v);
const sameToken = t => { const a = Buffer.from(String(t || '')), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
class Fail extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function loadWorkflow() {
  let raw; try { raw = fs.readFileSync(WORKFLOW, 'utf8'); } catch (e) { throw new Fail(500, 'No workflow.json next to the bridge. In ComfyUI, open your LTX workflow, type {{PROMPT}} in the prompt box, then Workflow > Export (API) and save it as ' + WORKFLOW); }
  let wf; try { wf = JSON.parse(raw); } catch (e) { throw new Fail(500, 'workflow.json is not valid JSON. Export it again with Export (API).'); }
  if (wf && Array.isArray(wf.nodes) && wf.links) throw new Fail(500, 'workflow.json was saved in the normal format. Use Workflow > Export (API) instead.');
  if (!wf || typeof wf !== 'object' || !Object.values(wf).some(n => n && n.class_type && n.inputs)) throw new Fail(500, 'workflow.json does not look like a ComfyUI API workflow.');
  return wf;
}
/* Puts the job into the workflow. Returns notes about what was set. */
function fill(wf, job, imageName) {
  const notes = []; let hasPrompt = false, loaders = 0;
  for (const node of Object.values(wf)) {
    if (!node || !node.inputs) continue; const inp = node.inputs, cls = String(node.class_type || '');
    for (const k of Object.keys(inp)) {
      if (typeof inp[k] !== 'string') continue;
      if (inp[k].includes('{{PROMPT}}')) { inp[k] = inp[k].split('{{PROMPT}}').join(job.prompt); hasPrompt = true; }
      if (inp[k].includes('{{NEGATIVE}}')) inp[k] = inp[k].split('{{NEGATIVE}}').join(job.negative || '');
    }
    if (cls === 'LoadImage' || /LoadImage$/.test(cls)) { loaders++; if (imageName) inp.image = imageName; }
    if (!AUTOSET) continue;
    const frameKey = FRAME_KEYS.find(k => isNum(inp[k]));
    if (isNum(inp.width) && isNum(inp.height) && (frameKey || /latent|ltx|video/i.test(cls)) && !/upscale|resize|scale/i.test(cls)) { inp.width = job.width; inp.height = job.height; notes.push(cls + ': ' + job.width + 'x' + job.height); }
    if (frameKey && job.frames) { inp[frameKey] = job.frames; notes.push(cls + ': ' + job.frames + ' frames'); }
    FPS_KEYS.forEach(k => { if (isNum(inp[k]) && job.fps) inp[k] = job.fps; });
    SEED_KEYS.forEach(k => { if (isNum(inp[k])) inp[k] = job.seed; });
  }
  if (!hasPrompt) throw new Fail(400, 'The workflow has no {{PROMPT}}. Type {{PROMPT}} in the positive prompt box in ComfyUI and export again with Export (API).');
  if (loaders && !imageName) throw new Fail(400, 'This workflow starts from a picture (it has a Load Image node). Add a reference image to the reel, or export a text-to-video workflow.');
  if (!loaders && imageName) notes.push('the workflow has no Load Image node, so the reference image was not used');
  return notes;
}
async function comfy(p, opts) {
  let r; try { r = await fetch(COMFY + p, opts); } catch (e) { throw new Fail(502, 'ComfyUI is not running at ' + COMFY + '. Start ComfyUI first.'); }
  return r;
}
async function uploadImage(dataUrl) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); if (!m) throw new Fail(400, 'The start picture must be a PNG, JPEG or WebP.');
  const f = new FormData(); f.append('image', new Blob([Buffer.from(m[3], 'base64')], { type: m[1] }), 'mile1-' + Date.now() + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2])); f.append('overwrite', 'true');
  const r = await comfy('/upload/image', { method: 'POST', body: f }); if (!r.ok) throw new Fail(502, 'ComfyUI did not accept the picture (' + r.status + ').');
  const j = await r.json(); return j.subfolder ? j.subfolder + '/' + j.name : j.name;
}
function comfyError(j) {
  if (!j) return '';
  if (j.error && j.error.message) { const ne = j.node_errors && Object.values(j.node_errors)[0]; return j.error.message + (ne && ne.errors && ne.errors[0] ? ': ' + (ne.class_type || '') + ' ' + ne.errors[0].message + (ne.errors[0].details ? ' (' + ne.errors[0].details + ')' : '') : ''); }
  return '';
}
function findVideo(outputs) {
  for (const out of Object.values(outputs || {})) for (const list of Object.values(out || {})) if (Array.isArray(list)) for (const f of list) if (f && f.filename && VIDEO_EXT.test(f.filename)) return f;
  return null;
}
async function status(id) {
  const h = await comfy('/history/' + encodeURIComponent(id)); const hist = h.ok ? await h.json() : {}; const e = hist && hist[id];
  if (e) {
    const st = e.status || {};
    if (st.status_str === 'error') { const m = (st.messages || []).find(x => x[0] === 'execution_error'); return { state: 'failed', error: (m && m[1] && (m[1].exception_message || m[1].exception_type)) || 'ComfyUI stopped with an error. Check the ComfyUI window.' }; }
    const f = findVideo(e.outputs); if (f) return { state: 'done', file: { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' } };
    if (st.completed) return { state: 'failed', error: 'The workflow finished but saved no video. Make sure it ends with a Save Video node.' };
  }
  const q = await comfy('/queue'); const qq = q.ok ? await q.json() : {};
  if ((qq.queue_running || []).some(x => x[1] === id)) return { state: 'running' };
  const pend = (qq.queue_pending || []).map(x => x[1]); const pos = pend.indexOf(id);
  if (pos >= 0) return { state: 'queued', position: pos };
  return e ? { state: 'running' } : { state: 'missing', error: 'ComfyUI no longer knows this job. It may have restarted. Make the video again.' };
}
const files = new Map();   // job id -> output file, remembered after the first finished check
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readJson(req, limit) {
  return new Promise((ok, no) => { let n = 0; const parts = []; req.on('data', c => { n += c.length; if (n > limit) { no(new Fail(413, 'Too large.')); req.destroy(); } else parts.push(c); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { no(new Fail(400, 'Bad JSON.')); } }); req.on('error', no); });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!sameToken(auth)) return send(res, 401, { error: 'Wrong or missing bridge token.' });
    if (req.method === 'GET' && url.pathname === '/health') {
      let comfyOk = false, wfOk = false, prompt = false, loader = false, err = '';
      try { const r = await fetch(COMFY + '/system_stats'); comfyOk = r.ok; } catch (e) { err = 'ComfyUI is not running at ' + COMFY + '.'; }
      try { const wf = loadWorkflow(); wfOk = true; const s = JSON.stringify(wf); prompt = s.includes('{{PROMPT}}'); loader = Object.values(wf).some(n => n && /LoadImage$/.test(String(n.class_type || ''))); if (!prompt) err = err || 'workflow.json has no {{PROMPT}}.'; } catch (e) { err = err || e.message; }
      return send(res, 200, { ok: comfyOk && wfOk && prompt, comfy: comfyOk, workflow: wfOk, prompt, startImage: loader, error: err });
    }
    if (req.method === 'POST' && url.pathname === '/job') {
      const job = await readJson(req, 12e6);
      if (!job.prompt || typeof job.prompt !== 'string') throw new Fail(400, 'No prompt.');
      job.seed = isNum(job.seed) ? job.seed : Math.floor(Math.random() * 2 ** 31);
      const wf = loadWorkflow(), imageName = job.image ? await uploadImage(job.image) : '';
      const notes = fill(wf, job, imageName);
      const r = await comfy('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'mile1-bridge' }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.prompt_id) throw new Fail(400, 'ComfyUI refused the workflow. ' + (comfyError(j) || ('Error ' + r.status + '.')));
      console.log(new Date().toLocaleTimeString(), 'queued', j.prompt_id, job.width + 'x' + job.height, job.frames + ' frames');
      return send(res, 200, { id: j.prompt_id, notes });
    }
    let m = /^\/job\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) { const s = await status(m[1]); if (s.file) files.set(m[1], s.file); return send(res, 200, s); }
    m = /^\/job\/([\w-]+)\/video$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      let f = files.get(m[1]); if (!f) { const s = await status(m[1]); f = s.file; } if (!f) return send(res, 404, { error: 'No video for this job yet.' });
      const v = await comfy('/view?' + new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type }));
      if (!v.ok || !v.body) return send(res, 502, { error: 'ComfyUI could not send the video file.' });
      res.writeHead(200, { 'content-type': /\.webm$/i.test(f.filename) ? 'video/webm' : /\.gif$/i.test(f.filename) ? 'image/gif' : 'video/mp4', 'cache-control': 'no-store' });
      for await (const c of v.body) res.write(c); return res.end();
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) { send(res, e.code || 500, { error: e.message || 'Something went wrong.' }); if (!e.code) console.error(e); }
});
server.listen(PORT, HOST, () => console.log(`Mile 1 bridge running on http://${HOST}:${PORT}  ->  ComfyUI ${COMFY}\nWorkflow: ${WORKFLOW}\nKeep this window open while you make reels.`));
