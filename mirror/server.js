// Patronus mirror: a self-hosted page that records what a website can see about a visitor.
// GET  /mirror/?label=X  -> probe page (server notes request headers and their order)
// POST /mirror/report    -> probe results, joined to the page request by token
// Reports append to $MIRROR_DATA/reports.jsonl. No read endpoint: read the file on Alpha.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.MIRROR_DATA || '/var/lib/patronus-mirror';
const prefix = process.env.MIRROR_PREFIX || '/mirror';
const port = Number(process.env.PORT || 8807);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const page = readFileSync(join(here, 'probe.html'), 'utf8');
const visits = new Map(); // token -> server-side view of the page request

const headerView = (req) => {
  const names = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(req.rawHeaders[i].toLowerCase());
  const pick = {};
  for (const n of names) if (!['cookie', 'authorization'].includes(n)) pick[n] = req.headers[n];
  return { order: names, headers: pick, httpVersion: req.httpVersion, ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress };
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method === 'GET' && (url.pathname === prefix || url.pathname === prefix + '/')) {
    const token = randomUUID();
    const label = (url.searchParams.get('label') || 'unlabeled').replace(/[^\w.:-]/g, '').slice(0, 60);
    visits.set(token, { at: new Date().toISOString(), label, page: headerView(req) });
    if (visits.size > 500) visits.delete(visits.keys().next().value);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page.replace('__TOKEN__', token).replace('__PREFIX__', prefix));
  }
  if (req.method === 'POST' && url.pathname === prefix + '/report') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512000) req.destroy(); });
    req.on('end', () => {
      let probe;
      try { probe = JSON.parse(body); } catch { res.statusCode = 400; return res.end('bad json'); }
      const visit = visits.get(probe.token) || { label: 'unknown-token', page: null };
      const record = { ...visit, reportedAt: new Date().toISOString(), report: headerView(req), probe };
      appendFileSync(join(dataDir, 'reports.jsonl'), JSON.stringify(record) + '\n');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, label: visit.label, pageHeaders: visit.page }));
    });
    return;
  }
  res.statusCode = 404; res.end('not found');
}).listen(port, '127.0.0.1', () => console.log('mirror listening', port));
