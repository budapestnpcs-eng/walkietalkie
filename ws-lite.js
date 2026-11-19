'use strict';
// Tiny dependency-free WebSocket server for text signalling only (RFC 6455).
// Not intended as a general-purpose WebSocket implementation.
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(socket, initialData, maxPayload) {
    super(); this.socket = socket; this.readyState = WebSocket.OPEN;
    this.buffer = Buffer.alloc(0); this.maxPayload = maxPayload;
    this.fragmented = null; this.parts = []; this.partSize = 0;
    socket.on('data', bytes => this.receive(bytes));
    socket.on('error', err => this.emit('error', err));
    socket.on('close', () => { this.readyState = 3; this.emit('close'); });
    if (initialData.length) process.nextTick(() => this.receive(initialData));
  }
  frame(opcode, payload = Buffer.alloc(0)) {
    const len = payload.length;
    let h;
    if (len <= 125) { h = Buffer.from([0x80 | opcode, len]); }
    else if (len <= 65535) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([h, payload]));
  }
  send(text) { if (this.readyState === WebSocket.OPEN) this.frame(1, Buffer.from(String(text))); }
  ping() { if (this.readyState === WebSocket.OPEN) this.frame(9); }
  terminate() { this.socket.destroy(); }
  close(code = 1000, reason = '') {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = 2;
    const reasonBytes = Buffer.from(String(reason)).subarray(0, 123);
    const body = Buffer.alloc(2 + reasonBytes.length);
    body.writeUInt16BE(code); reasonBytes.copy(body, 2);
    this.frame(8, body); this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
  receive(bytes) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxPayload + 16384) return this.close(1009, 'Too large');
    while (this.buffer.length >= 2) {
      const a = this.buffer[0], b = this.buffer[1];
      const opcode = a & 15, fin = (a & 0x80) !== 0;
      if ((a & 0x70) !== 0 || (b & 0x80) === 0) return this.close(1002, 'Bad frame');
      let len = b & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.close(1009, 'Too large');
        len = Number(big); offset = 10;
      }
      if (len > this.maxPayload || this.partSize + len > this.maxPayload) return this.close(1009, 'Too large');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      this.buffer = this.buffer.subarray(offset + 4 + len);
      for (let i = 0; i < payload.length; ++i) payload[i] ^= mask[i % 4];
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { if (!fin || len > 125) return this.close(1002); this.frame(10, payload); continue; }
      if (opcode === 10) { this.emit('pong'); continue; }
      if (opcode === 1 && this.fragmented === null) {
        if (fin) this.emit('message', payload);
        else { this.fragmented = 1; this.parts = [payload]; this.partSize = len; }
      } else if (opcode === 0 && this.fragmented === 1) {
        this.parts.push(payload); this.partSize += len;
        if (fin) { this.emit('message', Buffer.concat(this.parts)); this.fragmented = null; this.parts = []; this.partSize = 0; }
      } else return this.close(1002, 'Unexpected opcode');
    }
  }
}
class WebSocketServer {
  constructor(options = {}) { this.maxPayload = options.maxPayload || 65536; }
  handleUpgrade(req, socket, head, cb) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    cb(new WebSocket(socket, head, this.maxPayload));
  }
}
module.exports = { WebSocketServer, WebSocket };
