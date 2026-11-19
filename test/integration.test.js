'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const crypto = require('node:crypto');

const port = 39000 + Math.floor(Math.random() * 10000);
const base = `http://localhost:${port}`;
let child;
async function waitForServer() {
  for (let i = 0; i < 70; i++) {
    try { const r = await fetch(`${base}/api/me`); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}
function waitMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`timeout ${type}`)); }, 3000);
    const handler = msg => { if (msg.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(msg); } };
    ws.on('message', handler);
  });
}
async function login(password) {
  return fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({password}) });
}
function openSocket(cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/signal`, { headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version': '13', Cookie: cookie, Origin: base
    }});
    req.on('upgrade', (_res, socket, head) => {
      const emitter = new EventEmitter(); let buffer = Buffer.alloc(0);
      const receive = data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 2) {
          let size = buffer[1] & 127, offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          if (buffer.length < offset + size) return;
          const opcode = buffer[0] & 15;
          const packet = buffer.subarray(offset, offset + size);
          buffer = buffer.subarray(offset + size);
          if (opcode === 1) emitter.emit('message', JSON.parse(packet.toString('utf8')));
        }
      };
      socket.on('data', receive);
      emitter.send = msg => {
        const payload = Buffer.from(msg); const mask = crypto.randomBytes(4);
        const prefix = payload.length <= 125 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
        const data = Buffer.from(payload);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        socket.write(Buffer.concat([prefix, mask, data]));
      };
      emitter.close = () => socket.destroy();
      if (head.length) receive(head);
      resolve(emitter);
    });
    req.on('response', res => {res.resume(); reject(new Error(`HTTP ${res.statusCode}`));});
    req.on('error', reject);
    req.end();
  });
}
test('end-to-end authentication and 2-person room', async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, APP_PASSWORD: 'long-example-password-123', PORT: String(port) }, stdio: 'pipe' });
  try {
    await waitForServer();
    let res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Csak kettőtöknek/);
    res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 401);
    res = await login('wrong'); assert.equal(res.status, 401);
    res = await login('long-example-password-123');
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^walkie_session=/);
    res = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.equal((await res.json()).authenticated, true);
    const a = await openSocket(cookie);
    const b = await openSocket(cookie);
    const floor = waitMessage(a, 'floor');
    a.send(JSON.stringify({type:'floor-request'}));
    assert.equal((await floor).owner !== null, true);
    const denied = waitMessage(b, 'floor-denied');
    b.send(JSON.stringify({type:'floor-request'}));
    await denied;
    const released = waitMessage(b, 'floor');
    a.send(JSON.stringify({type:'floor-release'}));
    assert.equal((await released).owner, null);
    const third = await openSocket(cookie).then(ws => {ws.close();return 'accepted';}, () => 'rejected');
    assert.equal(third, 'rejected');
    a.close(); b.close();
    res = await fetch(`${base}/api/logout`, {method:'POST',headers:{Origin:base,Cookie:cookie}});
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/me`, { headers: {Cookie:cookie} });
    assert.equal((await res.json()).authenticated, false);
  } finally { child?.kill(); }
});
