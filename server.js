/*
 * GD Arena server — zero dependencies (Node 18+).
 *   node server.js            → http://localhost:3000
 * Serves the web app and runs a WebSocket endpoint at /ws that hosts the live discussion:
 * live transcripts in, AI turns and metrics out, with read-only "watch" viewers per room.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./shared/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SHARED = path.join(__dirname, 'shared');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/* ------------------------------------------------------------------ */
/* HTTP: static files                                                  */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() | 0 })); }
  let base = PUBLIC;
  if (p.startsWith('/shared/')) { base = SHARED; p = p.slice('/shared'.length); }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(base, p));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455) — minimal, text frames only                    */
/* ------------------------------------------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;

class WSConn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frag = null; this.alive = true; this.open = true;
    this.id = crypto.randomBytes(4).toString('hex');
    this.handlers = { message: () => {}, close: () => {} };
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_PAYLOAD) return this.close(1009);
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      this.frame(fin, op, payload);
    }
  }
  frame(fin, op, payload) {
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this.write(0xA, payload);
    if (op === 0xA) { this.alive = true; return; }
    if (op === 0x1 || op === 0x2) { this.frag = [payload]; }
    else if (op === 0x0 && this.frag) { this.frag.push(payload); }
    else return;
    if (fin) {
      const text = Buffer.concat(this.frag).toString('utf8'); this.frag = null;
      let msg; try { msg = JSON.parse(text); } catch { return; }
      this.handlers.message(msg);
    }
  }
  write(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this.closed(); }
  }
  send(obj) { this.write(0x1, Buffer.from(JSON.stringify(obj))); }
  ping() { this.write(0x9, Buffer.alloc(0)); }
  close(code) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this.write(0x8, p); this.open = false;
    try { this.socket.end(); } catch {}
    this.closed();
  }
  closed() {
    if (this.done) return; this.done = true; this.open = false;
    try { this.socket.destroy(); } catch {}
    this.handlers.close();
  }
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  onConnection(new WSConn(socket));
});

/* ------------------------------------------------------------------ */
/* Rooms: one host runs a discussion; viewers watch it live            */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const conns = new Set();

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from(crypto.randomBytes(4), b => A[b % A.length]).join(''); } while (rooms.has(c));
  return c;
}
function roomMembers(room) { return [room.host, ...room.viewers].filter(Boolean); }
function broadcast(room, ev) {
  if (ev.t !== 'live' && ev.t !== 'typing') { room.log.push(ev); if (room.log.length > 600) room.log.splice(0, room.log.length - 600); }
  roomMembers(room).forEach(c => c.send(ev));
}
function presence(room) {
  broadcast(room, { t: 'presence', viewers: room.viewers.size, hostOnline: !!room.host });
}
function dispose(room) {
  if (room.session) room.session.dispose();
  rooms.delete(room.code);
}

function onConnection(conn) {
  conns.add(conn);
  conn.on('message', msg => {
    try { handle(conn, msg); } catch (e) { console.error('handler error', e); conn.send({ t: 'error', msg: 'Server error: ' + e.message }); }
  });
  conn.on('close', () => {
    conns.delete(conn);
    const room = conn.room && rooms.get(conn.room);
    if (!room) return;
    if (room.host === conn) { room.host = null; room.hostLeftAt = Date.now(); broadcast(room, { t: 'host-left' }); }
    room.viewers.delete(conn);
    presence(room);
  });
}

function handle(conn, msg) {
  if (msg.t === 'ping') return conn.send({ t: 'pong', ts: msg.ts });

  if (msg.t === 'hello') {
    if (msg.role === 'viewer') {
      const room = rooms.get(String(msg.room || '').toUpperCase());
      if (!room) return conn.send({ t: 'error', fatal: true, msg: 'That live room does not exist or has ended. Ask for a new link.' });
      conn.room = room.code; conn.role = 'viewer'; room.viewers.add(conn);
      conn.send({ t: 'welcome', role: 'viewer', room: room.code, host: room.hostName, replay: room.log.length });
      room.log.forEach(ev => conn.send({ ...ev, replay: true }));
      conn.send({ t: 'replay-done' });
      return presence(room);
    }
    // host: resume an existing room if it has no live host, otherwise create one
    let room = msg.room && rooms.get(String(msg.room).toUpperCase());
    if (!room || (room.host && room.host !== conn)) {
      room = { code: makeCode(), host: null, viewers: new Set(), session: null, log: [], hostName: 'Host' };
      rooms.set(room.code, room);
    }
    room.host = conn; room.hostLeftAt = 0; room.hostName = (msg.name || 'Host').slice(0, 40);
    conn.room = room.code; conn.role = 'host';
    conn.send({ t: 'welcome', role: 'host', room: room.code, viewers: room.viewers.size, resumed: !!room.session });
    return presence(room);
  }

  const room = conn.room && rooms.get(conn.room);
  if (!room) return conn.send({ t: 'error', msg: 'Say hello first.' });
  if (conn.role !== 'host') return; // viewers are read-only

  if (msg.t === 'start') {
    if (room.session) room.session.dispose();
    room.log = [];
    if (msg.profile && msg.profile.name) room.hostName = String(msg.profile.name).slice(0, 40);
    room.session = new Engine.Session({
      topicId: msg.topicId, profile: msg.profile || {}, idle: msg.idle !== false,
      emit: ev => broadcast(room, ev)
    });
    broadcast(room, { t: 'reset' });
    room.session.handle({ t: 'start' });
    console.log(`[${room.code}] start "${room.session.topic.title}" (${room.viewers.size} watching)`);
    return;
  }
  if (msg.t === 'interim') {
    // stream the host's live transcript to viewers too
    if (room.session) room.session.handle(msg);
    return;
  }
  if (room.session) room.session.handle(msg);
}

/* heartbeat + cleanup */
setInterval(() => {
  conns.forEach(c => { if (!c.alive) return c.close(1001); c.alive = false; c.ping(); });
  const now = Date.now();
  rooms.forEach(r => { if (!r.host && r.viewers.size === 0 && r.hostLeftAt && now - r.hostLeftAt > 10 * 60 * 1000) dispose(r); });
}, 25000).unref();

server.listen(PORT, () => {
  console.log(`GD Arena running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
