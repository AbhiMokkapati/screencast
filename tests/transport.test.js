const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const WebSocket = require('ws');
const { createTransport } = require('../src/transport');

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open',  () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeAll(...closeables) {
  // ws clients use terminate() for immediate close; http.Server.close() takes a callback
  for (const c of closeables) {
    try {
      if (typeof c.terminate === 'function') c.terminate(); // WebSocket client
      else c.close(() => {});                                // http.Server
    } catch { /* ignore */ }
  }
  return new Promise(r => setTimeout(r, 50)); // let sockets drain
}

test('broadcast sends binary frame to a connected client', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);

  const received = new Promise((resolve) => ws.once('message', resolve));
  const frame = Buffer.from([0xFF, 0xD8, 0xAB, 0xCD, 0xFF, 0xD9]);
  broadcast(frame);

  const msg = await received;
  assert.ok(Buffer.isBuffer(msg), 'received message should be a Buffer');
  assert.deepEqual(msg, frame, 'received frame should match sent frame');

  await closeAll(ws, server);
});

test('broadcast sends to multiple clients simultaneously', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);

  const [ws1, ws2] = await Promise.all([wsConnect(port), wsConnect(port)]);
  const r1 = new Promise(r => ws1.once('message', r));
  const r2 = new Promise(r => ws2.once('message', r));

  const frame = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  broadcast(frame);

  const [m1, m2] = await Promise.all([r1, r2]);
  assert.deepEqual(m1, frame);
  assert.deepEqual(m2, frame);

  await closeAll(ws1, ws2, server);
});

test('client message is delivered to handler with a reply function', async () => {
  const server = http.createServer();
  const { onClientMessage } = createTransport(server);
  const port = await listenOnFreePort(server);

  let capturedMsg = null;
  let capturedReply = null;
  onClientMessage((msg, reply) => {
    capturedMsg   = msg;
    capturedReply = reply;
    reply(JSON.stringify({ type: 'pong' }));
  });

  const ws = await wsConnect(port);
  const response = new Promise(r => ws.once('message', r));
  ws.send(JSON.stringify({ type: 'ping' }));

  const resp = await response;
  assert.equal(capturedMsg, '{"type":"ping"}', 'handler should receive the sent message');
  assert.equal(typeof capturedReply, 'function', 'reply should be a function');
  assert.equal(resp.toString(), '{"type":"pong"}', 'reply should be received by client');

  await closeAll(ws, server);
});

test('broadcast does not throw after a client disconnects', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);

  await new Promise(r => { ws.close(); ws.once('close', r); });
  await new Promise(r => setTimeout(r, 50)); // let server process the close

  assert.doesNotThrow(() => broadcast(Buffer.from([0x00])),
    'broadcast should not throw when no clients are connected');

  await closeAll(server);
});

test('broadcast is a no-op with zero clients connected', () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  // Never listen — no clients can connect
  assert.doesNotThrow(() => broadcast(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])));
});

test('verifyClient rejects connections it does not approve', async () => {
  const server = http.createServer();
  createTransport(server, { verifyClient: ({ req }) => req.url.includes('t=ok') });
  const port = await listenOnFreePort(server);

  await assert.rejects(wsConnect(port), 'connection without token must be refused');
  const ws = await new Promise((resolve, reject) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}/?t=ok`);
    c.once('open', () => resolve(c));
    c.once('error', reject);
  });
  await closeAll(ws, server);
});
