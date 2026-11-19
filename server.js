'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('./ws-lite');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
if (PASSWORD.length < 12) {
  console.error('APP_PASSWORD must be configured with at least 12 characters. See .env.example');
  process.exit(1);
}
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();
const peers = new Map();
let floorOwner = null;
const salt = crypto.randomBytes(32);
const passwordHash = crypto.scryptSync(PASSWORD, salt, 64);

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
const publicDir = path.join(__dirname, 'public');
function headers(res, status, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extra
  });
}
function json(res, status, value, extra) { headers(res, status, undefined, extra); res.end(JSON.stringify(value)); }
function parseCookies(raw = '') {
  return Object.fromEntries(raw.split(';').map(part => {
    const i = part.indexOf('='); return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([key]) => key));
}
function getSession(req) {
  const token = parseCookies(req.headers.cookie).walkie_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const entry = sessions.get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!entry) return null;
  if (entry.until <= Date.now()) { sessions.delete(entry.key); return null; }
  return entry;
}
function setCookie(res, token, maxAge) {
  return `walkie_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function validOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host === req.headers.host;
  } catch { return false; }
}
function verifyPassword(input) {
  if (typeof input !== 'string' || input.length > 4096) return false;
  const candidate = crypto.scryptSync(input, salt, 64);
  return crypto.timingSafeEqual(candidate, passwordHash);
}
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) { const error = new Error('too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('invalid JSON'); error.status = 400; throw error; }
}
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(data, except = null) { for (const ws of peers.keys()) if (ws !== except) send(ws, data); }
function status() { broadcast({ type: 'presence', count: peers.size }); }
function dropPeer(ws, reason = 'connection-lost') {
  if (!peers.has(ws)) return;
  releaseFloor(ws);
  peers.delete(ws);
  console.info('[ws] Removed', { reason, participants: peers.size });
  broadcast({ type: 'peer-left', reason });
  status();
}
function removeStalePeers() {
  const now = Date.now();
  for (const [ws, peer] of peers) {
    if (ws.readyState !== WebSocket.OPEN || now - peer.lastPong > 30000) {
      dropPeer(ws, 'connection-lost');
      ws.terminate();
    }
  }
}
function releaseFloor(ws) {
  if (floorOwner === ws) { floorOwner = null; broadcast({ type: 'floor', owner: null }); }
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { authenticated: !!getSession(req) });
  if (pathname === '/api/room' && req.method === 'GET') {
    if (!getSession(req)) return json(res, 401, { error: 'Bejelentkezés szükséges' });
    removeStalePeers();
    return json(res, 200, { count: peers.size, capacity: 2 });
  }
  if (pathname === '/api/config' && req.method === 'GET') {
    if (!getSession(req)) return json(res, 401, { error: 'Bejelentkezés szükséges' });
    const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({ urls: process.env.TURN_URLS.split(',').map(v => v.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
    return json(res, 200, { iceServers: servers });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!validOrigin(req)) return json(res, 403, { error: 'Érvénytelen kérés eredete' });
    const key = req.socket.remoteAddress || 'unknown';
    const entry = attempts.get(key) || { count: 0, since: Date.now() };
    if (Date.now() - entry.since > 15 * 60 * 1000) { entry.count = 0; entry.since = Date.now(); }
    if (entry.count >= 10) return json(res, 429, { error: 'Túl sok próbálkozás. Próbáld később.' });
    try {
      const data = await body(req);
      if (!verifyPassword(data.password)) {
        entry.count++; attempts.set(key, entry);
        return json(res, 401, { error: 'Hibás jelszó' });
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('hex');
      const sessionKey = crypto.createHash('sha256').update(token).digest('hex');
      sessions.set(sessionKey, { key: sessionKey, until: Date.now() + SESSION_TTL });
      return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie(res, token, SESSION_TTL / 1000) });
    } catch (e) { return json(res, e.status || 400, { error: 'Érvénytelen kérés' }); }
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    if (!validOrigin(req)) return json(res, 403, { error: 'Érvénytelen kérés eredete' });
    const session = getSession(req);
    if (session) {
      sessions.delete(session.key);
      for (const [ws, peer] of peers) if (peer.sessionKey === session.key) ws.close(1008, 'Logged out');
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie(res, '', 0) });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Not allowed' });
  const routes = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
  const file = routes[pathname];
  if (!file) return json(res, 404, { error: 'Not found' });
  try {
    const content = await fs.readFile(path.join(publicDir, file));
    headers(res, 200, mime[path.extname(file)] || 'application/octet-stream');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { json(res, 500, { error: 'Unable to read asset' }); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/signal' || !validOrigin(req)) {
    console.warn('[ws] Upgrade rejected: path/origin mismatch', { host: req.headers.host, origin: req.headers.origin });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  const session = getSession(req);
  if (!session) { console.warn('[ws] Upgrade rejected: missing/expired session'); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  removeStalePeers();
  // Reconnecting the same authenticated session replaces its previous socket.
  for (const [existing, peer] of peers) {
    if (peer.sessionKey === session.key) {
      dropPeer(existing, 'reconnecting');
      existing.terminate();
    }
  }
  if (peers.size >= 2) { console.warn('[ws] Upgrade rejected: room full'); socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    if (peers.size >= 2) { ws.close(1013, 'Room full'); return; }
    const id = crypto.randomUUID();
    const hadPeer = peers.size > 0;
    peers.set(ws, { id, sessionKey: session.key, lastPong: Date.now() });
    ws.on('pong', () => { const peer = peers.get(ws); if (peer) peer.lastPong = Date.now(); });
    console.info('[ws] Connected', { participants: peers.size });
    send(ws, { type: 'welcome', id, count: peers.size, shouldOffer: hadPeer, floorOwner: floorOwner ? peers.get(floorOwner)?.id : null });
    broadcast({ type: 'peer-joined', id }, ws);
    status();
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.type !== 'string' || !peers.has(ws)) return;
      if (m.type === 'floor-request') {
        if (!floorOwner) { floorOwner = ws; broadcast({ type: 'floor', owner: id }); }
        else send(ws, { type: 'floor-denied' });
      } else if (m.type === 'floor-release') {
        releaseFloor(ws);
      } else if (['offer', 'answer', 'ice'].includes(m.type)) {
        if (m.type === 'ice' && (!m.candidate || typeof m.candidate.candidate !== 'string')) return;
        if ((m.type === 'offer' || m.type === 'answer') && (!m.sdp || typeof m.sdp.sdp !== 'string' || m.sdp.sdp.length > 48000)) return;
        broadcast({ type: m.type, sdp: m.sdp, candidate: m.candidate }, ws);
      }
    });
    ws.on('close', () => dropPeer(ws, 'connection-lost'));
    ws.on('error', () => {});
  });
});
setInterval(() => {
  removeStalePeers();
  for (const ws of peers.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 10000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.until < now) sessions.delete(k);
  for (const [k, v] of attempts) if (now - v.since > 15 * 60 * 1000) attempts.delete(k);
  for (const [ws, p] of peers) if (!sessions.has(p.sessionKey)) ws.close(1008, 'Session expired');
}, 60_000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Walkie-talkie listening on http://localhost:${PORT}`));
