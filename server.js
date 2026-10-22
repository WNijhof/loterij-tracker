'use strict';
// Loterij Tracker – kleine server zonder dependencies.
// Serveert public/index.html en bewaart alle gegevens in één JSON-bestand in DATA_DIR.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const USER = process.env.TRACKER_USER || '';
const PASS = process.env.TRACKER_PASSWORD || '';
const NO_AUTH = process.env.TRACKER_NO_AUTH === '1';
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS) || 48;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BODY = 5 * 1024 * 1024;

const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

if (!NO_AUTH && (!USER || !PASS)) {
  console.error('Stel TRACKER_USER en TRACKER_PASSWORD in (of TRACKER_NO_AUTH=1 als je reverse proxy de toegang al afschermt).');
  process.exit(1);
}

// ---------- opslag ----------
let state = { version: 0, data: { deelnemers: [], acties: [], loten: [], opbrengsten: [], meta: {} } };
try {
  const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (typeof j.version === 'number' && j.data) state = j;
} catch (e) {
  // een onleesbaar bestand nooit overschrijven
  if (e.code !== 'ENOENT') { console.error(`${DATA_FILE} is onleesbaar: ${e.message}`); process.exit(1); }
}

let lastBackup = 0;
let queue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state);
  queue = queue.then(async () => {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, DATA_FILE);
    if (Date.now() - lastBackup < BACKUP_INTERVAL_MS) return;
    lastBackup = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.writeFile(path.join(BACKUP_DIR, `data-${stamp}.json`), snapshot, { mode: 0o600 });
    const oud = (await fsp.readdir(BACKUP_DIR)).filter(f => f.startsWith('data-')).sort().slice(0, -KEEP_BACKUPS);
    await Promise.all(oud.map(f => fsp.unlink(path.join(BACKUP_DIR, f))));
  }).catch(e => console.error('Opslaan mislukt:', e.message));
  return queue;
}

// ---------- toegang ----------
const hash = s => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const mislukt = new Map(); // ip -> { n, sinds }
const MAX_POGINGEN = 20, VENSTER_MS = 15 * 60 * 1000;

function checkAuth(req) {
  if (NO_AUTH) return 'ok';
  const ip = req.socket.remoteAddress;
  const f = mislukt.get(ip);
  if (f && Date.now() - f.sinds > VENSTER_MS) mislukt.delete(ip);
  if (f && f.n >= MAX_POGINGEN && Date.now() - f.sinds <= VENSTER_MS) return 'blocked';
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return 'missing';
  const raw = Buffer.from(h.slice(6), 'base64').toString();
  const i = raw.indexOf(':');
  const ok = i > -1 && safeEq(raw.slice(0, i), USER) & safeEq(raw.slice(i + 1), PASS);
  if (ok) { mislukt.delete(ip); return 'ok'; }
  const g = mislukt.get(ip) || { n: 0, sinds: Date.now() };
  g.n++; mislukt.set(ip, g);
  return 'wrong';
}

// ---------- http ----------
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('te groot'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const geldig = d => d && typeof d === 'object' && ['deelnemers', 'acties', 'loten'].every(k => Array.isArray(d[k]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

  const auth = checkAuth(req);
  if (auth === 'blocked') return send(res, 429, 'Te veel mislukte pogingen, probeer het later opnieuw.', 'text/plain');
  if (auth !== 'ok') return send(res, 401, 'Inloggen vereist', 'text/plain', { 'WWW-Authenticate': 'Basic realm="Loterij Tracker", charset="UTF-8"' });

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
      return send(res, 200, INDEX, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/data') {
      if (req.method === 'GET') return send(res, 200, state);
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!geldig(body.data)) return send(res, 400, { error: 'ongeldige gegevens' });
        // iemand anders (ander apparaat/tabblad) heeft intussen opgeslagen
        if (body.version !== state.version) return send(res, 409, state);
        state = { version: state.version + 1, data: body.data };
        await persist();
        return send(res, 200, { version: state.version });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    send(res, 404, 'Niet gevonden', 'text/plain');
  } catch (e) {
    send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status ? e.message : 'serverfout' });
  }
});

server.listen(PORT, () => console.log(`Loterij Tracker luistert op poort ${PORT} (gegevens in ${DATA_DIR})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => queue.then(() => process.exit(0))));
