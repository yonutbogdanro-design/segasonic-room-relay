const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createRelay, BUILD } = require('./server.cjs');
async function client(url) {
  const ws = new WebSocket(url); const queue = []; const waiters = [];
  ws.on('message', data => { const text = String(data); const waiter = waiters.shift(); if (waiter) waiter(text); else queue.push(text); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, send: text => ws.send(text), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), 3000);
    waiters.push(text => { clearTimeout(timer); resolve(text); });
  }) };
}
test('room codes, private directory, ordered frames, capacity, lock, isolation and disconnect', async () => {
  const relay = createRelay(); await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${relay.server.address().port}/relay`;
  try {
    const host = await client(url); host.send(`CREATE ${BUILD} 0 0 Alex`);
    const created = await host.next(); assert.match(created, /^CREATED [A-Z2-7]{8}$/); const code = created.split(' ')[1];
    const browser = await client(url); browser.send(`LIST ${BUILD}`); assert.equal(await browser.next(), 'ROOMS\n');
    const a = await client(url); a.send(`JOIN ${BUILD} ${code} Sonic`);
    assert.equal(await host.next(), 'PEER 1'); assert.equal(await a.next(), `JOINED ${code}`);
    a.send(`SEND 0\nHELLO ${BUILD} - Sonic\n`); assert.equal(await host.next(), `DATA 1\nHELLO ${BUILD} - Sonic\n`);
    host.send('SEND 1\nWELCOME 1\nSTART 0 2 0\n'); assert.equal(await a.next(), 'DATA 0\nWELCOME 1\nSTART 0 2 0\n');
    for (let i = 0; i < 100; i++) host.send(`SEND 1\nF ${i} 0 0 0 1 2 0 0 0 0\n`);
    for (let i = 0; i < 100; i++) assert.equal(await a.next(), `DATA 0\nF ${i} 0 0 0 1 2 0 0 0 0\n`);
    const b = await client(url); host.send('LOCK 1'); host.send('PING'); assert.equal(await host.next(), 'PONG');
    b.send(`JOIN ${BUILD} ${code} Ray`); assert.equal(await b.next(), 'ERROR Match_started_wait_for_the_host');
    host.send('LOCK 0'); host.send('PING'); assert.equal(await host.next(), 'PONG');
    b.send(`JOIN ${BUILD} ${code} Ray`); assert.equal(await b.next(), `JOINED ${code}`); assert.equal(await host.next(), 'PEER 2');
    browser.send(`JOIN ${BUILD} ${code} Fourth`); assert.equal(await browser.next(), 'ERROR Room_full');
    b.send('SEND 0\nF 900 0 0 0\n'); assert.equal(await b.next(), 'ERROR Invalid_game_command');
    a.ws.close(); assert.equal(await host.next(), 'LEFT 1');
    host.ws.close(); assert.equal(await b.next(), 'ERROR Host_closed_room');
    browser.send(`JOIN ${BUILD} ${code} Fourth`); assert.equal(await browser.next(), 'ERROR Room_not_found_check_the_code');
    browser.send(`CREATE ${BUILD} 1 1 PublicHost`); const pub = (await browser.next()).split(' ')[1];
    const list = await client(url); list.send(`LIST ${BUILD}`); assert.equal(await list.next(), `ROOMS\n${pub} PublicHost 2`);
    list.send(`JOIN ${BUILD} ${pub} Guest`); assert.equal(await list.next(), `JOINED ${pub}`); assert.equal(await browser.next(), 'PEER 1');
    const full = await client(url); full.send(`JOIN ${BUILD} ${pub} Extra`); assert.equal(await full.next(), 'ERROR Room_full');
    full.send('JOIN OLDVERSION AAAAAAAA Guest'); assert.equal(await full.next(), 'ERROR Update_game_to_the_same_version');
    const health = await fetch(url.replace('ws:', 'http:').replace('/relay', '/healthz')); assert.equal((await health.json()).ok, true);
  } finally { await relay.close(); }
});
