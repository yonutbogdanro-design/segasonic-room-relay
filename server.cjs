'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const BUILD = 'SSPC20261009B';
const CODE = /^[A-Z2-7]{8}$/;
const NAME = /^[A-Za-z0-9_-]{1,24}$/;

function createRelay() {
  const rooms = new Map();
  const clients = new Set();
  const addresses = new Map();
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'segasonic-room-relay', protocol: BUILD }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('SegaSonic PC internet relay is running. Create or join a room from the game.\n');
    } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 262144) { ws.terminate(); return false; }
    ws.send(message); return true;
  }
  function error(ws, message) { send(ws, 'ERROR ' + message); }
  function remove(ws) {
    if (!clients.delete(ws)) return;
    addresses.set(ws.address, (addresses.get(ws.address) || 1) - 1);
    if (!addresses.get(ws.address)) addresses.delete(ws.address);
    const room = ws.room;
    if (!room) return;
    if (room.host === ws) {
      rooms.delete(room.code);
      for (const guest of room.guests.values()) {
        guest.room = null;
        send(guest, 'ERROR Host_closed_room'); guest.close(1000, 'Host left');
      }
      room.guests.clear();
    } else {
      room.guests.delete(ws.peer);
      send(room.host, 'LEFT ' + ws.peer);
    }
    ws.room = null;
  }
  server.on('upgrade', (req, socket, head) => {
    // Trust only the final proxy-added address. Render terminates TLS at its proxy.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    const address = forwarded || req.socket.remoteAddress;
    if (req.url !== '/relay' || clients.size >= 300 || (addresses.get(address) || 0) >= 12) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.address = address;
      addresses.set(address, (addresses.get(address) || 0) + 1);
      clients.add(ws);
      ws.alive = true; ws.budgetAt = Date.now(); ws.messages = 0; ws.bytes = 0;
      ws.deadline = Date.now() + 15000;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('close', () => remove(ws));
      ws.on('message', (buffer, binary) => {
        if (binary) { ws.close(1003, 'Text only'); return; }
        if (Date.now() - ws.budgetAt >= 1000) { ws.budgetAt = Date.now(); ws.messages = 0; ws.bytes = 0; }
        if (++ws.messages > 400 || (ws.bytes += buffer.length) > 262144) { ws.close(1008, 'Rate limit'); return; }
        const message = buffer.toString('utf8');
        if (message === 'PING') { send(ws, 'PONG'); return; }
        if (message.startsWith('SEND ')) {
          const newline = message.indexOf('\n');
          const peer = message.slice(5, newline);
          const data = message.slice(newline + 1);
          if (!ws.room || newline < 0 || !/^[0-9]{1,8}$/.test(peer) || !data.endsWith('\n') || /[^\x20-\x7e\n]/.test(data)) {
            error(ws, 'Invalid_packet'); return;
          }
          const lines = data.trimEnd().split('\n');
          if (lines.some(line => line.length > 256)) { ws.close(1008, 'Line too long'); return; }
          const host = ws.room.host === ws;
          const allowed = host ? /^(WELCOME|ERROR|SCORES|SCORE|START|STOP|NAMES|F)( |$)/ : /^(HELLO|INPUT|SCORE|GETSCORES)( |$)/;
          if (lines.some(line => !allowed.test(line))) { error(ws, 'Invalid_game_command'); return; }
          const target = host ? ws.room.guests.get(Number(peer)) : peer === '0' ? ws.room.host : null;
          if (target) send(target, 'DATA ' + (host ? 0 : ws.peer) + '\n' + data);
          return;
        }
        if (message.startsWith('DROP ') && ws.room?.host === ws) {
          const guest = ws.room.guests.get(Number(message.slice(5)));
          if (guest) guest.close(1000, 'Removed from room');
          return;
        }
        if (/^LOCK [01]$/.test(message) && ws.room?.host === ws) { ws.room.locked = message.endsWith('1'); return; }
        const parts = message.split(' ');
        if (parts[0] === 'LIST' && parts.length === 2 && parts[1] === BUILD && !ws.room) {
          ws.deadline = Date.now() + 60000;
          const list = [...rooms.values()].filter(room => room.public && !room.locked && room.guests.size < room.capacity);
          send(ws, 'ROOMS\n' + list.map(room => `${room.code} ${room.name} ${1 + room.guests.size + (room.bot ? 1 : 0)}`).join('\n'));
          return;
        }
        if (ws.room) { error(ws, 'Already_in_room'); return; }
        if (parts[1] !== BUILD) { error(ws, 'Update_game_to_the_same_version'); return; }
        if (parts[0] === 'CREATE' && parts.length === 5 && /^[01]$/.test(parts[2]) && /^[01]$/.test(parts[3]) && NAME.test(parts[4])) {
          if (rooms.size >= 100) { error(ws, 'Relay_full_try_later'); return; }
          let code;
          do { code = [...crypto.randomBytes(8)].map(n => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[n & 31]).join(''); } while (rooms.has(code));
          const bot = parts[2] === '1';
          const room = { code, host: ws, bot, capacity: bot ? 1 : 2, public: parts[3] === '1', name: parts[4], locked: false, guests: new Map(), next: 1 };
          ws.room = room; rooms.set(code, room); send(ws, 'CREATED ' + code); return;
        }
        if (parts[0] === 'JOIN' && parts.length === 4 && CODE.test(parts[2]) && NAME.test(parts[3])) {
          const room = rooms.get(parts[2]);
          if (!room) { error(ws, 'Room_not_found_check_the_code'); return; }
          if (room.locked) { error(ws, 'Match_started_wait_for_the_host'); return; }
          if (room.guests.size >= room.capacity) { error(ws, 'Room_full'); return; }
          ws.room = room; ws.peer = room.next++; room.guests.set(ws.peer, ws);
          send(room.host, 'PEER ' + ws.peer); send(ws, 'JOINED ' + room.code); return;
        }
        error(ws, 'Invalid_request');
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive || (!ws.room && Date.now() > ws.deadline)) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 10000);
  heartbeat.unref();
  async function close() {
    clearInterval(heartbeat);
    for (const ws of clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
  return { server, close };
}
module.exports = { createRelay, BUILD };
if (require.main === module) {
  const relay = createRelay();
  relay.server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('SegaSonic relay listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { relay.close().then(() => process.exit(0)); });
}

