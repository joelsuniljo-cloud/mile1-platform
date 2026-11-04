'use strict';
/* Postgres storage for the multi-company (SaaS) mode.
   Every row carries org_id. A request loads ONE company's rows, works on them in memory, and writes back only
   what changed, in one transaction. Documents are kept as JSONB so the app code did not have to change shape.
   Set DATABASE_URL for a real database (Neon, Supabase, Render, RDS ...). M1_PGLITE=1 runs an in-memory Postgres
   (tests only). */
const COLS = ['users', 'clients', 'items', 'comments'];
let Q = null; // { query(sql, params) -> {rows}, tx(fn(q)) }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orgs (id text PRIMARY KEY, ver bigint NOT NULL DEFAULT 0, data jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, data jsonb NOT NULL,
     email text GENERATED ALWAYS AS (lower(data->>'email')) STORED)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users(email)`,
  `CREATE INDEX IF NOT EXISTS users_org_ix ON users(org_id)`,
  `CREATE TABLE IF NOT EXISTS clients (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, data jsonb NOT NULL,
     token text GENERATED ALWAYS AS (data->>'token') STORED)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS clients_token_uq ON clients(token)`,
  `CREATE INDEX IF NOT EXISTS clients_org_ix ON clients(org_id)`,
  `CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, data jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS items_org_ix ON items(org_id)`,
  `CREATE TABLE IF NOT EXISTS comments (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, data jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS comments_org_ix ON comments(org_id)`,
  `CREATE TABLE IF NOT EXISTS images (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, bytes bytea NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS images_org_ix ON images(org_id)`,
  `CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS limits (k text PRIMARY KEY, n int NOT NULL, until bigint NOT NULL)`
];

async function init() {
  if (Q) return;
  if (process.env.M1_PGLITE === '1') {
    const { PGlite } = require('@electric-sql/pglite');
    const lite = new PGlite();
    Q = { query: (s, p) => lite.query(s, p), tx: fn => lite.transaction(t => fn((s, p) => t.query(s, p))) };
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: +process.env.PG_POOL_MAX || 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    pool.on('error', e => console.error('Database connection problem:', e.message));
    Q = {
      query: (s, p) => pool.query(s, p),
      tx: async fn => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn((s, p) => c.query(s, p)); await c.query('COMMIT'); return r; }
        catch (e) { try { await c.query('ROLLBACK'); } catch (e2) { /* connection already gone */ } throw e; }
        finally { c.release(); }
      }
    };
  }
  await Q.tx(async q => {
    await q('SELECT pg_advisory_xact_lock(727201)'); // two servers starting together must not race on the schema
    for (const s of SCHEMA) await q(s);
  });
}

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

/* Load one company. Returns null when it does not exist. */
async function loadOrg(orgId) {
  const o = await Q.query('SELECT data, ver FROM orgs WHERE id = $1', [orgId]);
  if (!o.rows.length) return null;
  const rest = await Promise.all(COLS.map(c => Q.query(`SELECT id, data FROM ${c} WHERE org_id = $1`, [orgId])));
  const data = {}, snap = {};
  COLS.forEach((c, i) => {
    data[c] = rest[i].rows.map(r => parse(r.data));
    snap[c] = {}; data[c].forEach(x => { snap[c][x.id] = JSON.stringify(x); });
  });
  const org = parse(o.rows[0].data);
  return { orgId, org, data, snap, orgSnap: JSON.stringify(org), ver: Number(o.rows[0].ver) };
}

/* Write only what changed. Returns true when anything was written. */
async function persistOrg(s) {
  const stmts = [], next = {};
  for (const c of COLS) {
    const cur = {}; s.data[c].forEach(o => { cur[o.id] = JSON.stringify(o); });
    const ids = [], docs = [];
    Object.keys(cur).forEach(id => { if (s.snap[c][id] !== cur[id]) { ids.push(id); docs.push(cur[id]); } });
    if (ids.length) {
      stmts.push([`INSERT INTO ${c} (id, org_id, data) SELECT t.id, $3::text, t.d::jsonb FROM unnest($1::text[], $2::text[]) AS t(id, d)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data WHERE ${c}.org_id = EXCLUDED.org_id`, [ids, docs, s.orgId]]);
    }
    const del = Object.keys(s.snap[c]).filter(id => !(id in cur));
    if (del.length) stmts.push([`DELETE FROM ${c} WHERE org_id = $1 AND id = ANY($2::text[])`, [s.orgId, del]]);
    next[c] = cur;
  }
  const orgJson = JSON.stringify(s.org), orgChanged = orgJson !== s.orgSnap;
  if (!stmts.length && !orgChanged) return false;
  stmts.push(orgChanged ? ['UPDATE orgs SET data = $2::jsonb, ver = ver + 1 WHERE id = $1', [s.orgId, orgJson]] : ['UPDATE orgs SET ver = ver + 1 WHERE id = $1', [s.orgId]]);
  await Q.tx(async q => { for (const [sql, p] of stmts) await q(sql, p); });
  s.snap = next; s.orgSnap = orgJson;
  return true;
}

/* Create a company and its first user together, or neither. */
async function createOrg(org, user) {
  try {
    await Q.tx(async q => {
      await q('INSERT INTO orgs (id, data) VALUES ($1, $2::jsonb)', [org.id, JSON.stringify(org)]);
      await q('INSERT INTO users (id, org_id, data) VALUES ($1, $2, $3::jsonb)', [user.id, org.id, JSON.stringify(user)]);
    });
  } catch (e) {
    if (e && e.code === '23505') { const err = new Error('EMAIL_TAKEN'); err.code = 'EMAIL_TAKEN'; throw err; }
    throw e;
  }
}
async function emailTaken(email) { return (await Q.query('SELECT 1 FROM users WHERE email = $1', [String(email).toLowerCase()])).rows.length > 0; }
async function userByEmail(email) {
  const r = await Q.query('SELECT org_id, data FROM users WHERE email = $1', [String(email).toLowerCase()]);
  return r.rows.length ? Object.assign({}, parse(r.rows[0].data), { orgId: r.rows[0].org_id }) : null;
}
async function userOrgId(userId) {
  const r = await Q.query('SELECT org_id FROM users WHERE id = $1', [userId]);
  return r.rows.length ? r.rows[0].org_id : null;
}
async function orgIdByToken(token) {
  if (!token || String(token).length < 10) return null;
  const r = await Q.query('SELECT org_id FROM clients WHERE token = $1', [String(token)]);
  return r.rows.length ? r.rows[0].org_id : null;
}
async function versionForUser(userId) {
  const r = await Q.query('SELECT o.ver FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = $1', [userId]);
  return r.rows.length ? Number(r.rows[0].ver) : 0;
}
async function countUsers() { return Number((await Q.query('SELECT count(*) AS n FROM users')).rows[0].n); }

/* pictures */
async function imgPut(orgId, id, buf) {
  await Q.query('INSERT INTO images (id, org_id, bytes) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET bytes = EXCLUDED.bytes WHERE images.org_id = EXCLUDED.org_id', [id, orgId, buf]);
}
async function imgGet(orgId, id) {
  const r = await Q.query('SELECT bytes FROM images WHERE id = $1 AND org_id = $2', [id, orgId]);
  return r.rows.length ? Buffer.from(r.rows[0].bytes) : null;
}
async function imgDel(orgId, ids) { await Q.query('DELETE FROM images WHERE org_id = $1 AND id = ANY($2::text[])', [orgId, ids]); }

/* settings and limits shared by every server instance */
async function kvGet(k) { const r = await Q.query('SELECT v FROM kv WHERE k = $1', [k]); return r.rows.length ? r.rows[0].v : null; }
async function kvSetNx(k, v) { await Q.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', [k, v]); return kvGet(k); }
async function hit(key, limit, windowMs) {
  const t = Date.now();
  const r = await Q.query(`INSERT INTO limits (k, n, until) VALUES ($1, 1, $3) ON CONFLICT (k) DO UPDATE SET
      n = CASE WHEN limits.until < $2 THEN 1 ELSE limits.n + 1 END, until = CASE WHEN limits.until < $2 THEN $3 ELSE limits.until END RETURNING n`, [key, t, t + windowMs]);
  if (Math.random() < 0.01) Q.query('DELETE FROM limits WHERE until < $1', [t]).catch(() => {});
  return Number(r.rows[0].n) > limit;
}
async function ping() { await Q.query('SELECT 1'); }

module.exports = { COLS, init, loadOrg, persistOrg, createOrg, emailTaken, userByEmail, userOrgId, orgIdByToken, versionForUser, countUsers, imgPut, imgGet, imgDel, kvGet, kvSetNx, hit, ping };
