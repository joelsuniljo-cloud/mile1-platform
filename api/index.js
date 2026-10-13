'use strict';
/* Vercel entry. vercel.json rewrites /platform/... to /api/index?p=/..., and this puts the original path back. */
const { handler, REDIS } = require('../server.js');

module.exports = async (req, res) => {
  if (!REDIS) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Database not connected. In Vercel, open the project, go to Storage, and connect an Upstash Redis database. Then redeploy.' }));
  }
  const u = new URL(req.url, 'http://local');
  let p = u.searchParams.get('p') || '/';
  if (!p.startsWith('/')) p = '/' + p;
  req.url = (process.env.BASE_PATH || '').replace(/\/+$/, '') + p;
  return handler(req, res);
};
